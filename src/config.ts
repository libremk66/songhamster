import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { NotifyConfig } from './core/notify.js'
import { NOTIFY_EVENTS } from './core/notify-events.js'
import YAML from 'yaml'
import Database from 'better-sqlite3'

/** 音质顺序（高→低尝试），界面复选框顺序即此 */
export const QUALITY_ORDER = ['master', 'atmos_plus', 'atmos', 'hires', 'flac24bit', 'flac', '320k', '192k', '128k'] as const
export type Quality = (typeof QUALITY_ORDER)[number]

/** 媒体服务器显示名 */
export const TARGET_LABEL: Record<'emby' | 'navidrome' | 'daoliyu' | 'subsonic' | 'jellyfin', string> = {
  emby: 'Emby',
  navidrome: 'Navidrome',
  daoliyu: '道理鱼',
  subsonic: 'Subsonic',
  jellyfin: 'Jellyfin',
}

/** 音质显示名（界面复选框标签） */
export const QUALITY_LABELS: Record<Quality, string> = {
  master: '臻品母带',
  atmos_plus: '臻品音质·Atmos Plus',
  atmos: '沉浸声·Atmos',
  hires: 'Hi-Res 无损',
  flac24bit: 'FLAC 24-Bit',
  flac: '无损·FLAC',
  '320k': '高品质·320K',
  '192k': '192K',
  '128k': '标准·128K',
}

/** FLAC 容器内的高规格档（需要按真实位深/采样率校验降档） */
export const HIGH_RES_FLAC: Quality[] = ['master', 'hires', 'flac24bit']

/** 自动新增同步任务：基线日期后出现的 LX 歌单自动建任务并同步 */
export interface AutoAddConfig {
  enabled: boolean
  /** 界面展示的启用日期（语义确认用） */
  baselineDate: string
  /** 检测计划 cron（空 = 仅手动"立即检测"） */
  checkCron: string
  /** 基线快照：保存设置时已存在的歌单 key（永不会自动纳入） */
  baselineKeys: string[]
  /** 忽略列表：被删除过/手动忽略的歌单 key（不自动纳入） */
  ignoredKeys: string[]
  /** 自动创建任务的默认目标 */
  createSameNamePlaylist: boolean
  embyTargetPlaylistIds: string[]
  /** 自动创建任务的同步方式 */
  syncMode: 'incremental' | 'full'
  /** 自动创建任务的独立 cron（空 = 仅手动，但创建后立即同步一次） */
  taskCron: string
  /** 自动创建任务的默认查重设置 */
  dedupCheck: boolean
  dedupMinQuality: string | null
}

// ===== 歌单同步重设计(见 docs/sync-redesign-spec.md)=====

/** 镜像删除处理策略 */
export type DelPolicy = 'keep' | 'delete' | 'archive'
/** 同步方式:incremental=增量(只增) | mirror=镜像(增删同步;旧 full 等价 mirror+keep) */
export type TaskMode = 'incremental' | 'mirror'

/** 监听模式默认参数(新自动任务继承) */
export interface ListenParams {
  createSameNamePlaylist: boolean
  embyTargetPlaylistIds: string[]
  taskMode: TaskMode
  delPolicy: DelPolicy
  archivePlaylist: string
  taskCron: string
  dedupCheck: boolean
  dedupMinQuality: string | null
}
export interface ListenRulesSet {
  enabled: boolean
  /** 命中的现有歌单(key 或名称,按任务名匹配) */
  playlists: string[]
  /** 歌单名关键词(逗号分隔存数组) */
  keywords: string[]
}
export interface ListenRules {
  exclude: ListenRulesSet
  match: ListenRulesSet
}
export interface FilteredListen {
  rules: ListenRules
  params: ListenParams
}
/** 监听同步(单监听器 + 模式互斥:all=完全 | filtered=条件增量) */
export interface ListenConfig {
  enabled: boolean
  activeMode: 'all' | 'filtered'
  /** 完全模式:是否纳入"启用前已存在"的歌单(勾=忽略基线,现有+今后全部纳入) */
  includeExisting: boolean
  checkCron: string
  baselineDate: string
  baselineKeys: string[]
  ignoredKeys: string[]
  all: ListenParams
  filtered: FilteredListen
}

export const DEFAULT_ARCHIVE_PLAYLIST = '歌单同步任务归档'
/** 榜单订阅的归档默认名（榜单不是"歌单"，别混进歌单归档） */
export const DEFAULT_CHART_ARCHIVE_PLAYLIST = '榜单订阅归档'

/** 归档歌单名里的"来源名"占位符："按来源归档" = 存 `[歌单名]归档` / 榜单任务存 `[榜单名]归档` */
export const ARCHIVE_NAME_PLACEHOLDER = '[歌单名]'
export const ARCHIVE_NAME_PLACEHOLDER_CHART = '[榜单名]'
const ARCHIVE_PLACEHOLDERS = [ARCHIVE_NAME_PLACEHOLDER, ARCHIVE_NAME_PLACEHOLDER_CHART]

/** 是否"按来源"模板（模板名要等任务建好才知道 → 配置期不为它建歌单） */
export function isArchiveTemplate(name: string): boolean {
  return ARCHIVE_PLACEHOLDERS.some((p) => name.includes(p))
}

/**
 * 归档歌单名解析：含 [歌单名]/[榜单名] 占位符则替换为来源歌单（榜单）名。
 * 归档目标是"一个名字字段"而不是三种模式——统一/按来源/自选已有歌单都只是它的取值。
 */
export function resolveArchiveName(
  archivePlaylist: string | null | undefined,
  playlistName: string,
  fallback: string = DEFAULT_ARCHIVE_PLAYLIST,
): string {
  const raw = String(archivePlaylist ?? '').trim() || fallback
  return ARCHIVE_PLACEHOLDERS.reduce((s, ph) => (s.includes(ph) ? s.split(ph).join(playlistName) : s), raw)
}

/** 任务的归档歌单名（榜单用它自己的默认名） */
export function archiveNameOf(t: {
  taskType?: string | null
  archivePlaylist?: string | null
  lxPlaylistName: string
}): string {
  return resolveArchiveName(
    t.archivePlaylist,
    t.lxPlaylistName,
    t.taskType === 'chart' ? DEFAULT_CHART_ARCHIVE_PLAYLIST : DEFAULT_ARCHIVE_PLAYLIST,
  )
}

/** 支持"镜像删除处理2(物理删文件)"的目标服务器;其余(道理鱼/Subsonic)置灰 */
export function supportsFileDelete(target: AppConfig['target']): boolean {
  return target === 'emby' || target === 'navidrome' || target === 'jellyfin'
}

function baseListenParams(): ListenParams {
  return {
    createSameNamePlaylist: true,
    embyTargetPlaylistIds: [],
    taskMode: 'incremental',
    delPolicy: 'keep',
    archivePlaylist: DEFAULT_ARCHIVE_PLAYLIST,
    taskCron: '',
    dedupCheck: false,
    dedupMinQuality: null,
  }
}

export function defaultListen(): ListenConfig {
  return {
    enabled: false,
    activeMode: 'all',
    includeExisting: false,
    checkCron: '0 7 * * *',
    baselineDate: '',
    baselineKeys: [],
    ignoredKeys: [],
    all: baseListenParams(),
    filtered: {
      rules: {
        exclude: { enabled: false, playlists: [], keywords: [] },
        match: { enabled: false, playlists: [], keywords: [] },
      },
      params: baseListenParams(),
    },
  }
}

/** 旧 autoadd → listen.all(旧 full = mirror+keep);listen 未显式配置时用此推导,保证升级无行为漂移 */
export function deriveListenFromAutoadd(a: AutoAddConfig): ListenConfig {
  const mk = (src: AutoAddConfig): ListenParams => ({
    createSameNamePlaylist: src.createSameNamePlaylist,
    embyTargetPlaylistIds: [...src.embyTargetPlaylistIds],
    taskMode: src.syncMode === 'full' ? 'mirror' : 'incremental',
    delPolicy: 'keep',
    archivePlaylist: DEFAULT_ARCHIVE_PLAYLIST,
    taskCron: src.taskCron,
    dedupCheck: src.dedupCheck,
    dedupMinQuality: src.dedupMinQuality,
  })
  const L = defaultListen()
  L.enabled = a.enabled
  L.checkCron = a.checkCron
  L.baselineDate = a.baselineDate
  L.baselineKeys = [...a.baselineKeys]
  L.ignoredKeys = [...a.ignoredKeys]
  L.all = mk(a)
  return L
}

/** 深合并 listen 各层(defaults ← file) */
export function mergeListen(file?: Partial<ListenConfig>): ListenConfig {
  const L = defaultListen()
  if (!file) return L
  const p = (src?: Partial<ListenParams>): ListenParams => ({ ...baseListenParams(), ...src })
  const rs = (src?: Partial<ListenRulesSet>): ListenRulesSet => ({ enabled: false, playlists: [], keywords: [], ...src })
  return {
    ...L,
    ...file,
    includeExisting: file.includeExisting ?? L.includeExisting,
    baselineKeys: file.baselineKeys ?? L.baselineKeys,
    ignoredKeys: file.ignoredKeys ?? L.ignoredKeys,
    all: p(file.all),
    filtered: {
      rules: {
        exclude: rs(file.filtered?.rules?.exclude),
        match: rs(file.filtered?.rules?.match),
      },
      params: p(file.filtered?.params),
    },
  }
}

/** 批量下载保护（仿 Songloft）：串行 + 间隔，防音源限流封禁 */
export interface DownloadProtection {
  /** 开关（推荐开启） */
  enabled: boolean
  /** 每首歌成功或失败后的等待间隔（秒，2~60，默认 5） */
  downloadIntervalSec: number
  /** 直链解析的最小间隔（秒，1~30，默认 2）——错开连续解析请求 */
  resolveIntervalSec: number
}

/** Emby/Jellyfin 共享连接段（同构 API） */
export interface EmbyServerCfg {
  baseUrl: string
  apiKey: string
  /** 媒体库根路径（服务器容器视角，用于探测库；如 /D8/.../LXSERVER/king/歌单同步） */
  libraryRoot: string
  /** 媒体库 Id（连接后自动探测填入） */
  mediaLibraryId?: string
}

export interface AppConfig {
  lxserver: {
    baseUrl: string
    apiKey: string
    /** lxserver 下载需要 x-user-name（容器内用户目录标识） */
    username: string
    /** 下载落盘根目录（宿主机路径，如 .../LXSERVER/king）——Emby 库扫描此目录的子目录 */
    downloadRoot: string
  }
  emby: EmbyServerCfg
  jellyfin: EmbyServerCfg
  navidrome: {
    baseUrl: string
    username: string
    password: string
    /** 媒体库根路径（Navidrome 视角，用于匹配库；如 /D8/.../LXSERVER/king） */
    libraryRoot: string
    /** 媒体库 Id（连接后自动探测填入） */
    libraryId?: string
  }
  daoliyu: {
    baseUrl: string
    /** 管理员邮箱（登录用） */
    username: string
    password: string
    /** 媒体库根路径（Daoliyu 容器视角，与 downloadRoot 同源；如 /D8/.../LXSERVER/king） */
    libraryRoot: string
  }
  subsonic: {
    baseUrl: string
    username: string
    password: string
  }
  /** 媒体服务器目标：emby | navidrome | daoliyu | subsonic */
  target: 'emby' | 'navidrome' | 'daoliyu' | 'subsonic' | 'jellyfin'
  download: {
    /** 勾选的音质，按高→低尝试；未勾选绝不使用 */
    qualities: Quality[]
    /** 命名模板：自由文本 + [歌手][专辑名][歌曲名][音质] 占位符 */
    filenameTemplate: string
    /** 内嵌歌词（LYRICS 标签） */
    embedLyric: boolean
    /** 外置歌词（.lrc 文件） */
    cacheLyric: boolean
    /** 批量下载保护：控制请求节奏，降低音源限流/封禁风险 */
    protection: DownloadProtection
    // 这里没有"标签/封面/并发/重试"开关，是有意的：
    //   · 标题/歌手/专辑标签与封面 —— 由 LX 服务端在下载时**始终写入**（请求里带着 songInfo 的专辑和封面地址），
    //     没有对应参数可关，做开关只会是骗人的摆设；
    //   · 并发 —— 下载始终逐首串行（这正是"批量下载保护"能生效的前提）；
    //   · 重试 —— 失败不自动重试：失败/未满足的歌下次同步会自动再试，也可在历史记录页对单曲点「重试」。
    // 历史：writeId3 / writeCover / concurrency / retries 四个字段曾存在但**从未被任何代码读取**，
    //       2026-09 从界面与配置中移除（老配置文件里的残留键由 loadConfig 清理）。
  }
  general: {
    /** 自动纳入 LX 新建的歌单（旧字段，保留兼容；实际由 autoadd 接管） */
    autoIncludeNewPlaylists: boolean
    /** 完全同步时清理无引用孤立文件（默认关） */
    cleanupOrphanFiles: boolean
    /** 暂停所有同步 */
    pauseAll: boolean
    logRetentionDays: number
    /** 自动新增同步任务(旧模型,Phase C 后由 listen 取代;兼容保留) */
    autoadd: AutoAddConfig
    /** 监听同步(单监听器+模式互斥)——歌单同步重设计新模型 */
    listen: ListenConfig
    /** 项目主页（侧栏"帮助"链接） */
    githubUrl: string
  }
  /** 通知配置：渠道 + 每个渠道订阅哪些事件（详见 core/notify.ts） */
  notify: NotifyConfig & {
    /** @deprecated 老字段（v0.4 及以前只有单飞书 webhook）——加载时自动接管进 channels.feishu */
    feishuWebhook?: string
  }
  server: {
    port: number
  }
  auth: {
    /** 账号认证开关 */
    enabled: boolean
    /** 登录用户名 */
    username: string
    /** 密码哈希（scrypt, 格式 salt:hash）——不存明文 */
    passwordHash: string
  }
  upgrade: UpgradeConfig
  advanced: AdvancedConfig
}

/** 高级设置（默认关闭，谨慎开启） */
export interface AdvancedConfig {
  /** 全局：同步前查重（Emby 已有达标歌曲则跳过 LX 下载，仅入歌单） */
  dedupCheck: boolean
  /** 查重音质门槛：空=不检查音质（任意存在即跳过） */
  dedupMinQuality: string | null
}

/** 洗版（曲库升级）规则 */
export interface UpgradeConfig {
  /** 低于此码率（kbps）则洗版：128/192/256/320/500 */
  thresholdKbps: number
  /** 新版最低音质（勾选链中目标起点） */
  minQuality: Quality
  /** 最大时长误差（秒，默认 3） */
  maxDurDiffSec: number
  /** 扫描目录（用户选择） */
  scanDir: string
  /** 新版保存目录（默认 <downloadRoot>/曲库洗版） */
  outputDir: string
}

/** 通知默认订阅哪些事件（用户可在界面改） */
function defaultNotifyEvents(): NotifyConfig['channels']['feishu']['events'] {
  return NOTIFY_EVENTS.filter((e) => e.defaultOn).map((e) => e.key)
}

export const DEFAULT_CONFIG: AppConfig = {
  lxserver: { baseUrl: 'http://127.0.0.1:19527', apiKey: '', username: 'king', downloadRoot: '' },
  emby: { baseUrl: 'http://127.0.0.1:8096', apiKey: '', libraryRoot: '' },
  navidrome: { baseUrl: '', username: '', password: '', libraryRoot: '' },
  daoliyu: { baseUrl: '', username: '', password: '', libraryRoot: '' },
  subsonic: { baseUrl: '', username: '', password: '' },
  jellyfin: { baseUrl: '', apiKey: '', libraryRoot: '' },
  target: 'emby',
  download: {
    qualities: ['flac24bit', 'flac'],
    filenameTemplate: '[歌手] - [歌曲名] ([音质])',
    embedLyric: true,
    cacheLyric: false,
    protection: { enabled: true, downloadIntervalSec: 5, resolveIntervalSec: 2 },
  },
  general: {
    autoIncludeNewPlaylists: false,
    cleanupOrphanFiles: false,
    pauseAll: false,
    logRetentionDays: 30,
    autoadd: {
      enabled: false,
      baselineDate: '',
      checkCron: '0 6 * * *',
      baselineKeys: [],
      ignoredKeys: [],
      createSameNamePlaylist: true,
      embyTargetPlaylistIds: [],
      syncMode: 'incremental',
      taskCron: '',
      dedupCheck: false,
      dedupMinQuality: null,
    },
    listen: defaultListen(),
    githubUrl: '',
  },
  notify: {
    enabled: false,
    channels: {
      feishu: { enabled: false, events: defaultNotifyEvents(), webhook: '', secret: '' },
      wecom: { enabled: false, events: defaultNotifyEvents(), webhook: '' },
      dingtalk: { enabled: false, events: defaultNotifyEvents(), webhook: '', secret: '' },
      bark: { enabled: false, events: defaultNotifyEvents(), server: 'https://api.day.app', key: '' },
      serverchan: { enabled: false, events: defaultNotifyEvents(), sendKey: '' },
      telegram: { enabled: false, events: defaultNotifyEvents(), token: '', chatId: '', apiBase: 'https://api.telegram.org' },
      webhook: { enabled: false, events: defaultNotifyEvents(), url: '', method: 'POST', headers: '', bodyTemplate: '' },
    },
  },
  server: { port: Number(process.env.PORT || 8935) },
  auth: { enabled: false, username: '', passwordHash: '' },
  upgrade: {
    thresholdKbps: 320,
    minQuality: 'flac',
    maxDurDiffSec: 3,
    scanDir: '',
    outputDir: '',
  },
  advanced: { dedupCheck: false, dedupMinQuality: null },
}

/**
 * 读取环境变量，兼容改名前的旧前缀。
 * v0.4.0 起项目由 SongFerry 更名 SongHamster：老部署的 `SONGFERRY_*` 一律继续生效
 * （新名优先），否则升级镜像后配置会静默回落默认值、连不上 lxserver/媒体服务器。
 */
function envCompat(name: string): string | undefined {
  return process.env[`SONGHAMSTER_${name}`] ?? process.env[`SONGFERRY_${name}`]
}

export const DATA_DIR = envCompat('DATA_DIR') || path.join(process.cwd(), 'data')
export const CONFIG_PATH = envCompat('CONFIG') || path.join(DATA_DIR, 'config.yaml')
/**
 * 数据库路径（改名兼容）：显式 env > 有数据的新库 > 老库 > 新库。
 *
 * ⚠️ 判据是"新库里有没有任务"，不是"新库文件在不在"：
 * 老版本升级上来时，程序一启动就会创建空的 songhamster.db（SQLite 打开即建文件），
 * 只看文件存在就会选到空库、让用户以为数据全丢了。
 */
export const DB_PATH = (() => {
  const explicit = envCompat('DB')
  if (explicit) return explicit
  const fresh = path.join(DATA_DIR, 'songhamster.db')
  const legacy = path.join(DATA_DIR, 'songferry.db')
  if (existsSync(fresh) && dbHasTasks(fresh)) return fresh
  if (existsSync(legacy)) return legacy
  return fresh
})()

/** 库里有没有任务（打不开/无表 → 视为空库）；只读打开，不改动任何东西 */
function dbHasTasks(file: string): boolean {
  try {
    const d = new Database(file, { readonly: true, fileMustExist: true })
    const n = (d.prepare('SELECT COUNT(*) AS n FROM sync_task').get() as { n: number }).n
    d.close()
    return n > 0
  } catch {
    return false
  }
}

/** 环境变量覆盖（docker secrets 注入用）：SONGHAMSTER_LXSERVER_URL / _KEY 等（老前缀 SONGFERRY_ 兼容） */
function applyEnvOverrides(cfg: AppConfig): AppConfig {
  const map: Record<string, (v: string) => void> = {
    LXSERVER_URL: (v) => (cfg.lxserver.baseUrl = v),
    LXSERVER_KEY: (v) => (cfg.lxserver.apiKey = v),
    LXSERVER_USER: (v) => (cfg.lxserver.username = v),
    EMBY_URL: (v) => (cfg.emby.baseUrl = v),
    EMBY_KEY: (v) => (cfg.emby.apiKey = v),
    PORT: (v) => (cfg.server.port = Number(v)),
  }
  for (const [name, apply] of Object.entries(map)) {
    const v = envCompat(name)
    if (v) apply(v)
  }
  return cfg
}

export function loadConfig(): AppConfig {
  mkdirSync(DATA_DIR, { recursive: true })
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, YAML.stringify(DEFAULT_CONFIG), 'utf8')
  }
  const raw = readFileSync(CONFIG_PATH, 'utf8')
  const fileCfg = YAML.parse(raw) as Partial<AppConfig>
  const merged: AppConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    ...fileCfg,
    lxserver: { ...DEFAULT_CONFIG.lxserver, ...fileCfg?.lxserver },
    emby: { ...DEFAULT_CONFIG.emby, ...fileCfg?.emby },
    navidrome: { ...DEFAULT_CONFIG.navidrome, ...fileCfg?.navidrome },
    daoliyu: { ...DEFAULT_CONFIG.daoliyu, ...fileCfg?.daoliyu },
    subsonic: { ...DEFAULT_CONFIG.subsonic, ...fileCfg?.subsonic },
    jellyfin: { ...DEFAULT_CONFIG.jellyfin, ...fileCfg?.jellyfin },
    download: {
      ...DEFAULT_CONFIG.download,
      ...fileCfg?.download,
      protection: { ...DEFAULT_CONFIG.download.protection, ...fileCfg?.download?.protection },
    },
    general: {
      ...DEFAULT_CONFIG.general,
      ...fileCfg?.general,
      autoadd: { ...DEFAULT_CONFIG.general.autoadd, ...fileCfg?.general?.autoadd },
      // listen:文件显式配置则深合并;否则由旧 autoadd 推导(等价迁移,行为不漂移)
      listen: fileCfg?.general?.listen
        ? mergeListen(fileCfg.general.listen)
        : deriveListenFromAutoadd({ ...DEFAULT_CONFIG.general.autoadd, ...fileCfg?.general?.autoadd }),
    },
    notify: {
      ...DEFAULT_CONFIG.notify,
      ...fileCfg?.notify,
      channels: {
        feishu: { ...DEFAULT_CONFIG.notify.channels.feishu, ...fileCfg?.notify?.channels?.feishu },
        wecom: { ...DEFAULT_CONFIG.notify.channels.wecom, ...fileCfg?.notify?.channels?.wecom },
        dingtalk: { ...DEFAULT_CONFIG.notify.channels.dingtalk, ...fileCfg?.notify?.channels?.dingtalk },
        bark: { ...DEFAULT_CONFIG.notify.channels.bark, ...fileCfg?.notify?.channels?.bark },
        serverchan: { ...DEFAULT_CONFIG.notify.channels.serverchan, ...fileCfg?.notify?.channels?.serverchan },
        telegram: { ...DEFAULT_CONFIG.notify.channels.telegram, ...fileCfg?.notify?.channels?.telegram },
        webhook: { ...DEFAULT_CONFIG.notify.channels.webhook, ...fileCfg?.notify?.channels?.webhook },
      },
    },
    server: { ...DEFAULT_CONFIG.server, ...fileCfg?.server },
    auth: { ...DEFAULT_CONFIG.auth, ...fileCfg?.auth },
    upgrade: { ...DEFAULT_CONFIG.upgrade, ...fileCfg?.upgrade },
    advanced: { ...DEFAULT_CONFIG.advanced, ...fileCfg?.advanced },
  }
  // 老配置的 notify.feishuWebhook（v0.4 唯一的通知字段）→ 接管进 channels.feishu
  const legacyFeishu = (fileCfg?.notify as { feishuWebhook?: string } | undefined)?.feishuWebhook
  if (legacyFeishu && !merged.notify.channels.feishu.webhook) {
    merged.notify.channels.feishu.webhook = legacyFeishu
    merged.notify.channels.feishu.enabled = true
  }
  // 老配置文件里可能还留着已废弃的下载选项（曾存在但从未生效）——加载时清掉，
  // 免得它们继续躺在 config.yaml 里冒充"可调参数"。
  for (const dead of ['writeId3', 'writeCover', 'concurrency', 'retries']) {
    delete (merged.download as unknown as Record<string, unknown>)[dead]
  }
  return applyEnvOverrides(merged)
}

export function saveConfig(cfg: AppConfig): void {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, YAML.stringify(cfg), 'utf8')
}
