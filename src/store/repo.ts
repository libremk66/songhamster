import { getDb, type BatchResult, type SongStatus, type SyncMode, type SyncTaskRow } from './db.js'
import type { DelPolicy, TaskMode } from '../config.js'

// ===== sync_task =====

export interface SyncTask extends SyncTaskRow {
  embyTargetPlaylistIdsParsed: string[]
}

function rowToTask(r: SyncTaskRow): SyncTask {
  let ids: string[] = []
  try {
    ids = JSON.parse(r.embyTargetPlaylistIds || '[]')
  } catch {
    ids = []
  }
  return { ...r, embyTargetPlaylistIdsParsed: ids }
}

export function listTasks(): SyncTask[] {
  const rows = getDb().prepare('SELECT * FROM sync_task ORDER BY id').all() as SyncTaskRow[]
  return rows.map(rowToTask)
}

export function getTask(id: number): SyncTask | null {
  const r = getDb().prepare('SELECT * FROM sync_task WHERE id = ?').get(id) as SyncTaskRow | undefined
  return r ? rowToTask(r) : null
}

export function createTask(input: {
  lxPlaylistKey: string
  lxPlaylistName: string
  embyTargetPlaylistIds?: string[]
  createSameNamePlaylist?: boolean
  cronExpr?: string | null
  syncMode?: SyncMode
  /** 新语义同步方式;缺省 = null(由 syncMode 兼容映射) */
  mode?: TaskMode
  delPolicy?: DelPolicy
  archivePlaylist?: string | null
  origin?: string
  dedupCheck?: boolean
  dedupMinQuality?: string | null
  taskType?: 'playlist' | 'chart' | 'adhoc'
  chartSource?: string
  chartId?: string
  chartName?: string
  maxCount?: number
}): number {
  const stmt = getDb().prepare(
    `INSERT INTO sync_task (lxPlaylistKey, lxPlaylistName, taskType, chartSource, chartId, chartName, maxCount, enabled, embyTargetPlaylistIds, createSameNamePlaylist, cronExpr, syncMode, mode, delPolicy, archivePlaylist, origin, dedupCheck, dedupMinQuality)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const info = stmt.run(
    input.lxPlaylistKey,
    input.lxPlaylistName,
    input.taskType ?? 'playlist',
    input.chartSource ?? null,
    input.chartId ?? null,
    input.chartName ?? null,
    input.maxCount ?? 30,
    JSON.stringify(input.embyTargetPlaylistIds ?? []),
    input.createSameNamePlaylist !== false ? 1 : 0,
    input.cronExpr ?? null,
    input.syncMode ?? 'incremental',
    input.mode ?? null,
    input.delPolicy ?? 'keep',
    input.archivePlaylist ?? null,
    input.origin ?? 'manual',
    input.dedupCheck ? 1 : 0,
    input.dedupMinQuality ?? null,
  )
  return Number(info.lastInsertRowid)
}

export function updateTask(id: number, patch: Partial<SyncTaskRow>): void {
  const cur = getTask(id)
  if (!cur) throw new Error(`任务不存在: ${id}`)
  const next = { ...cur, ...patch }
  getDb()
    .prepare(
      `UPDATE sync_task SET lxPlaylistName=?, taskType=?, chartSource=?, chartId=?, chartName=?, maxCount=?, enabled=?, embyTargetPlaylistIds=?, createSameNamePlaylist=?, cronExpr=?, syncMode=?, mode=?, delPolicy=?, archivePlaylist=?, origin=?, lastRunAt=?, lastResult=?, dedupCheck=?, dedupMinQuality=? WHERE id=?`,
    )
    .run(
      next.lxPlaylistName,
      next.taskType,
      next.chartSource,
      next.chartId,
      next.chartName,
      next.maxCount,
      next.enabled,
      next.embyTargetPlaylistIds,
      next.createSameNamePlaylist,
      next.cronExpr,
      next.syncMode,
      next.mode,
      next.delPolicy,
      next.archivePlaylist,
      next.origin,
      next.lastRunAt,
      next.lastResult,
      next.dedupCheck,
      next.dedupMinQuality,
      id,
    )
}

/**
 * 删除任务：连带清理它的全部关联数据（历史批次+明细 / 快照 / 文件引用 / 歌曲状态）。
 *
 * ⚠️ 必须先删子表再删主表：这些表都声明了 `REFERENCES sync_task(id)`，而连接开了
 * `foreign_keys = ON`，直接删 sync_task 会抛 `FOREIGN KEY constraint failed`
 * （旧实现就是这个 bug：界面弹了确认框，删完任务还在列表里）。
 * 整个过程包在事务里——中途失败不会留下半删状态。
 */
export function deleteTask(id: number): void {
  const db = getDb()
  db.transaction((tid: number) => {
    db.prepare('DELETE FROM history_item WHERE batchId IN (SELECT id FROM history_batch WHERE taskId = ?)').run(tid)
    db.prepare('DELETE FROM history_batch WHERE taskId = ?').run(tid)
    db.prepare('DELETE FROM playlist_snapshot WHERE taskId = ?').run(tid)
    db.prepare('DELETE FROM chart_snapshot WHERE taskId = ?').run(tid)
    db.prepare('DELETE FROM current_song_status WHERE taskId = ?').run(tid)
    db.prepare('DELETE FROM task_song_ref WHERE taskId = ?').run(tid)
    db.prepare('DELETE FROM sync_task WHERE id = ?').run(tid)
  })(id)
}

// ===== current_song_status（进度页矩阵 + 增量 diff 依据） =====

export interface SongStatusRow {
  taskId: number
  songKey: string
  songName: string
  singer: string
  status: SongStatus
  quality?: string
  errorReason?: string
  updatedAt: string
}

export function listSongStatus(taskId: number): SongStatusRow[] {
  return getDb().prepare('SELECT * FROM current_song_status WHERE taskId = ?').all(taskId) as SongStatusRow[]
}

export function upsertSongStatus(row: Omit<SongStatusRow, 'updatedAt'>): void {
  getDb()
    .prepare(
      `INSERT INTO current_song_status (taskId, songKey, songName, singer, status, quality, errorReason, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(taskId, songKey) DO UPDATE SET songName=excluded.songName, singer=excluded.singer,
         status=excluded.status, quality=excluded.quality, errorReason=excluded.errorReason, updatedAt=excluded.updatedAt`,
    )
    .run(row.taskId, row.songKey, row.songName, row.singer, row.status, row.quality ?? null, row.errorReason ?? null, new Date().toISOString())
}

// ===== history_batch / history_item =====

export interface BatchRow {
  id: number
  taskId: number
  trigger: string
  startedAt: string
  finishedAt: string | null
  result: BatchResult | null
  okCount: number
  failCount: number
  unsatisfiedCount: number
  removedCount: number
  dupCount: number
  dedupCount: number
  detail: string | null
}

export function createBatch(input: { taskId: number; trigger: string }): number {
  const info = getDb()
    .prepare(`INSERT INTO history_batch (taskId, trigger, startedAt) VALUES (?, ?, ?)`)
    .run(input.taskId, input.trigger, new Date().toISOString())
  return Number(info.lastInsertRowid)
}

export function finishBatch(batchId: number, patch: Partial<Omit<BatchRow, 'id'>>): void {
  const sets: string[] = []
  const vals: unknown[] = []
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`)
    vals.push(v)
  }
  if (!sets.length) return
  vals.push(batchId)
  getDb().prepare(`UPDATE history_batch SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

export function listBatches(taskId?: number, limit = 30): BatchRow[] {
  const sql = taskId
    ? 'SELECT * FROM history_batch WHERE taskId = ? ORDER BY id DESC LIMIT ?'
    : 'SELECT * FROM history_batch ORDER BY id DESC LIMIT ?'
  return (taskId ? getDb().prepare(sql).all(taskId, limit) : getDb().prepare(sql).all(limit)) as BatchRow[]
}

export function insertHistoryItem(item: {
  batchId: number
  taskId: number
  songKey: string
  songName: string
  singer?: string
  status: SongStatus
  quality?: string
  filePath?: string
  errorReason?: string
}): void {
  getDb()
    .prepare(
      `INSERT INTO history_item (batchId, taskId, songKey, songName, singer, status, quality, filePath, errorReason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      item.batchId,
      item.taskId,
      item.songKey,
      item.songName,
      item.singer ?? null,
      item.status,
      item.quality ?? null,
      item.filePath ?? null,
      item.errorReason ?? null,
    )
}

// ===== song_files / task_song_ref（引用计数） =====

export interface SongFileRow {
  id: number
  songKey: string
  quality: string
  fileName: string
  filePath: string
  size?: number
  verifiedQuality?: string
}

export function findSongFile(songKey: string, quality: string): SongFileRow | null {
  const r = getDb().prepare('SELECT * FROM song_files WHERE songKey = ? AND quality = ?').get(songKey, quality) as SongFileRow | undefined
  return r ?? null
}

export function registerFile(input: { songKey: string; quality: string; fileName: string; filePath: string; size?: number }): number {
  const existing = findSongFile(input.songKey, input.quality)
  if (existing) return existing.id
  const info = getDb()
    .prepare(`INSERT INTO song_files (songKey, quality, fileName, filePath, size, firstDownloadedAt) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(input.songKey, input.quality, input.fileName, input.filePath, input.size ?? null, new Date().toISOString())
  return Number(info.lastInsertRowid)
}

/** 任务引用某文件（幂等）；返回是否新增引用 */
export function refTaskFile(taskId: number, songKey: string, fileId: number): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO task_song_ref (taskId, songKey, fileId) VALUES (?, ?, ?)`)
    .run(taskId, songKey, fileId)
}

/** 文件当前被哪些任务引用 */
export function fileRefCount(fileId: number): number {
  const r = getDb().prepare('SELECT COUNT(*) AS n FROM task_song_ref WHERE fileId = ?').get(fileId) as { n: number }
  return r.n
}

/** 本任务是否加入过该歌(provenance:镜像删除只处理"自己加过的") */
export function hasTaskSongRef(taskId: number, songKey: string): boolean {
  const r = getDb()
    .prepare('SELECT 1 AS x FROM task_song_ref WHERE taskId = ? AND songKey = ? LIMIT 1')
    .get(taskId, songKey) as { x: number } | undefined
  return !!r
}

/** origin 分组统计:made=总数,paused=停用数(模式切换任务策略/状态条用) */
export function taskOriginStats(): Record<string, { made: number; paused: number }> {
  const rows = getDb()
    .prepare('SELECT origin, enabled, COUNT(*) AS n FROM sync_task GROUP BY origin, enabled')
    .all() as { origin: string; enabled: number; n: number }[]
  const out: Record<string, { made: number; paused: number }> = {}
  for (const r of rows) {
    out[r.origin] = out[r.origin] ?? { made: 0, paused: 0 }
    out[r.origin].made += r.n
    if (!r.enabled) out[r.origin].paused += r.n
  }
  return out
}

/** 按 origin 启停任务(切换模式 A+C 的一键暂停/恢复);返回受影响数 */
export function setTasksEnabledByOrigin(origin: string, enabled: boolean): number {
  const info = getDb().prepare('UPDATE sync_task SET enabled = ? WHERE origin = ?').run(enabled ? 1 : 0, origin)
  return info.changes
}

/** 某歌的全部文件(镜像删除策略 delete 用) */
export function listFilesForSong(songKey: string): { fileId: number; filePath: string }[] {
  return getDb().prepare('SELECT id AS fileId, filePath FROM song_files WHERE songKey = ?').all(songKey) as {
    fileId: number
    filePath: string
  }[]
}

// ===== emby_song_map =====

export function getEmbyMap(songKey: string): { embySongId: string; lastVerifiedAt: string } | null {
  const r = getDb().prepare('SELECT * FROM emby_song_map WHERE songKey = ?').get(songKey) as
    | { embySongId: string; lastVerifiedAt: string }
    | undefined
  return r ?? null
}

/** 清空某首歌的媒体库条目缓存（条目 Id 变了 / 换服务器后作废） */
export function clearEmbyMap(songKey: string): void {
  getDb().prepare('DELETE FROM emby_song_map WHERE songKey = ?').run(songKey)
}

/** 清空全部媒体库条目缓存（切换同步目标时调用：Id 体系随服务器不同） */
export function clearAllEmbyMap(): number {
  const r = getDb().prepare('DELETE FROM emby_song_map').run()
  return r.changes
}

export function setEmbyMap(songKey: string, embySongId: string): void {
  getDb()
    .prepare(`INSERT INTO emby_song_map (songKey, embySongId, lastVerifiedAt) VALUES (?, ?, ?)
              ON CONFLICT(songKey) DO UPDATE SET embySongId=excluded.embySongId, lastVerifiedAt=excluded.lastVerifiedAt`)
    .run(songKey, embySongId, new Date().toISOString())
}

// ===== playlist_snapshot（完全同步 diff 依据） =====

export function getSnapshot(taskId: number): string[] | null {
  const r = getDb().prepare('SELECT songKeys FROM playlist_snapshot WHERE taskId = ?').get(taskId) as { songKeys: string } | undefined
  if (!r) return null
  try {
    return JSON.parse(r.songKeys)
  } catch {
    return []
  }
}

export function setSnapshot(taskId: number, songKeys: string[]): void {
  getDb()
    .prepare(`INSERT INTO playlist_snapshot (taskId, songKeys, updatedAt) VALUES (?, ?, ?)
              ON CONFLICT(taskId) DO UPDATE SET songKeys=excluded.songKeys, updatedAt=excluded.updatedAt`)
    .run(taskId, JSON.stringify(songKeys), new Date().toISOString())
}

// ===== 榜单订阅快照（时效性展示：变化报告/浏览页新上榜标记） =====

export interface ChartSnapshot {
  id: number
  taskId: number
  syncedAt: string
  totalCount: number
  newCount: number
  removedCount: number
  songKeys: string[] // 当期榜单（前 N 范围）songKey 全集
}

export function saveChartSnapshot(input: {
  taskId: number
  syncedAt: string
  totalCount: number
  newCount: number
  removedCount: number
  songKeys: string[]
}): void {
  getDb()
    .prepare(
      `INSERT INTO chart_snapshot (taskId, syncedAt, totalCount, newCount, removedCount, songKeys) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.taskId, input.syncedAt, input.totalCount, input.newCount, input.removedCount, JSON.stringify(input.songKeys))
}

/** 某订阅任务最近一次快照（变化对比基准） */
export function getLatestChartSnapshot(taskId: number): ChartSnapshot | null {
  const r = getDb().prepare('SELECT * FROM chart_snapshot WHERE taskId = ? ORDER BY id DESC LIMIT 1').get(taskId) as
    | (Omit<ChartSnapshot, 'songKeys'> & { songKeys: string })
    | undefined
  if (!r) return null
  let keys: string[] = []
  try {
    keys = JSON.parse(r.songKeys)
  } catch {
    keys = []
  }
  return { ...r, songKeys: keys }
}

/** 某订阅任务全部快照（订阅详情时间线） */
export function listChartSnapshots(taskId: number, limit = 20): ChartSnapshot[] {
  const rows = getDb().prepare('SELECT * FROM chart_snapshot WHERE taskId = ? ORDER BY id DESC LIMIT ?').all(taskId, limit) as (Omit<ChartSnapshot, 'songKeys'> & { songKeys: string })[]
  return rows.map((r) => {
    let keys: string[] = []
    try {
      keys = JSON.parse(r.songKeys)
    } catch {
      keys = []
    }
    return { ...r, songKeys: keys }
  })
}

/** 已下载歌曲全集（song_files 去重 songKey）——榜单浏览"已收录"标记用 */
export function listDownloadedKeys(): Set<string> {
  const rows = getDb().prepare('SELECT DISTINCT songKey FROM song_files').all() as { songKey: string }[]
  return new Set(rows.map((r) => r.songKey))
}

/** 手动下载单例任务（不可见 cron，仅作为历史/进度归属；不存在则创建） */
export function ensureManualTask(): number {
  const KEY = 'adhoc:manual'
  const t = listTasks().find((x) => x.lxPlaylistKey === KEY)
  if (t) return t.id
  const id = createTask({
    lxPlaylistKey: KEY,
    lxPlaylistName: '手动下载',
    taskType: 'adhoc',
    createSameNamePlaylist: false,
    syncMode: 'incremental',
  })
  updateTask(id, { enabled: 0 })
  return id
}
