import type { AppConfig } from '../config.js'
import type {
  FoundSong,
  MediaLibrary,
  MediaPlaylist,
  MediaPlaylistItem,
  MediaServerAdapter,
  MediaSong,
} from './media-server.js'

/** Emby/Jellyfin 共用（API 同源）：segment 指定读取配置段 emby | jellyfin */
export class EmbyAdapter implements MediaServerAdapter {
  readonly kind: 'emby' | 'jellyfin'

  constructor(
    private cfg: () => AppConfig,
    private segment: 'emby' | 'jellyfin' = 'emby',
  ) {
    this.kind = segment
  }

  private get c() {
    return this.cfg()[this.segment]
  }

  private async request(path: string, init?: RequestInit): Promise<any> {
    if (!this.c.baseUrl) throw new Error('未配置 Emby 地址')
    if (!this.c.apiKey) throw new Error('未配置 Emby API key')
    const url = `${this.c.baseUrl}/emby${path}`
    const res = await fetch(url, {
      ...init,
      headers: { 'X-Emby-Token': this.c.apiKey, ...(init?.headers ?? {}) },
    })
    if (res.status === 401) throw new Error('Emby 鉴权失败(401)，请检查 API key')
    if (res.status === 204) return null
    const text = await res.text()
    let data: any = null
    try { data = JSON.parse(text) } catch { data = text }
    if (!res.ok) throw new Error(`Emby 请求失败 ${res.status}: ${String(data ?? text).slice(0, 200)}`)
    return data
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.request('/System/Info')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  /** 现有播放列表（映射表"加入已有歌单"数据源） */
  /**
   * 列播放列表。scope：'shared' 只列共享歌单（/config/data/playlists/，所有账号可见）；
   * '<userId>' 列该账号可见的（含其私有老式歌单）；不传 = 服务器全部（管理员视角）。
   * ⚠️ 默认**不要**用"全部"——同名歌单可能属于别人，加进去用户在自己客户端看不到。
   */
  async listPlaylists(scope?: string): Promise<MediaPlaylist[]> {
    const map = (items: any[]) => items.map((it: any) => ({ id: String(it.Id), name: String(it.Name), itemCount: it.ChildCount }))
    if (scope && scope !== 'shared') {
      const d = await this.request(`/Users/${encodeURIComponent(scope)}/Items?IncludeItemTypes=Playlist&Recursive=true&Fields=ChildCount`)
      return map(d?.Items ?? [])
    }
    const d = await this.request('/Items?IncludeItemTypes=Playlist&Recursive=true&Fields=ChildCount,Path')
    const items: any[] = d?.Items ?? []
    if (scope === 'shared') {
      // 老式私有歌单存在 /config/data/userplaylists/ 下 —— 共享歌单一律不含这段路径
      return map(items.filter((it) => !String(it.Path ?? '').includes('/userplaylists/')))
    }
    return map(items)
  }

  /**
   * 根据 libraryRoot 探测媒体库 Id（精确扫描用）
   * ⚠️ MediaFolders API 不返回 Path；用 VirtualFolders 的 Locations 匹配
   * libraryRoot 用 Emby 视角路径（如 /D8/.../LXSERVER/king/歌单同步）
   */
  async resolveLibraryId(): Promise<string | null> {
    if (!this.c.libraryRoot) return null
    const data = await this.request('/Library/VirtualFolders')
    const root = this.c.libraryRoot.replace(/\/+$/, '')
    for (const vf of data ?? []) {
      const locs: string[] = vf?.Locations ?? []
      for (const loc of locs) {
        const p = String(loc).replace(/\/+$/, '')
        if (p === root || p.startsWith(root + '/') || root.startsWith(p + '/')) {
          return String(vf.ItemId)
        }
      }
    }
    return null
  }

  /** 列出音乐类媒体库（供界面下拉/探测辅助） */
  async listLibraries(): Promise<MediaLibrary[]> {
    const data = await this.request('/Library/VirtualFolders')
    return (data ?? [])
      .filter((vf: any) => vf?.CollectionType === 'music')
      .map((vf: any) => ({ id: String(vf.ItemId), name: String(vf.Name), locations: vf.Locations ?? [] }))
  }

  /** 精确扫描单个媒体库（Jellyfin 需 body；Emby 兼容） */
  async scanLibrary(libraryId: string): Promise<void> {
    await this.request(`/Items/${libraryId}/Refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  }

  private uidCache: string | null = null

  /** Jellyfin 需 UserId（Emby 不需要）；缓存首个用户 */
  private async jellyfinUserId(): Promise<string | undefined> {
    if (this.segment !== 'jellyfin') return undefined
    if (!this.uidCache) {
      const users = await this.request('/Users').catch(() => [])
      this.uidCache = Array.isArray(users) && users.length ? String(users[0].Id) : ''
    }
    return this.uidCache || undefined
  }

  /** Jellyfin 需 UserId + MediaType（Emby 不需要） */
  /**
   * 按完整路径精确查条目。实测：/Items?Path=<完整路径> 精确返回 1 条，
   * 而按歌名搜「此刻」会返回 55 条、目标排第 35 位（limit 10 根本取不到）。
   */
  async findItemByPath(serverPath: string): Promise<{ id: string; name: string } | null> {
    const qs = new URLSearchParams({ IncludeItemTypes: 'Audio', Recursive: 'true', Limit: '5', Fields: 'Path', Path: serverPath })
    const d = await this.request(`/Items?${qs}`)
    const it = (d?.Items ?? [])[0]
    return it ? { id: String(it.Id), name: String(it.Name) } : null
  }

  /** 服务器用户列表（"播放列表归属用户"选择器用） */
  async listUsers(): Promise<{ id: string; name: string }[]> {
    const data = await this.request('/Users')
    return (data ?? []).map((u: any) => ({ id: String(u.Id), name: String(u.Name) }))
  }

  private async playlistOwner(): Promise<{ userId?: string; mediaType?: string }> {
    if (this.segment !== 'jellyfin') return {}
    return { userId: await this.jellyfinUserId(), mediaType: 'Audio' }
  }

  async createPlaylist(name: string, itemIds?: string[]): Promise<{ id: string }> {
    const qs = new URLSearchParams({ Name: name })
    if (itemIds?.length) qs.set('Ids', itemIds.join(','))
    const owner = await this.playlistOwner()
    if (owner.userId) qs.set('UserId', owner.userId)
    if (owner.mediaType) qs.set('MediaType', owner.mediaType)
    const data = await this.request(`/Playlists?${qs}`, { method: 'POST' })
    return { id: String(data?.Id ?? data?.id) }
  }

  /** 幂等加入歌单（返回实际新增数）；Jellyfin 参数为 ids 且需 userId */
  async addItems(playlistId: string, itemIds: string[]): Promise<{ added: number }> {
    if (!itemIds.length) return { added: 0 }
    const key = this.segment === 'jellyfin' ? 'ids' : 'Ids'
    const qs = new URLSearchParams({ [key]: itemIds.join(',') })
    const uid = await this.jellyfinUserId()
    if (uid) qs.set('userId', uid)
    const data = await this.request(`/Playlists/${playlistId}/Items?${qs}`, { method: 'POST' })
    return { added: Number(data?.ItemAddedCount ?? itemIds.length) }
  }

  /** 从歌单移除（完全同步删歌用；entryIds 为歌单内条目 Id）；Jellyfin 参数 entryIds + userId */
  async removeItems(playlistId: string, entryIds: string[]): Promise<void> {
    if (!entryIds.length) return
    const key = this.segment === 'jellyfin' ? 'entryIds' : 'EntryIds'
    const qs = new URLSearchParams({ [key]: entryIds.join(',') })
    const uid = await this.jellyfinUserId()
    if (uid) qs.set('userId', uid)
    await this.request(`/Playlists/${playlistId}/Items?${qs}`, { method: 'DELETE' })
  }

  /** 搜索已入库的歌曲（幂等映射的重搜；Emby 重扫后 Id 会变） */
  async findSong(title: string, artist?: string): Promise<MediaSong | null> {
    const found = await this.findSongWithQuality(title, artist)
    return found ? { ...found, path: '', size: 0 } : null
  }

  /**
   * 查重搜索：找到库内同名歌曲并判定其音质档位
   * 判定来源：MediaSources.Container + MediaStreams(BitRate/BitsPerSample/SampleRate)
   * quality: master/atmos_plus/atmos/hires/flac24bit/flac/320k/192k/128k/null(未知)
   */
  async findSongWithQuality(title: string, artist?: string, opts?: { pathEndsWith?: string }): Promise<FoundSong | null> {
    const qs = new URLSearchParams({
      SearchTerm: title,
      IncludeItemTypes: 'Audio',
      Recursive: 'true',
      Limit: '10',
      Fields: 'MediaSources',
    })
    const data = await this.request(`/Items?${qs}`)
    const items: any[] = data?.Items ?? []
    const pathOf = (it: any) => String(it?.MediaSources?.[0]?.Path ?? '')
    const pick = (it: any) => ({ id: String(it.Id), name: String(it.Name), artists: it.Artists ?? [], quality: this.qualityOfItem(it), path: pathOf(it) })
    // 指定了"必须是我们那份文件"：只认路径匹配的条目；没匹配到就返回 null，
    // 让调用方去扫描/等待 —— 库里有同名旧副本时绝不能认错（歌单会挂到别人的文件上）
    if (opts?.pathEndsWith) {
      const mine = items.find((it) => pathOf(it).endsWith(opts.pathEndsWith!))
      return mine ? pick(mine) : null
    }
    if (artist) {
      const hit = items.find((it) => (it.Artists ?? []).some((a: string) => a === artist))
      if (hit) return pick(hit)
    }
    if (items.length) return pick(items[0])
    return null
  }

  /** 依据 MediaSources 判定条目音质档位（全库查重用） */
  private qualityOfItem(it: any): string | null {
    const ms = it.MediaSources?.[0]
    if (!ms) return null
    const container = String(ms.Container || '').toLowerCase()
    const audioStream = (ms.MediaStreams ?? []).find((s: any) => String(s.Type).toLowerCase() === 'audio')
    const bitrate = Number(ms.Bitrate || audioStream?.BitRate || 0)
    const bits = Number(audioStream?.BitsPerSample || 0)
    const sampleRate = Number(audioStream?.SampleRate || 0)
    if (container === 'flac' || container.includes('flac')) {
      if (bits >= 24) {
        if (sampleRate >= 96000) return 'hires'
        return 'flac24bit'
      }
      return 'flac'
    }
    if (container === 'mp3' || container.includes('mpeg')) {
      if (bitrate >= 320000) return '320k'
      if (bitrate >= 192000) return '192k'
      return '128k'
    }
    if (container === 'm4a' || container === 'aac' || container.includes('mp4')) {
      return bitrate >= 320000 ? '320k' : '128k'
    }
    // 其它（wav/ogg/ape 等）：视为未知格式，由调用方按规则处理
    return null
  }

  /** 歌单当前条目（含 PlaylistItemId，供 removeItems）；Jellyfin 需 userId */
  async listPlaylistItems(playlistId: string): Promise<MediaPlaylistItem[]> {
    const qs = new URLSearchParams()
    const uid = await this.jellyfinUserId()
    if (uid) qs.set('userId', uid)
    const data = await this.request(`/Playlists/${playlistId}/Items${qs.toString() ? '?' + qs : ''}`)
    return (data?.Items ?? []).map((it: any) => ({
      itemId: String(it.Id),
      entryId: it.PlaylistItemId ? String(it.PlaylistItemId) : undefined,
      name: String(it.Name),
    }))
  }

  /**
   * 分页拉取媒体库全部歌曲（含 MediaSources 音质信息）
   * 返回条目：MediaSong {id,name,artists,path,quality,size}
   */
  async listLibrarySongs(libraryId: string): Promise<MediaSong[]> {
    const out: MediaSong[] = []
    let start = 0
    const PAGE = 500
    for (;;) {
      const qs = new URLSearchParams({
        ParentId: libraryId,
        IncludeItemTypes: 'Audio',
        Recursive: 'true',
        Fields: 'MediaSources',
        Limit: String(PAGE),
        StartIndex: String(start),
      })
      const data = await this.request(`/Items?${qs}`)
      const items: any[] = data?.Items ?? []
      for (const it of items) {
        const ms = it.MediaSources?.[0]
        out.push({
          id: String(it.Id),
          name: String(it.Name ?? ''),
          artists: it.Artists ?? [],
          path: String(ms?.Path ?? it.Path ?? ''),
          quality: this.qualityOfItem(it),
          size: Number(ms?.Size || it.Size || 0),
        })
      }
      const total = Number(data?.TotalRecordCount ?? items.length)
      start += items.length
      if (start >= total || items.length === 0) break
    }
    return out
  }

  /** 取条目文件路径（回收站映射用）——Emby 需 Users/{uid}/Items/{id} */
  async getItemPath(itemId: string): Promise<string> {
    // 优先管理员自身用户上下文；拿不到用户时退化为常见用户列表第一个
    const users = await this.request('/Users?EnableHiddenFromUsers=true').catch(() => [])
    const uid = Array.isArray(users) && users.length ? String(users[0].Id) : ''
    const data = uid
      ? await this.request(`/Users/${uid}/Items/${itemId}?Fields=Path`)
      : await this.request(`/Items/${itemId}?Fields=Path`)
    return String(data?.Path ?? '')
  }

  /** 删除 Emby 条目（同时删除磁盘文件——Emby 默认行为；仅回收站彻底删除场景使用） */
  async deleteItem(itemId: string): Promise<void> {
    await this.request(`/Items/${itemId}`, { method: 'DELETE' })
  }
}
