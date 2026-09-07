import type { AppConfig, ListenRules, ListenParams } from '../config.js'
import { saveConfig } from '../config.js'
import type { LxServerAdapter } from '../adapters/lxserver.js'
import type { SyncEngine } from './sync-engine.js'
import * as repo from '../store/repo.js'
import { logger } from './logger.js'

/** 内存状态(进程内) */
export const listenStatus: { lastScanAt: string | null; lastCreated: number; lastNames: string[] } = {
  lastScanAt: null,
  lastCreated: 0,
  lastNames: [],
}

/** origin 标记:模式 → 自动任务分组 */
export function originOfMode(mode: 'all' | 'filtered'): string {
  return mode === 'all' ? 'auto-all' : 'auto-filtered'
}

/** 规则命中判定(纯函数,可单测):
 * 命中 = (未开排除 或 不命中排除) 且 (未开匹配 或 命中匹配)
 * 歌单命中:规则列表里的值匹配歌单 name 或 key;关键词只匹配名称子串 */
export function evaluateListenRules(name: string, key: string, rules: ListenRules): 'sync' | 'skip' {
  const hit = (g: { enabled: boolean; playlists: string[]; keywords: string[] }): boolean => {
    if (!g.enabled) return false
    if (g.playlists.some((v) => v === name || v === key)) return true
    return g.keywords.some((kw) => name.includes(kw))
  }
  if (rules.exclude.enabled && hit(rules.exclude)) return 'skip'
  if (rules.match.enabled && !hit(rules.match)) return 'skip'
  return 'sync'
}

/** 首次启用基线:记录当前 LX 歌单全集(启用前已存在的不自动纳入) */
async function initBaselineIfNeeded(cfg: AppConfig, lx: LxServerAdapter): Promise<void> {
  const L = cfg.general.listen
  if (!L.enabled || L.baselineKeys.length > 0) return
  try {
    const playlists = await lx.listPlaylists()
    L.baselineKeys = playlists.map((p) => p.key)
    saveConfig(cfg)
    logger.info(`[listen] 基线快照已初始化:${L.baselineKeys.length} 个歌单(之前存在的不会自动纳入)`)
  } catch (e) {
    logger.warn(`[listen] 基线初始化失败(LX 未连接?):${(e as Error).message}`)
  }
}

/** 用模式参数创建任务(新语义字段全量写入) */
function createFromParams(
  cfg: AppConfig,
  p: { key: string; name: string },
  params: ListenParams,
  origin: string,
): number {
  return repo.createTask({
    lxPlaylistKey: p.key,
    lxPlaylistName: p.name,
    embyTargetPlaylistIds: params.embyTargetPlaylistIds,
    createSameNamePlaylist: params.createSameNamePlaylist,
    cronExpr: params.taskCron?.trim() || null,
    syncMode: params.taskMode === 'mirror' ? 'full' : 'incremental', // 旧 UI 显示兼容
    mode: params.taskMode,
    delPolicy: params.delPolicy,
    archivePlaylist: params.archivePlaylist,
    origin,
    dedupCheck: params.dedupCheck,
    dedupMinQuality: params.dedupMinQuality,
  })
}

/**
 * 监听扫描(单监听器 + 模式互斥):
 * LX 新歌单 − 已有任务 − 基线 − 忽略 → 按 activeMode(完全=全量/条件=规则)决定是否自动建任务 → 立即同步一次
 */
export async function listenScan(
  cfg: AppConfig,
  lx: LxServerAdapter,
  engine: SyncEngine,
): Promise<{ created: number; names: string[]; skipped: number }> {
  const L = cfg.general.listen
  if (!L.enabled) return { created: 0, names: [], skipped: 0 }
  await initBaselineIfNeeded(cfg, lx)

  const playlists = await lx.listPlaylists()
  const taskKeys = new Set(repo.listTasks().map((t) => t.lxPlaylistKey))
  const known = new Set([...L.baselineKeys, ...L.ignoredKeys])
  const fresh = playlists.filter((p) => p.key.startsWith('user:') && !taskKeys.has(p.key) && !known.has(p.key))

  const names: string[] = []
  let skipped = 0
  for (const p of fresh) {
    const decide = L.activeMode === 'all' ? 'sync' : evaluateListenRules(p.name, p.key, L.filtered.rules)
    if (decide === 'skip') {
      skipped++
      logger.info(`[listen] 条件模式:跳过「${p.name}」(规则未命中)`)
      continue
    }
    const params = L.activeMode === 'all' ? L.all : L.filtered.params
    const origin = originOfMode(L.activeMode)
    const id = createFromParams(cfg, p, params, origin)
    names.push(p.name)
    logger.info(`[listen] ${L.activeMode === 'all' ? '完全' : '条件'}模式:新歌单「${p.name}」→ 任务#${id}(origin=${origin}),立即同步`)
    const r = await engine.runTask(id, 'manual')
    logger.info(`[listen] 「${p.name}」首次同步结果: ${r}`)
  }

  listenStatus.lastScanAt = new Date().toISOString()
  listenStatus.lastCreated = fresh.length - skipped
  listenStatus.lastNames = names
  return { created: fresh.length - skipped, names, skipped }
}
