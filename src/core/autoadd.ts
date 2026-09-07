import type { AppConfig } from '../config.js'
import type { LxServerAdapter } from '../adapters/lxserver.js'
import type { SyncEngine } from './sync-engine.js'
import * as repo from '../store/repo.js'
import { logger } from './logger.js'

/** 检测状态（内存级，进程内有效；重启后摘要归零但日志可查） */
export const autoaddStatus: { lastScanAt: string | null; lastCreated: number; lastNames: string[] } = {
  lastScanAt: null,
  lastCreated: 0,
  lastNames: [],
}

/**
 * 自动新增扫描：
 * LX 歌单 − (已有任务 ∪ 基线快照 ∪ 忽略列表) = 新增 → 逐个 createTask（autoadd 默认配置）→ 立即同步一次
 */
export async function autoaddScan(
  cfg: AppConfig,
  lx: LxServerAdapter,
  engine: SyncEngine,
): Promise<{ created: number; names: string[] }> {
  const a = cfg.general.autoadd
  if (!a.enabled) return { created: 0, names: [] }

  const playlists = await lx.listPlaylists()
  const taskKeys = new Set(repo.listTasks().map((t) => t.lxPlaylistKey))
  const known = new Set([...a.baselineKeys, ...a.ignoredKeys])
  const fresh = playlists.filter((p) => p.key.startsWith('user:') && !taskKeys.has(p.key) && !known.has(p.key))

  const names: string[] = []
  for (const p of fresh) {
    const id = repo.createTask({
      lxPlaylistKey: p.key,
      lxPlaylistName: p.name,
      embyTargetPlaylistIds: a.embyTargetPlaylistIds,
      createSameNamePlaylist: a.createSameNamePlaylist,
      cronExpr: a.taskCron?.trim() || null,
      syncMode: a.syncMode,
      origin: 'auto-all', // 监听自动创建分组(切换策略/一键停用用)
      dedupCheck: a.dedupCheck,
      dedupMinQuality: a.dedupMinQuality,
    })
    names.push(p.name)
    logger.info(`[autoadd] 检测到新歌单「${p.name}」→ 已创建任务#${id}，立即同步`)
    // 立即同步一次（引擎单飞：若忙碌则本轮跳过该次同步，任务已建不会重复建）
    const r = await engine.runTask(id, 'manual')
    logger.info(`[autoadd] 「${p.name}」首次同步结果: ${r}`)
  }

  autoaddStatus.lastScanAt = new Date().toISOString()
  autoaddStatus.lastCreated = fresh.length
  autoaddStatus.lastNames = names
  return { created: fresh.length, names }
}

/** 保存自动新增设置时初始化基线快照（首次启用：记录当前 LX 全部歌单） */
export async function initBaselineIfNeeded(cfg: AppConfig, lx: LxServerAdapter): Promise<void> {
  const a = cfg.general.autoadd
  if (!a.enabled || a.baselineKeys.length > 0) return
  try {
    const playlists = await lx.listPlaylists()
    a.baselineKeys = playlists.map((p) => p.key)
    logger.info(`[autoadd] 基线快照已初始化：${playlists.length} 个歌单（启用前已存在的不会被自动纳入）`)
  } catch (e) {
    logger.warn(`[autoadd] 基线初始化失败（LX 未连接？）：${(e as Error).message}`)
  }
}
