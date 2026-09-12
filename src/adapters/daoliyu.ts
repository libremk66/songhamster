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
 * 道理鱼（daoliyu-music vnext）适配器（实测约定，见 docs/daoliyu-adaptation.md）：
 *  - 认证：POST /api/auth/login {email|username, password} → JWT；后续 Authorization: Bearer
 *  - 目录驱动：SongHamster 落盘 歌单同步/<歌单名>/ 后，道理鱼（歌单目录=歌单同步 时）自动入库并纳入同名歌单
 *    → createPlaylist/addItems/removeItems 均为 no-op（引擎对 daoliyu 跳过播放列表段）
 *  - tracks 字段：filePath 为容器内绝对路径（/D8/...，与 downloadRoot 同源，前缀翻译即本地路径）
 *  - 音质：fileFormat/detectedContainer + bitDepth + sampleRate + bitrate(kbps，>1000 时视为 bps 自动归一)
 *  - 搜索：?search= 精确关键词；分页 take/skip（limit/offset 无效）
 *  - 扫描：scan-paths REALTIME 自动监听 → scanLibrary no-op
 *  - 删曲：对外 API 不存在 → 引擎对 daoliyu 强制增量（只增不删）
 */
export class DaoliyuAdapter implements MediaServerAdapter {
  readonly kind = 'daoliyu' as const
  private token: string | null = null

  constructor(private cfg: () => AppConfig) {}

  private get c() {
    return this.cfg().daoliyu
  }

  private async login(): Promise<string> {
    const { baseUrl, username, password } = this.c
    if (!baseUrl) throw new Error('未配置 道理鱼 地址')
    if (!username || !password) throw new Error('未配置 道理鱼 管理员账号')
    const res = await fetch(`${baseUrl}/api/auth/login`, {
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
    if (!res.ok) throw new Error(`道理鱼登录失败 ${res.status}: ${String(data?.error ?? data?.message ?? text).slice(0, 200)}`)
    const t = String(data?.token ?? '')
    if (!t) throw new Error('道理鱼登录响应缺少 token')
    return t
  }

  private async request(path: string, init?: RequestInit, retried = false): Promise<any> {
    const baseUrl = this.c.baseUrl
    if (!baseUrl) throw new Error('未配置 道理鱼 地址')
    if (!this.token) this.token = await this.login()
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
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
    if (!res.ok) throw new Error(`道理鱼请求失败 ${res.status}: ${String(data?.message ?? data?.error ?? text).slice(0, 200)}`)
    return data
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.request('/api/health')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  // ===== 播放列表（目录驱动：读可用；写 = no-op，由歌单目录自动接管） =====
  async listPlaylists(): Promise<MediaPlaylist[]> {
    const data = await this.request('/api/playlists/mine')
    return (Array.isArray(data) ? data : []).map((p: any) => ({
      id: String(p.id ?? ''),
      name: String(p.name ?? ''),
      itemCount: Number(p.trackCount ?? 0),
    }))
  }

  async createPlaylist(): Promise<{ id: string }> {
    // 目录驱动：歌单目录（一级子目录）自动生成歌单，无需 API 创建
    return { id: '' }
  }

  async addItems(): Promise<{ added: number }> {
    // 目录驱动：文件落盘后 REALTIME 自动纳入同名目录歌单
    return { added: 0 }
  }

  async listPlaylistItems(): Promise<MediaPlaylistItem[]> {
    return []
  }

  async removeItems(): Promise<void> {
    // 道理鱼对外 API 无删曲能力 → 引擎对 daoliyu 强制增量（只增不删）
    return
  }

  // ===== 歌曲 =====
  /** fileFormat/detectedContainer + bitDepth + sampleRate + bitrate(kbps) 判定音质档 */
  private qualityOf(t: any): string | null {
    const fmt = String(t?.fileFormat ?? t?.detectedContainer ?? '').toLowerCase()
    const bitDepth = Number(t?.bitDepth ?? 0)
    const sampleRate = Number(t?.sampleRate ?? 0)
    let bitrate = Number(t?.bitrate ?? 0)
    if (bitrate > 1000) bitrate = bitrate / 1000 // bps → kbps 归一
    if (fmt.includes('flac')) {
      if (bitDepth >= 24) return sampleRate >= 96000 ? 'hires' : 'flac24bit'
      return 'flac'
    }
    if (fmt.includes('mp3') || fmt.includes('mpeg')) {
      if (bitrate >= 320) return '320k'
      if (bitrate >= 192) return '192k'
      return '128k'
    }
    if (['m4a', 'aac', 'mp4'].includes(fmt)) return bitrate >= 320 ? '320k' : '128k'
    return null
  }

  private toSong(t: any): MediaSong {
    return {
      id: String(t?.id ?? ''),
      name: String(t?.title ?? ''),
      artists: t?.artistName ? [String(t.artistName)] : t?.artist?.name ? [String(t.artist.name)] : [],
      path: String(t?.filePath ?? ''),
      quality: this.qualityOf(t),
      size: Number(t?.fileSize ?? 0),
    }
  }

  private norm(x: string): string {
    return x.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  }

  /** ?search= 关键词搜索 → artist 归一精确匹配 → 退化包含 → 退化第一条 */
  private async pickSong(title: string, artist?: string): Promise<MediaSong | null> {
    const qs = new URLSearchParams({ search: title, take: '20', skip: '0' })
    const data = await this.request(`/api/tracks?${qs}`)
    const list: any[] = Array.isArray(data) ? data : data?.items ?? []
    if (!list.length) return null
    if (!artist) return this.toSong(list[0])
    const a = this.norm(artist)
    const hit =
      list.find((t) => t.artistName && this.norm(String(t.artistName)) === a) ??
      list.find((t) => t.artistName && this.norm(String(t.artistName)).includes(a)) ??
      list[0]
    return this.toSong(hit)
  }

  async findSongWithQuality(title: string, artist?: string): Promise<FoundSong | null> {
    const hit = await this.pickSong(title, artist)
    return hit ? { id: hit.id, name: hit.name, artists: hit.artists, quality: hit.quality } : null
  }

  async findSong(title: string, artist?: string): Promise<MediaSong | null> {
    return this.pickSong(title, artist)
  }

  // ===== 媒体库 =====
  async listLibraries(): Promise<MediaLibrary[]> {
    const paths = await this.request('/api/admin/scan-paths').catch(() => [])
    const root = this.c.libraryRoot
    const primary = Array.isArray(paths) ? (paths[0] as any)?.path ?? root : root
    return [{ id: 'main', name: '媒体库', locations: primary ? [String(primary)] : [] }]
  }

  /** 引擎要求非空才继续——道理鱼单根，恒返回 main */
  async resolveLibraryId(): Promise<string | null> {
    return 'main'
  }

  /**
   * 触发扫描：POST /api/admin/scan（增量）
   * REALTIME 监听对"新目录/rename 落盘"有延迟——下载完成后立即触发，保证引擎 30s
   * findSong 窗口内入库（目录歌单随扫描自动生成/纳入）
   */
  async scanLibrary(_libraryId: string): Promise<void> {
    await this.request('/api/admin/scan', { method: 'POST', body: '{}' })
  }

  /** take/skip 分页拉全库 */
  async listLibrarySongs(_libraryId: string): Promise<MediaSong[]> {
    const out: MediaSong[] = []
    const TAKE = 200
    let skip = 0
    for (;;) {
      const data = await this.request(`/api/tracks?take=${TAKE}&skip=${skip}`)
      const list: any[] = Array.isArray(data) ? data : data?.items ?? []
      for (const t of list) out.push(this.toSong(t))
      const total = Number(data?.total ?? 0)
      if (total && skip + list.length >= total) break
      if (list.length < TAKE) break
      skip += list.length
    }
    return out
  }

  /** filePath 由 listLibrarySongs 提供（容器绝对路径）；单独反查不可用 */
  async getItemPath(_itemId: string): Promise<string> {
    return ''
  }
}
