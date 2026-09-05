import type { AppConfig } from '../config.js'
import type {
  FoundSong,
  MediaLibrary,
  MediaPlaylist,
  MediaPlaylistItem,
  MediaServerAdapter,
  MediaSong,
} from './media-server.js'

export class EmbyAdapter implements MediaServerAdapter {
  readonly kind = 'emby' as const

  constructor(private cfg: () => AppConfig) {}

  private get c() {
    return this.cfg().emby
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
  async listPlaylists(): Promise<MediaPlaylist[]> {
    const data = await this.request('/Items?IncludeItemTypes=Playlist&Recursive=true&Fields=ChildCount')
    return (data?.Items ?? []).map((it: any) => ({
      id: String(it.Id),
      name: String(it.Name),
      itemCount: it.ChildCount,
    }))
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

  /** 精确扫描单个媒体库 */
  async scanLibrary(libraryId: string): Promise<void> {
    await this.request(`/Items/${libraryId}/Refresh`, { method: 'POST' })
  }

  async createPlaylist(name: string, itemIds?: string[]): Promise<{ id: string }> {
    const qs = new URLSearchParams({ Name: name })
    if (itemIds?.length) qs.set('Ids', itemIds.join(','))
    const data = await this.request(`/Playlists?${qs}`, { method: 'POST' })
    return { id: String(data?.Id ?? data?.id) }
  }

  /** 幂等加入歌单（返回实际新增数） */
  async addItems(playlistId: string, itemIds: string[]): Promise<{ added: number }> {
    if (!itemIds.length) return { added: 0 }
    const qs = new URLSearchParams({ Ids: itemIds.join(',') })
    const data = await this.request(`/Playlists/${playlistId}/Items?${qs}`, { method: 'POST' })
    return { added: Number(data?.ItemAddedCount ?? itemIds.length) }
  }

  /** 从歌单移除（完全同步删歌用；entryIds 为歌单内条目 Id） */
  async removeItems(playlistId: string, entryIds: string[]): Promise<void> {
    if (!entryIds.length) return
    const qs = new URLSearchParams({ EntryIds: entryIds.join(',') })
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
  async findSongWithQuality(title: string, artist?: string): Promise<FoundSong | null> {
    const qs = new URLSearchParams({
      SearchTerm: title,
      IncludeItemTypes: 'Audio',
      Recursive: 'true',
      Limit: '10',
      Fields: 'MediaSources',
    })
    const data = await this.request(`/Items?${qs}`)
    const items: any[] = data?.Items ?? []
    const pick = (it: any) => ({ id: String(it.Id), name: String(it.Name), artists: it.Artists ?? [], quality: this.qualityOfItem(it) })
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

  /** 歌单当前条目（含 PlaylistItemId，供 removeItems） */
  async listPlaylistItems(playlistId: string): Promise<MediaPlaylistItem[]> {
    const data = await this.request(`/Playlists/${playlistId}/Items`)
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
