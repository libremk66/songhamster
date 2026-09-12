import type { AppConfig, ListenRules, ListenParams } from '../config.js'
import { saveConfig, resolveArchiveName } from '../config.js'
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

/** 首次启用基线:记录当前 LX 歌单全集(启用前已存在的不自动纳入);勾了"包含现有歌单"则不需要基线 */
async function initBaselineIfNeeded(cfg: AppConfig, lx: LxServerAdapter): Promise<void> {
  const L = cfg.general.listen
  if (!L.enabled || L.includeExisting || L.baselineKeys.length > 0) return
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
  const isAll = L.activeMode === 'all'
  if (isAll) await initBaselineIfNeeded(cfg, lx) // 基线仅服务于完全模式(防把现有歌单全部建任务)

  const playlists = await lx.listPlaylists()
  const taskKeys = new Set(repo.listTasks().map((t) => t.lxPlaylistKey))
  const ignored = new Set(L.ignoredKeys)
  // 完全模式:默认用基线挡掉"启用前已存在"的歌单;勾了「包含现有歌单」则不看基线
  const knownBase = isAll && !L.includeExisting ? new Set(L.baselineKeys) : new Set<string>()
  // 条件模式:无时间窗/基线 —— 规则命中且尚未建任务即纳入(含启用前已存在的歌单)
  const fresh = playlists.filter(
    (p) => p.key.startsWith('user:') && !taskKeys.has(p.key) && !ignored.has(p.key) && !knownBase.has(p.key),
  )

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
    // 归档目标：配置期创建（按来源时 [歌单名] 会解析成该歌单自己的名字）
    if (params.delPolicy === 'archive') {
      const an = resolveArchiveName(params.archivePlaylist, p.name)
      const ar = await engine.ensureArchiveTarget(an, 'shared') // 监听自动建的任务：目标歌单按"共享"处理
      if (ar.created) logger.info(`[listen] 已创建归档歌单「${an}」`)
    }
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
