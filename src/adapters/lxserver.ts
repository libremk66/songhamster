import type { AppConfig, Quality } from '../config.js'

/** LX 歌曲（归一后）——songKey 为去重主键（平台_songmid/平台_id） */
export interface LxSong {
  songKey: string
  name: string
  singer: string
  source: string
  songmid: string
  albumName?: string
  picUrl?: string
  /** kg 平台必需（酷狗 API 定位歌曲用），放顶层也放 meta */
  hash?: string
  /** kg 歌单场景：不同音质对应不同 hash（meta.qualitys[].hash） */
  hashByQuality?: Partial<Record<Quality, string>>
  interval?: string
  /** 该源实际可用的音质（types/qualitys 归一，高→低去重） */
  qualities: Quality[]
}

export interface LxPlaylistInfo {
  key: string // "loveList" | "user:<id>"
  name: string
  songCount: number
}

const QUALITY_SET: Record<string, Quality> = {
  master: 'master',
  atmos_plus: 'atmos_plus',
  atmos: 'atmos',
  hires: 'hires',
  flac24bit: 'flac24bit',
  flac: 'flac',
  '320k': '320k',
  '128k': '128k',
}

/** 搜索/歌单返回的原始歌曲 → LxSong 归一（songmid 数字转字符串、qualitys/types 归一） */
function normalizeSong(raw: Record<string, any>): LxSong | null {
  const meta = raw.meta ?? {}
  const source = String(raw.source ?? '')
  if (!source) return null
  // 歌单歌曲：id 无平台前缀（kg 场景 "songmid_hash"），songmid 在 meta.songId 或顶层
  const rawId = raw.id ?? raw.songmid ?? meta.songId
  if (rawId === undefined || rawId === null || rawId === '') return null
  let sm = String(rawId)
  // 搜索返回 songmid 是数字；id 可能带 "kg_" 前缀
  if (sm.startsWith(source + '_')) sm = sm.slice(source.length + 1)
  const songKey = `${source}_${sm}`

  // 音质归一：搜索返回顶层 types/_types；歌单歌曲在 meta.qualitys（{type,size,hash}）
  const rawQs: any[] = raw.types ?? raw._types ?? meta.qualitys ?? meta._qualitys ?? []
  const qualities: Quality[] = []
  const seen = new Set<string>()
  const hashByQuality: Partial<Record<Quality, string>> = {}
  for (const t of rawQs) {
    const q = QUALITY_SET[String(t?.type ?? t)]
    if (q && !seen.has(q)) {
      seen.add(q)
      qualities.push(q)
      if (t?.hash) hashByQuality[q] = String(t.hash)
    }
  }
  // 顶层 hash（kg 搜索场景）
  const topHash = raw.hash ? String(raw.hash) : meta.hash ? String(meta.hash) : undefined

  return {
    songKey,
    name: String(raw.name ?? ''),
    singer: String(raw.singer ?? ''),
    source,
    songmid: sm,
    albumName: (raw.albumName ?? meta.albumName) ? String(raw.albumName ?? meta.albumName) : undefined,
    picUrl: (raw.img ?? meta.picUrl) ? String(raw.img ?? meta.picUrl) : undefined,
    hash: topHash,
    hashByQuality: Object.keys(hashByQuality).length ? hashByQuality : undefined,
    interval: raw.interval ? String(raw.interval) : undefined,
    qualities,
  }
}

export class LxServerAdapter {
  constructor(private cfg: () => AppConfig) {}

  private get c() {
    return this.cfg().lxserver
  }

  private headers(userName = false): Record<string, string> {
    const h: Record<string, string> = {
      'x-user-token': this.c.apiKey,
      'Content-Type': 'application/json',
    }
    if (userName) h['x-user-name'] = this.c.username
    return h
  }

  private async request(method: string, path: string, body?: unknown, userName = false): Promise<any> {
    if (!this.c.baseUrl) throw new Error('未配置 LX 地址')
    if (!this.c.apiKey) throw new Error('未配置 LX API key')
    const url = `${this.c.baseUrl}${path}`
    const res = await fetch(url, {
      method,
      headers: this.headers(userName),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let data: any = null
    try { data = JSON.parse(text) } catch { data = text }
    if (res.status === 401) throw new Error(`LX 鉴权失败(401)，请检查 API key（用户 token 只读列表，下载需有效 key）`)
    if (!res.ok) throw new Error(`LX 请求失败 ${res.status}: ${String(data ?? text).slice(0, 200)}`)
    return data
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.request('GET', '/api/user/list')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  /** 拉取歌单列表：loveList + userList（映射表行来源） */
  async listPlaylists(): Promise<LxPlaylistInfo[]> {
    const data = await this.request('GET', '/api/user/list')
    const out: LxPlaylistInfo[] = []
    if (Array.isArray(data?.loveList)) out.push({ key: 'loveList', name: '我喜欢的', songCount: data.loveList.length })
    for (const ul of data?.userList ?? []) {
      out.push({ key: `user:${ul.id}`, name: String(ul.name ?? ul.id), songCount: (ul.list ?? []).length })
    }
    return out
  }

  /** 拉取歌单内歌曲（去重主键 songKey 归一） */
  async getSongs(playlistKey: string): Promise<LxSong[]> {
    const data = await this.request('GET', '/api/user/list')
    let rawSongs: any[] = []
    if (playlistKey === 'loveList') {
      rawSongs = data?.loveList ?? []
    } else if (playlistKey.startsWith('user:')) {
      const id = playlistKey.slice(5)
      const ul = (data?.userList ?? []).find((x: any) => String(x.id) === id)
      rawSongs = ul?.list ?? []
    } else {
      throw new Error(`未知歌单 key: ${playlistKey}`)
    }
    const out: LxSong[] = []
    const seen = new Set<string>()
    for (const raw of rawSongs) {
      const song = normalizeSong(raw)
      if (song && !seen.has(song.songKey)) { seen.add(song.songKey); out.push(song) }
    }
    return out
  }

  /**
   * 跨源搜索（供跨平台找 songmid）
   * ⚠️ 参数名是 name（不是 query，query 报 400 Missing name）
   * ⚠️ 返回 songmid 是数字，normalizeSong 已转字符串
   */
  async searchSong(name: string, sources: string[]): Promise<LxSong[]> {
    const out: LxSong[] = []
    const seen = new Set<string>()
    for (const source of sources) {
      const qs = new URLSearchParams({ name, source, limit: '20' })
      const data = await this.request('GET', `/api/music/search?${qs}`)
      const list = Array.isArray(data) ? data : data?.list ?? data?.songs ?? data?.data ?? []
      for (const raw of list) {
        const song = normalizeSong(raw)
        if (song && !seen.has(song.songKey)) { seen.add(song.songKey); out.push(song) }
      }
    }
    return out
  }

  /**
   * 拿直链
   * ⚠️ songInfo 构造规则（踩坑固化）：
   *   - hash 必须放【顶层】（lxserver normalizeSongInfo 不展开 meta.hash，歌词获取器读顶层）
   *   - kg 歌单歌曲每档音质 hash 不同（hashByQuality），按 quality 取对应 hash
   *   - picUrl 必须带（封面嵌入来源）
   */
  buildSongInfo(song: LxSong, quality?: Quality): Record<string, any> {
    const hash = (quality && song.hashByQuality?.[quality]) || song.hash || ''
    return {
      id: song.songKey,
      hash, // 顶层！kg 必需（歌词+直链）
      name: song.name,
      singer: song.singer,
      source: song.source,
      interval: song.interval ?? '',
      meta: {
        songId: song.songmid,
        hash,
        albumName: song.albumName ?? '',
        picUrl: song.picUrl ?? '',
      },
    }
  }

  /** 直链解析最小间隔节流（批量下载保护）：距上次解析不足间隔则补睡 */
  private lastResolveAt = 0
  private async throttleResolve(): Promise<void> {
    const p = this.cfg().download.protection
    if (!p?.enabled || !(p.resolveIntervalSec > 0)) return
    const gap = p.resolveIntervalSec * 1000 - (Date.now() - this.lastResolveAt)
    if (gap > 0) await new Promise((r) => setTimeout(r, gap))
    this.lastResolveAt = Date.now()
  }

  async resolveUrl(song: LxSong, quality: Quality): Promise<{ url: string; sourceName?: string }> {
    await this.throttleResolve()
    const songInfo = this.buildSongInfo(song, quality)
    const data = await this.request('POST', '/api/music/url', {
      songInfo,
      quality,
      enableAutoSwitchApiSource: true,
    })
    const url = data?.url ?? data?.data
    if (!url) throw new Error(`LX 直链解析失败 [${quality}]: ${JSON.stringify(data).slice(0, 200)}`)
    return { url: String(url), sourceName: data?.sourceName }
  }

  /** 发起服务器下载（异步任务，实际由 lxserver 后台写盘） */
  async requestDownload(
    song: LxSong,
    url: string,
    quality: Quality,
    opts: { embedLyric: boolean; cacheLyric: boolean },
  ): Promise<void> {
    const songInfo = this.buildSongInfo(song, quality)
    await this.request(
      'POST',
      '/api/music/cache/download',
      {
        songInfo,
        url,
        quality,
        enableOnlyDownloadMode: true,
        embedLyric: opts.embedLyric,
        cacheLyric: opts.cacheLyric,
      },
      true,
    )
  }

  /** 文件索引（cache/list，含精确 filename/quality/size/hasCover/hasLyric） */
  async listFiles(): Promise<
    {
      songKey: string
      filename: string
      quality: string
      size: number
      mtime: number
      folder: string
      hasCover: boolean
      hasLyric: boolean
      audioContainer?: string
      bitrate?: number
      sampleRate?: number
    }[]
  > {
    const data = await this.request('GET', '/api/music/cache/list?folder=music', undefined, true)
    const list = Array.isArray(data) ? data : data?.data ?? []
    return (list as any[]).map((it) => ({
      songKey: String(it.id ?? `${it.source}_${it.songmid}`),
      filename: String(it.filename ?? ''),
      quality: String(it.quality ?? ''),
      size: Number(it.size ?? 0),
      mtime: Number(it.mtime ?? 0),
      folder: String(it.folder ?? ''),
      hasCover: Boolean(it.hasCover),
      hasLyric: Boolean(it.hasLyric),
      audioContainer: it.audioContainer ? String(it.audioContainer) : undefined,
      bitrate: it.bitrate ? Number(it.bitrate) : undefined,
      sampleRate: it.sampleRate ? Number(it.sampleRate) : undefined,
    }))
  }

  /**
   * 等待下载文件出现在索引中（精确轮询）
   * 下载是异步任务：轮询 cache/list，找 filename 以 "歌名 - 歌手" 开头且 quality 匹配的最新项
   * @returns 文件索引项
   */
  async waitForFile(
    song: LxSong,
    quality: Quality,
    timeoutMs = 60000,
    intervalMs = 2000,
  ): Promise<NonNullable<Awaited<ReturnType<LxServerAdapter['listFiles']>>>[number] | null> {
    const prefix = `${song.name} - ${song.singer}`
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const files = await this.listFiles()
      const candidates = files
        .filter((f) => f.folder === 'music' && f.filename.startsWith(prefix) && f.quality === quality && f.size > 0)
        .sort((a, b) => b.mtime - a.mtime)
      if (candidates.length > 0) {
        // 命中即返回最新的（重试场景可能已存在旧文件，同样返回）
        return candidates[0]
      }
      await new Promise((r) => setTimeout(r, intervalMs))
    }
    return null
  }
}
