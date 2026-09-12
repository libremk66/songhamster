import type { AppConfig } from '../config.js'
import type {
  FoundSong,
  MediaLibrary,
  MediaPlaylist,
  MediaPlaylistItem,
  MediaServerAdapter,
  MediaSong,
} from './media-server.js'

/**
 * Navidrome 0.63 适配器（实测约定，见 docs/navidrome-adaptation.md 附录）：
 *  - 认证：POST /auth/login（账号密码）→ JWT；请求头必须 `X-ND-Authorization: Bearer <jwt>`
 *    （裸 token 放 X-ND 头、标准 Authorization: Bearer 均 401——0.63.2 实测）
 *  - 歌曲 id：22 位 base62（随机，无法由路径推导，须查询获得）
 *  - 播放列表条目 entryId：playlist_tracks 关系 id（数字递增）；删除须用它（非歌曲 id）
 *  - path：相对媒体库根（本适配器约定库根与 lxserver.downloadRoot 同源）
 *  - 过滤：`?title=` LIKE 包含匹配可用；artist/album 字段过滤无效 → title 粗查 + 本地 artist 归一
 *  - 入库：watcher + ND_SCANSCHEDULE 自动，scanLibrary 为 no-op
 */
export class NavidromeAdapter implements MediaServerAdapter {
  readonly kind = 'navidrome' as const
  private token: string | null = null
  private subsonicToken: string | null = null
  private subsonicSalt: string | null = null

  constructor(private cfg: () => AppConfig) {}

  private get c() {
    return this.cfg().navidrome
  }

  private async login(): Promise<string> {
    const { baseUrl, username, password } = this.c
    if (!baseUrl) throw new Error('未配置 Navidrome 地址')
    if (!username || !password) throw new Error('未配置 Navidrome 账号密码')
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const text = await res.text()
    let data: any = null
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
    if (!res.ok) throw new Error(`Navidrome 登录失败 ${res.status}: ${String(data?.error ?? text).slice(0, 200)}`)
    const t = String(data?.token ?? '')
    if (!t) throw new Error('Navidrome 登录响应缺少 token')
    // 缓存 Subsonic 凭证（startScan 触发扫描用；需要 admin）
    this.subsonicToken = data?.subsonicToken ? String(data.subsonicToken) : null
    this.subsonicSalt = data?.subsonicSalt ? String(data.subsonicSalt) : null
    return t
  }

  private async request(path: string, init?: RequestInit, retried = false): Promise<any> {
    const baseUrl = this.c.baseUrl
    if (!baseUrl) throw new Error('未配置 Navidrome 地址')
    if (!this.token) this.token = await this.login()
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'X-ND-Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
    // token 过期（24h）→ 重登一次
    if (res.status === 401 && !retried) {
      this.token = null
      return this.request(path, init, true)
    }
    const text = await res.text()
    let data: any = null
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
    if (!res.ok) throw new Error(`Navidrome 请求失败 ${res.status}: ${String(data?.error ?? text).slice(0, 200)}`)
    return data
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.request('/api/playlist')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  // ===== 播放列表 =====
  async listPlaylists(): Promise<MediaPlaylist[]> {
    const data = await this.request('/api/playlist')
    return (Array.isArray(data) ? data : []).map((p: any) => ({
      id: String(p.id ?? ''),
      name: String(p.name ?? ''),
    }))
  }

  async createPlaylist(name: string): Promise<{ id: string }> {
    const data = await this.request('/api/playlist', {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
    const id = String(data?.id ?? '')
    if (!id) throw new Error('Navidrome 建播放列表失败：响应缺少 id')
    return { id }
  }

  async addItems(playlistId: string, songIds: string[]): Promise<{ added: number }> {
    if (!songIds.length) return { added: 0 }
    const data = await this.request(`/api/playlist/${playlistId}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ ids: songIds }),
    })
    return { added: Number(data?.added ?? songIds.length) }
  }

  /** 歌单条目：entryId = playlist_tracks 关系 id（数字）；itemId = 歌曲 id */
  async listPlaylistItems(playlistId: string): Promise<MediaPlaylistItem[]> {
    const data = await this.request(`/api/playlist/${playlistId}/tracks`)
    return (Array.isArray(data) ? data : []).map((t: any) => ({
      itemId: String(t.mediaFileId ?? t.id ?? ''),
      entryId: t.id != null ? String(t.id) : undefined,
      name: String(t.title ?? ''),
    }))
  }

  /** 删除歌单条目：按关系 id（?id= query 参数；实测逗号串不拆分 → 逐个删） */
  async removeItems(playlistId: string, entryIds: string[]): Promise<void> {
    for (const id of entryIds) {
      await this.request(`/api/playlist/${playlistId}/tracks?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    }
  }

  // ===== 歌曲 =====
  /** song.bitRate 单位 kbps（实测 flac≈963）；sampleRate Hz；bitDepth 位数 */
  private qualityOf(s: any): string | null {
    const suffix = String(s?.suffix ?? '').toLowerCase()
    const bitrate = Number(s?.bitRate ?? 0)
    const bits = Number(s?.bitDepth ?? 0)
    const sampleRate = Number(s?.sampleRate ?? 0)
    if (suffix === 'flac') {
      if (bits >= 24) return sampleRate >= 96000 ? 'hires' : 'flac24bit'
      return 'flac'
    }
    if (suffix === 'mp3') {
      if (bitrate >= 320) return '320k'
      if (bitrate >= 192) return '192k'
      return '128k'
    }
    if (['m4a', 'aac', 'mp4'].includes(suffix)) return bitrate >= 320 ? '320k' : '128k'
    return null
  }

  private toSong(s: any): MediaSong {
    return {
      id: String(s?.id ?? ''),
      name: String(s?.title ?? ''),
      artists: s?.artist ? [String(s.artist)] : [],
      path: String(s?.path ?? ''),
      quality: this.qualityOf(s),
      size: Number(s?.size ?? 0),
    }
  }

  private norm(x: string): string {
    return x.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  }

  /** title LIKE 粗查 → artist 归一精确匹配（退化包含匹配）→ 退化第一条 */
  private async pickSong(title: string, artist?: string): Promise<MediaSong | null> {
    const data = await this.request(`/api/song?${new URLSearchParams({ title })}`)
    const list: any[] = Array.isArray(data) ? data : []
    if (!list.length) return null
    if (!artist) return this.toSong(list[0])
    const a = this.norm(artist)
    const hit =
      list.find((s) => s.artist && this.norm(String(s.artist)) === a) ??
      list.find((s) => s.artist && this.norm(String(s.artist)).includes(a)) ??
      list[0]
    return this.toSong(hit)
  }

  async findSongWithQuality(title: string, artist?: string, _opts?: { pathEndsWith?: string }): Promise<FoundSong | null> {
    // 路径匹配暂未实现（接口约定见 media-server.ts）：忽略 _opts，行为与之前一致
    const hit = await this.pickSong(title, artist)
    return hit ? { id: hit.id, name: hit.name, artists: hit.artists, quality: hit.quality } : null
  }

  async findSong(title: string, artist?: string): Promise<MediaSong | null> {
    return this.pickSong(title, artist)
  }

  // ===== 媒体库 =====
  async listLibraries(): Promise<MediaLibrary[]> {
    const data = await this.request('/api/library')
    return (Array.isArray(data) ? data : []).map((l: any) => ({
      id: String(l.id ?? ''),
      name: String(l.name ?? ''),
      locations: l.path ? [String(l.path)] : [],
    }))
  }

  /** 返回"与 libraryRoot 匹配的库"，未配置/未命中时返回第一个库（引擎要求非空才继续） */
  async resolveLibraryId(): Promise<string | null> {
    if (this.c.libraryId) return String(this.c.libraryId)
    const libs = await this.listLibraries()
    if (!libs.length) return null
    const root = this.c.libraryRoot?.replace(/\/+$/, '')
    if (root) {
      const hit = libs.find((l) =>
        l.locations.some((p) => {
          const x = p.replace(/\/+$/, '')
          return x === root || x.startsWith(root + '/') || root.startsWith(x + '/')
        }),
      )
      if (hit) return hit.id
    }
    return libs[0].id
  }

  /**
   * 触发扫描：Subsonic startScan（quick-selective 增量）
   * ⚠️ 必要性：NTFS/网络挂载目录无 inotify 事件，Navidrome watcher 不触发，
   *    只能靠 ND_SCANSCHEDULE（默认 1m）被动扫描——引擎的入库等待窗口（6×5s）会错过。
   *    startScan 强制立即扫描，让下载完成的文件在窗口内入库。
   * 需要 admin 账号（Subsonic 凭证从登录响应缓存）。
   */
  async scanLibrary(_libraryId: string): Promise<void> {
    if (!this.subsonicToken || !this.subsonicSalt) {
      // 凭证未缓存（老 token 场景）→ 重新登录一次
      this.token = null
      await this.ensureToken()
    }
    const qs = new URLSearchParams({
      u: this.c.username,
      t: this.subsonicToken ?? '',
      s: this.subsonicSalt ?? '',
      v: '1.16.1',
      c: 'SongHamster',
      fullScan: 'false',
    })
    const res = await fetch(`${this.c.baseUrl}/rest/startScan?${qs}`)
    if (!res.ok) {
      throw new Error(`Navidrome startScan 失败 ${res.status}`)
    }
    // 返回 <subsonic-response status="ok" ...><scanStatus scanning="true" ...>
  }

  private async ensureToken(): Promise<void> {
    if (!this.token) this.token = await this.login()
  }

  /** 分页拉取全库歌曲（path 为相对库根路径） */
  async listLibrarySongs(_libraryId: string): Promise<MediaSong[]> {
    const out: MediaSong[] = []
    let start = 0
    const PAGE = 200
    for (;;) {
      const data = await this.request(`/api/song?_start=${start}&_end=${start + PAGE}`)
      const list: any[] = Array.isArray(data) ? data : []
      for (const s of list) out.push(this.toSong(s))
      if (list.length < PAGE) break
      start += PAGE
    }
    return out
  }

  /** Navidrome 不暴露服务器绝对路径；回收站定位走本地快照（downloadRoot + 相对 path） */
  async getItemPath(_itemId: string): Promise<string> {
    return ''
  }
}
