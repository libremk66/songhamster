/**
 * 媒体服务器适配层（M5-0）
 * 目标：同步管线/查重/回收站只依赖本接口，Emby 与 Navidrome 各自实现。
 * 语义约定（各适配器负责翻译）：
 *  - playlistId / songId：各服务器自己的条目标识（Emby ItemId / Navidrome song id）
 *  - entryId：播放列表"条目"标识，删除用（Emby PlaylistItemId / Navidrome playlist_tracks 关系 id）
 *  - path：服务器视角路径（Emby 容器绝对路径 / Navidrome 相对库根路径）——本地化换算由调用方按适配器处理
 *  - quality：QUALITY_ORDER 档位字符串（master/atmos_plus/atmos/hires/flac24bit/flac/320k/192k/128k/null）
 */

export type MediaServerKind = 'emby' | 'navidrome' | 'daoliyu' | 'subsonic'

export interface MediaPlaylist {
  id: string
  name: string
  itemCount?: number
}

export interface MediaSong {
  id: string
  name: string
  artists: string[]
  path: string
  quality: string | null
  size: number
}

/** 播放列表条目（完全同步删歌用） */
export interface MediaPlaylistItem {
  /** 底层歌曲 id */
  itemId: string
  /** 播放列表条目 id（删除用）；服务器无双层结构时可为空 */
  entryId?: string
  name: string
}

export interface MediaLibrary {
  id: string
  name: string
  /** 媒体库文件夹路径（服务器视角，locations[0] 为主路径） */
  locations: string[]
}

export interface FoundSong {
  id: string
  name: string
  artists: string[]
  quality: string | null
}

export interface MediaServerAdapter {
  readonly kind: MediaServerKind

  test(): Promise<{ ok: boolean; error?: string }>

  // ===== 播放列表（同步管线） =====
  /** 现有播放列表（映射表"加入已有歌单"数据源 / 同名查重） */
  listPlaylists(): Promise<MediaPlaylist[]>
  createPlaylist(name: string, itemIds?: string[]): Promise<{ id: string }>
  /** 幂等加入歌单（songIds），返回实际新增数 */
  addItems(playlistId: string, songIds: string[]): Promise<{ added: number }>
  /** 歌单当前条目（含 entryId，供 removeItems） */
  listPlaylistItems(playlistId: string): Promise<MediaPlaylistItem[]>
  /** 从歌单移除条目（entryIds 为歌单内条目 Id） */
  removeItems(playlistId: string, entryIds: string[]): Promise<void>

  // ===== 歌曲定位 =====
  /** 搜索已入库歌曲（幂等映射重搜；入库延迟型服务器可内部轮询） */
  findSong(title: string, artist?: string): Promise<MediaSong | null>
  /** 查重搜索：同名歌曲 + 音质档位判定（dedup pre-check 用） */
  findSongWithQuality(title: string, artist?: string): Promise<FoundSong | null>

  // ===== 媒体库 / 扫描 =====
  /** 音乐类媒体库列表（界面下拉/查重范围选择） */
  listLibraries(): Promise<MediaLibrary[]>
  /** 探测本项目下载目录对应的媒体库 Id（扫描目标）；无概念时返回 null */
  resolveLibraryId(): Promise<string | null>
  /** 精确扫描单个媒体库（Navidrome 自动监听可 no-op） */
  scanLibrary(libraryId: string): Promise<void>
  /** 分页拉取媒体库全部歌曲（查重用） */
  listLibrarySongs(libraryId: string): Promise<MediaSong[]>

  // ===== 路径（回收站定位） =====
  /** 取条目服务器视角路径；不可反查时返回 '' */
  getItemPath(itemId: string): Promise<string>
}
