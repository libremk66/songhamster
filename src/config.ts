import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'

/** 音质顺序（高→低尝试），界面复选框顺序即此 */
export const QUALITY_ORDER = ['master', 'atmos_plus', 'atmos', 'hires', 'flac24bit', 'flac', '320k', '128k'] as const
export type Quality = (typeof QUALITY_ORDER)[number]

/** 媒体服务器显示名 */
export const TARGET_LABEL: Record<'emby' | 'navidrome' | 'daoliyu' | 'subsonic', string> = {
  emby: 'Emby',
  navidrome: 'Navidrome',
  daoliyu: '道理鱼',
  subsonic: 'Subsonic',
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

/** 批量下载保护（仿 Songloft）：串行 + 间隔，防音源限流封禁 */
export interface DownloadProtection {
  /** 开关（推荐开启） */
  enabled: boolean
  /** 每首歌成功或失败后的等待间隔（秒，2~60，默认 5） */
  downloadIntervalSec: number
  /** 直链解析的最小间隔（秒，1~30，默认 2）——错开连续解析请求 */
  resolveIntervalSec: number
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
  emby: {
    baseUrl: string
    apiKey: string
    /** Emby 媒体库根路径（Emby 视角，用于探测库；如 /D8/.../LXSERVER/king/歌单同步） */
    libraryRoot: string
    /** 媒体库 Id（连接后自动探测填入） */
    mediaLibraryId?: string
  }
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
  target: 'emby' | 'navidrome' | 'daoliyu' | 'subsonic'
  download: {
    /** 勾选的音质，按高→低尝试；未勾选绝不使用 */
    qualities: Quality[]
    /** 命名模板：自由文本 + [歌手][专辑名][歌曲名][音质] 占位符 */
    filenameTemplate: string
    writeId3: boolean
    writeCover: boolean
    /** 内嵌歌词（LYRICS 标签） */
    embedLyric: boolean
    /** 外置歌词（.lrc 文件） */
    cacheLyric: boolean
    concurrency: number
    retries: number
    /** 批量下载保护：控制请求节奏，降低音源限流/封禁风险 */
    protection: DownloadProtection
  }
  general: {
    /** 自动纳入 LX 新建的歌单（旧字段，保留兼容；实际由 autoadd 接管） */
    autoIncludeNewPlaylists: boolean
    /** 完全同步时清理无引用孤立文件（默认关） */
    cleanupOrphanFiles: boolean
    /** 暂停所有同步 */
    pauseAll: boolean
    logRetentionDays: number
    /** 自动新增同步任务 */
    autoadd: AutoAddConfig
    /** 项目主页（侧栏"帮助"链接） */
    githubUrl: string
  }
  notify: {
    enabled: boolean
    feishuWebhook: string
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

export const DEFAULT_CONFIG: AppConfig = {
  lxserver: { baseUrl: 'http://127.0.0.1:19527', apiKey: '', username: 'king', downloadRoot: '' },
  emby: { baseUrl: 'http://127.0.0.1:8096', apiKey: '', libraryRoot: '' },
  navidrome: { baseUrl: '', username: '', password: '', libraryRoot: '' },
  daoliyu: { baseUrl: '', username: '', password: '', libraryRoot: '' },
  subsonic: { baseUrl: '', username: '', password: '' },
  target: 'emby',
  download: {
    qualities: ['flac24bit', 'flac'],
    filenameTemplate: '[歌手] - [歌曲名] ([音质])',
    writeId3: true,
    writeCover: true,
    embedLyric: true,
    cacheLyric: false,
    concurrency: 3,
    retries: 2,
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
    githubUrl: '',
  },
  notify: { enabled: false, feishuWebhook: '' },
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

export const DATA_DIR = process.env.SONGFERRY_DATA_DIR || path.join(process.cwd(), 'data')
export const CONFIG_PATH = process.env.SONGFERRY_CONFIG || path.join(DATA_DIR, 'config.yaml')
export const DB_PATH = process.env.SONGFERRY_DB || path.join(DATA_DIR, 'songferry.db')

/** 环境变量覆盖（docker secrets 注入用）：SONGFERRY_LXSERVER_URL / _KEY 等 */
function applyEnvOverrides(cfg: AppConfig): AppConfig {
  const map: Record<string, (v: string) => void> = {
    SONGFERRY_LXSERVER_URL: (v) => (cfg.lxserver.baseUrl = v),
    SONGFERRY_LXSERVER_KEY: (v) => (cfg.lxserver.apiKey = v),
    SONGFERRY_LXSERVER_USER: (v) => (cfg.lxserver.username = v),
    SONGFERRY_EMBY_URL: (v) => (cfg.emby.baseUrl = v),
    SONGFERRY_EMBY_KEY: (v) => (cfg.emby.apiKey = v),
    SONGFERRY_PORT: (v) => (cfg.server.port = Number(v)),
  }
  for (const [env, apply] of Object.entries(map)) {
    const v = process.env[env]
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
    download: {
      ...DEFAULT_CONFIG.download,
      ...fileCfg?.download,
      protection: { ...DEFAULT_CONFIG.download.protection, ...fileCfg?.download?.protection },
    },
    general: {
      ...DEFAULT_CONFIG.general,
      ...fileCfg?.general,
      autoadd: { ...DEFAULT_CONFIG.general.autoadd, ...fileCfg?.general?.autoadd },
    },
    notify: { ...DEFAULT_CONFIG.notify, ...fileCfg?.notify },
    server: { ...DEFAULT_CONFIG.server, ...fileCfg?.server },
    auth: { ...DEFAULT_CONFIG.auth, ...fileCfg?.auth },
    upgrade: { ...DEFAULT_CONFIG.upgrade, ...fileCfg?.upgrade },
    advanced: { ...DEFAULT_CONFIG.advanced, ...fileCfg?.advanced },
  }
  return applyEnvOverrides(merged)
}

export function saveConfig(cfg: AppConfig): void {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, YAML.stringify(cfg), 'utf8')
}
