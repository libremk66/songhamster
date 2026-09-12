import { createHash } from 'node:crypto'
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
 * Subsonic 通用适配器（标准 OpenSubsonic/Subsonic API 1.16，可接任意实现——Navidrome/音云等）
 * 实测约定（Navidrome 0.63.2 /rest，见 docs）：
 *  - 认证：u + token（t=md5(password+salt) hex）+ s=随机 salt + v + c——避免明文密码进 URL/日志
 *  - 播放列表：getPlaylists / getPlaylist?id=（条目顺序即 index）/ createPlaylist?name=&songId=
 *    updatePlaylist（songIdToAdd 加曲 / songIndexToRemove 按位置删，支持重复参数）/ deletePlaylist
 *  - 歌曲定位：search3?query=title（songCount=N）
 *  - 全库列举：树遍历 getArtists → getArtist(albums) → getAlbum(songs)（Subsonic 无"全部歌曲"端点）
 *  - 扫描：startScan（需 admin；Navidrome 支持）
 *  - 协议限制：song 无 bitDepth/sampleRate/path —— 24bit 无法判定（flac 降级判 flac）、
 *    path 为空（查重可看、本地回收站定位不可用）；quality 按 suffix+bitRate(kbps)
 */
export class SubsonicAdapter implements MediaServerAdapter {
  readonly kind = 'subsonic' as const

  constructor(private cfg: () => AppConfig) {}

  private get c() {
    return this.cfg().subsonic
  }

  /** 构造带 token 认证的 query 前缀 */
  private authQs(): URLSearchParams {
    const { username, password } = this.c
    const salt = Math.random().toString(36).slice(2, 10)
    const t = createHash('md5').update(password + salt).digest('hex')
    const qs = new URLSearchParams({ u: username, t, s: salt, v: '1.16.1', c: 'SongHamster' })
    return qs
  }

  private async request(ep: string, params: Record<string, string | number> = {}): Promise<string> {
    const baseUrl = this.c.baseUrl
    if (!baseUrl) throw new Error('未配置 Subsonic 地址')
    if (!this.c.username || !this.c.password) throw new Error('未配置 Subsonic 账号')
    const qs = this.authQs()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.append(k, String(v))
    }
    const res = await fetch(`${baseUrl}/rest/${ep}?${qs}`)
    const xml = await res.text()
    if (!res.ok || !xml.includes('status="ok"')) {
      const m = xml.match(/<error[^>]*message="([^"]*)"/)
      throw new Error(`Subsonic ${ep} 失败: ${m ? m[1] : `HTTP ${res.status}`}`)
    }
    return xml
  }

  /** 简易属性提取：<tag attr="v" .../> 列表 */
  private tags(xml: string, tag: string): Record<string, string>[] {
    const out: Record<string, string>[] = []
    const re = new RegExp(`<${tag}\\b[^>]*/?>`, 'g')
    for (const m of xml.matchAll(re)) {
      const attrs: Record<string, string> = {}
      const ar = /([a-zA-Z]+)="([^"]*)"/g
      for (const a of m[0].matchAll(ar)) attrs[a[1]] = a[2]
      out.push(attrs)
    }
    return out
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.request('ping')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  // ===== 播放列表 =====
  async listPlaylists(): Promise<MediaPlaylist[]> {
    const xml = await this.request('getPlaylists')
    return this.tags(xml, 'playlist').map((p) => ({
      id: p.id ?? '',
      name: p.name ?? '',
      itemCount: p.songCount ? Number(p.songCount) : undefined,
    }))
  }

  async createPlaylist(name: string, itemIds?: string[]): Promise<{ id: string }> {
    // songId 重复参数无法经对象表达——带首曲创建（其余由调用方 addItems）
    const params: Record<string, string | number> = { name }
    if (itemIds?.length) params.songId = itemIds[0]
    const xml = await this.request('createPlaylist', params)
    const pl = this.tags(xml, 'playlist')[0]
    if (pl?.id) return { id: pl.id }
    // 部分实现创建时带歌不返回 id → 空建
    const xml2 = await this.request('createPlaylist', { name })
    const pl2 = this.tags(xml2, 'playlist')[0]
    if (!pl2?.id) throw new Error('Subsonic createPlaylist 响应缺少 playlist id')
    return { id: pl2.id }
  }

  async addItems(playlistId: string, songIds: string[]): Promise<{ added: number }> {
    // songIdToAdd 需重复参数（对象表达不了）→ 逐首调用（引擎主路径即单首）
    for (const id of songIds) {
      await this.request('updatePlaylist', { playlistId, songIdToAdd: id })
    }
    return { added: songIds.length }
  }

  /** 条目：itemId=歌曲 id；entryId=条目在列表中的序号（Subsonic 删曲按位置 index） */
  async listPlaylistItems(playlistId: string): Promise<MediaPlaylistItem[]> {
    const xml = await this.request('getPlaylist', { id: playlistId })
    return this.tags(xml, 'entry').map((e, i) => ({
      itemId: e.id ?? '',
      entryId: String(i),
      name: e.title ?? '',
    }))
  }

  /** 按位置删曲：songIndexToRemove 支持重复参数；须从大到小删避免索引漂移 */
  async removeItems(playlistId: string, entryIds: string[]): Promise<void> {
    const indexes = entryIds.map((x) => Number(x)).filter((n) => !Number.isNaN(n)).sort((a, b) => b - a)
    for (const idx of indexes) {
      await this.request('updatePlaylist', { playlistId, songIndexToRemove: idx })
    }
  }

  // ===== 歌曲 =====
  /** suffix + bitRate(kbps) 判定；协议无 bitDepth/sampleRate → 24bit/hires 无法区分 */
  private qualityOf(attrs: Record<string, string>): string | null {
    const suffix = String(attrs.suffix ?? '').toLowerCase()
    const bitrate = Number(attrs.bitRate ?? 0)
    if (suffix === 'flac') return 'flac'
    if (suffix === 'mp3') {
      if (bitrate >= 320) return '320k'
      if (bitrate >= 192) return '192k'
      return '128k'
    }
    if (['m4a', 'aac', 'mp4'].includes(suffix)) return bitrate >= 320 ? '320k' : '128k'
    return null
  }

  private toSong(a: Record<string, string>): MediaSong {
    return {
      id: a.id ?? '',
      name: a.title ?? '',
      artists: a.artist ? [a.artist] : [],
      path: '', // Subsonic 协议不暴露服务器路径
      quality: this.qualityOf(a),
      size: a.size ? Number(a.size) : 0,
    }
  }

  private norm(x: string): string {
    return x.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  }

  private async pickSong(title: string, artist?: string): Promise<MediaSong | null> {
    const xml = await this.request('search3', { query: title, songCount: 20, artistCount: 0, albumCount: 0 })
    const list = this.tags(xml, 'song').map((a) => this.toSong(a))
    if (!list.length) return null
    if (!artist) return list[0]
    const a = this.norm(artist)
    return (
      list.find((s) => s.artists[0] && this.norm(s.artists[0]) === a) ??
      list.find((s) => s.artists[0] && this.norm(s.artists[0]).includes(a)) ??
      list[0]
    )
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
  /** Subsonic 无媒体库集合概念——单根占位（无 path，查重本地定位不可用） */
  async listLibraries(): Promise<MediaLibrary[]> {
    return [{ id: 'main', name: '媒体库', locations: [] }]
  }

  async resolveLibraryId(): Promise<string | null> {
    return 'main'
  }

  /** startScan 触发增量扫描（需 admin 账号；watcher 类实现通常无需） */
  async scanLibrary(_libraryId: string): Promise<void> {
    await this.request('startScan', { fullScan: 'false' }).catch(() => undefined)
  }

  /** 全库列举：getArtists → getArtist(albums) → getAlbum(songs) */
  async listLibrarySongs(_libraryId: string): Promise<MediaSong[]> {
    const out: MediaSong[] = []
    const seen = new Set<string>()
    const artistsXml = await this.request('getArtists')
    for (const art of this.tags(artistsXml, 'artist')) {
      if (!art.id) continue
      const artistXml = await this.request('getArtist', { id: art.id })
      for (const alb of this.tags(artistXml, 'album')) {
        if (!alb.id) continue
        const albumXml = await this.request('getAlbum', { id: alb.id })
        for (const s of this.tags(albumXml, 'song')) {
          const song = this.toSong(s)
          if (song.id && !seen.has(song.id)) {
            seen.add(song.id)
            out.push(song)
          }
        }
      }
    }
    return out
  }

  /** Subsonic 不暴露路径 */
  async getItemPath(_itemId: string): Promise<string> {
    return ''
  }
}
