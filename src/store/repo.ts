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
  playlistScope?: string | null
  playlistScopeName?: string | null
}): number {
  const stmt = getDb().prepare(
    `INSERT INTO sync_task (lxPlaylistKey, lxPlaylistName, taskType, chartSource, chartId, chartName, maxCount, enabled, embyTargetPlaylistIds, createSameNamePlaylist, cronExpr, syncMode, mode, delPolicy, archivePlaylist, origin, dedupCheck, dedupMinQuality, playlistScope, playlistScopeName)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    input.playlistScope ?? null,
    input.playlistScopeName ?? null,
  )
  return Number(info.lastInsertRowid)
}

export function updateTask(id: number, patch: Partial<SyncTaskRow>): void {
  const cur = getTask(id)
  if (!cur) throw new Error(`任务不存在: ${id}`)
  const next = { ...cur, ...patch }
  getDb()
    .prepare(
      `UPDATE sync_task SET lxPlaylistName=?, taskType=?, chartSource=?, chartId=?, chartName=?, maxCount=?, enabled=?, embyTargetPlaylistIds=?, createSameNamePlaylist=?, cronExpr=?, syncMode=?, mode=?, delPolicy=?, archivePlaylist=?, origin=?, lastRunAt=?, lastResult=?, dedupCheck=?, dedupMinQuality=?, playlistScope=?, playlistScopeName=? WHERE id=?`,
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
      next.playlistScope,
      next.playlistScopeName,
      id,
    )
}

/**
 * 删除任务：清理它的关联数据（快照 / 文件引用 / 歌曲状态），历史批次可选保留。
 *
 * ⚠️ 必须先删子表再删主表：在别处这些表声明了 `REFERENCES sync_task(id)`，而连接开了
 * `foreign_keys = ON`，直接删 sync_task 会抛 `FOREIGN KEY constraint failed`
 * （旧实现就是这个 bug：界面弹了确认框，删完任务还在列表里）。
 * 整个过程包在事务里——中途失败不会留下半删状态。
 *
 * keepHistory=true：保留历史批次与明细（history_batch 已去掉外键 + 自带任务名/类型快照），
 * 用于「删除任务」时用户不勾「历史记录」的情况。
 */
export function deleteTask(id: number, opts: { keepHistory?: boolean } = {}): void {
  const db = getDb()
  db.transaction((tid: number) => {
    if (!opts.keepHistory) {
      db.prepare('DELETE FROM history_item WHERE batchId IN (SELECT id FROM history_batch WHERE taskId = ?)').run(tid)
      db.prepare('DELETE FROM history_batch WHERE taskId = ?').run(tid)
    }
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
  /** 任务名快照（任务被删、历史保留时仍能显示） */
  taskName: string | null
  /** 任务类型快照（"歌单同步/榜单订阅"分标签依据，任务没了也分得清） */
  taskType: string | null
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
  /** 榜单批次的变化统计 JSON：{ total, new, removed }（歌单任务为 null） */
  chartJson: string | null
  // ── 任务属性快照（2026-09-13 起）：任务可被删、配置可被改，历史行不能"现查任务" ──
  mode: string | null
  delPolicy: string | null
  archivePlaylist: string | null
  /** JSON：目标歌单**名**数组 */
  targetPlaylists: string | null
  /** JSON：[{key,name}] 本次被 diff 跳过的歌（已同步过，没进处理流程） */
  skippedJson: string | null
  skippedCount: number
  /** 歌单归属（共享 / 指定用户名） */
  playlistScopeName: string | null
  /** 榜单下载范围（前 N 首；0 或 null = 全榜） */
  maxCount: number | null
}

/** 引用快照里的一个任务（历史页「引用情况」列展示用） */
export interface RefTask {
  taskId: number
  taskName: string
}

export function createBatch(input: {
  taskId: number
  trigger: string
  /** 运行时的任务属性快照（缺省回落到任务当前值） */
  snapshot?: {
    mode?: string | null
    delPolicy?: string | null
    archivePlaylist?: string | null
    targetPlaylists?: string[] | null
    playlistScopeName?: string | null
    maxCount?: number | null
  }
}): number {
  // 名称/类型随批次快照一份：任务可被删而历史保留（删除任务的三个复选框）
  const t = getTask(input.taskId)
  const s = input.snapshot ?? {}
  const info = getDb()
    .prepare(
      `INSERT INTO history_batch (taskId, taskName, taskType, trigger, startedAt, mode, delPolicy, archivePlaylist,
                                  targetPlaylists, playlistScopeName, maxCount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.taskId,
      t?.lxPlaylistName ?? null,
      t?.taskType ?? null,
      input.trigger,
      new Date().toISOString(),
      s.mode ?? t?.mode ?? null,
      s.delPolicy ?? t?.delPolicy ?? null,
      s.archivePlaylist ?? t?.archivePlaylist ?? null,
      s.targetPlaylists?.length ? JSON.stringify(s.targetPlaylists) : null,
      s.playlistScopeName ?? t?.playlistScopeName ?? null,
      s.maxCount ?? t?.maxCount ?? null,
    )
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

export function getBatch(id: number): BatchRow | null {
  return (getDb().prepare('SELECT * FROM history_batch WHERE id = ?').get(id) as BatchRow | undefined) ?? null
}

// ===== 进度历史页查询层（2026-09-13 P2）=====

/** 平铺历史表的筛选条件（标签①） */
export interface HistoryQuery {
  /** 歌名/歌手 模糊 */
  q?: string
  /** 所属任务名（下拉，精确） */
  taskName?: string
  trigger?: string
  mode?: string
  quality?: string
  /** in=入库 / out=移出 */
  action?: string
  process?: string
  status?: string
  from?: string
  to?: string
  /** 文件路径 模糊 */
  path?: string
  /** keyset 分页：只取 id 小于它的事件行 */
  cursor?: number
  limit?: number
}

/** 平铺表的一行 = 一次「任务运行 × 歌曲」事件（含批次快照与派生列） */
export interface HistoryRow {
  id: number
  batchId: number
  taskId: number
  songKey: string
  songName: string | null
  singer: string | null
  status: string
  quality: string | null
  filePath: string | null
  fileSize: number | null
  errorReason: string | null
  detail: string | null
  action: string | null
  process: string | null
  refBefore: string | null
  refAfter: string | null
  // 批次侧（快照）
  startedAt: string
  taskName: string | null
  taskType: string | null
  trigger: string
  mode: string | null
  delPolicy: string | null
  targetPlaylists: string | null
  playlistScopeName: string | null
  maxCount: number | null
  /** 本批次的明细行数（批次视图/空批次判定用） */
  batchRows: number
  /** 这首歌在**本任务**里是第几次处理（1=首次） */
  attemptNo: number
  /** 全库这首歌最早一条事件的 id（"首次 →#N" 跳转用） */
  firstId: number
}

export function listHistoryRows(f: HistoryQuery): HistoryRow[] {
  const where: string[] = []
  const args: unknown[] = []
  if (f.q) { where.push('(h.songName LIKE ? OR h.singer LIKE ?)'); args.push(`%${f.q}%`, `%${f.q}%`) }
  if (f.taskName) { where.push('b.taskName = ?'); args.push(f.taskName) }
  if (f.trigger) { where.push('b.trigger = ?'); args.push(f.trigger) }
  if (f.mode) { where.push('b.mode = ?'); args.push(f.mode) }
  if (f.quality) { where.push('h.quality = ?'); args.push(f.quality) }
  if (f.action) { where.push('h.action = ?'); args.push(f.action) }
  if (f.process) { where.push('h.process = ?'); args.push(f.process) }
  if (f.status) { where.push('h.status = ?'); args.push(f.status) }
  if (f.from) { where.push('b.startedAt >= ?'); args.push(f.from) }
  if (f.to) { where.push('b.startedAt <= ?'); args.push(f.to) }
  if (f.path) { where.push('h.filePath LIKE ?'); args.push(`%${f.path}%`) }
  if (f.cursor) { where.push('h.id < ?'); args.push(f.cursor) }
  const limit = Math.min(500, Math.max(1, f.limit ?? 100))
  const sql = `
    SELECT h.id, h.batchId, h.taskId, h.songKey, h.songName, h.singer, h.status, h.quality,
           h.filePath, h.fileSize, h.errorReason, h.detail, h.action, h.process, h.refBefore, h.refAfter,
           b.startedAt, b.taskName, b.taskType, b.trigger, b.mode, b.delPolicy, b.targetPlaylists,
           b.playlistScopeName, b.maxCount,
           ROW_NUMBER() OVER (PARTITION BY h.taskId, h.songKey ORDER BY h.id) AS attemptNo,
           MIN(h.id)      OVER (PARTITION BY h.songKey)  AS firstId,
           COUNT(*)       OVER (PARTITION BY h.batchId)  AS batchRows
    FROM history_item h JOIN history_batch b ON b.id = h.batchId
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY h.id DESC LIMIT ?`
  return getDb().prepare(sql).all(...args, limit) as HistoryRow[]
}

/** 批次视图（标签①的「批次」切换）：每批次一行 + 跳过名单 */
export function listBatchRows(f: { taskName?: string; trigger?: string; mode?: string; from?: string; to?: string; cursor?: number; limit?: number }): BatchRow[] {
  const where: string[] = []
  const args: unknown[] = []
  if (f.taskName) { where.push('taskName = ?'); args.push(f.taskName) }
  if (f.trigger) { where.push('trigger = ?'); args.push(f.trigger) }
  if (f.mode) { where.push('mode = ?'); args.push(f.mode) }
  if (f.from) { where.push('startedAt >= ?'); args.push(f.from) }
  if (f.to) { where.push('startedAt <= ?'); args.push(f.to) }
  if (f.cursor) { where.push('id < ?'); args.push(f.cursor) }
  const limit = Math.min(500, Math.max(1, f.limit ?? 100))
  const sql = `SELECT * FROM history_batch ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
  return getDb().prepare(sql).all(...args, limit) as BatchRow[]
}

/** 下拉框候选值（任务名/音质——process 用代码里的固定枚举，空库也能选） */
export function historyFacets(): { taskNames: string[]; qualities: string[] } {
  const db = getDb()
  const taskNames = (db.prepare('SELECT DISTINCT taskName FROM history_batch WHERE taskName IS NOT NULL ORDER BY taskName').all() as { taskName: string }[]).map((r) => r.taskName)
  const qualities = (db.prepare('SELECT DISTINCT quality FROM history_item WHERE quality IS NOT NULL ORDER BY quality').all() as { quality: string }[]).map((r) => r.quality)
  return { taskNames, qualities }
}

/** 台账增强用：每（任务×歌曲）的事件数与最早事件 id */
export function historyCountsByTaskSong(): Record<string, { n: number; firstId: number }> {
  const rows = getDb()
    .prepare('SELECT taskId, songKey, COUNT(*) AS n, MIN(id) AS firstId FROM history_item GROUP BY taskId, songKey')
    .all() as { taskId: number; songKey: string; n: number; firstId: number }[]
  const out: Record<string, { n: number; firstId: number }> = {}
  for (const r of rows) out[`${r.taskId}|${r.songKey}`] = { n: r.n, firstId: r.firstId }
  return out
}

/** 台账增强用：每首歌当前被几个任务引用 */
export function refCountsBySong(): Record<string, number> {
  const rows = getDb()
    .prepare('SELECT songKey, COUNT(DISTINCT taskId) AS n FROM task_song_ref GROUP BY songKey')
    .all() as { songKey: string; n: number }[]
  const out: Record<string, number> = {}
  for (const r of rows) out[r.songKey] = r.n
  return out
}

/** 搜索卡：按歌聚合（当前状态 + 文件 + 首次/最近 + 记录数） */
export interface SongSearchHit {
  songKey: string
  name: string
  singer: string
  records: number
  firstId: number
  firstAt: string | null
  firstTask: string | null
  lastAt: string | null
  states: { taskId: number; taskName: string; status: string; quality: string | null; updatedAt: string }[]
  file: { filePath: string; size: number | null; quality: string | null; firstDownloadedAt: string | null } | null
  refs: { taskId: number; taskName: string }[]
}

export function searchSongs(q: string, limit = 20): SongSearchHit[] {
  const db = getDb()
  const like = `%${q}%`
  const keys = db
    .prepare(
      `SELECT h.songKey, COUNT(*) AS n, MIN(h.id) AS firstId, MAX(h.id) AS lastId
       FROM history_item h WHERE h.songName LIKE ? OR h.singer LIKE ?
       GROUP BY h.songKey ORDER BY MAX(h.id) DESC LIMIT ?`,
    )
    .all(like, like, limit) as { songKey: string; n: number; firstId: number; lastId: number }[]
  if (!keys.length) return []
  return keys.map((k) => {
    const first = db.prepare('SELECT h.songName, h.singer, b.startedAt, b.taskName FROM history_item h JOIN history_batch b ON b.id = h.batchId WHERE h.id = ?').get(k.firstId) as { songName: string | null; singer: string | null; startedAt: string; taskName: string | null } | undefined
    const last = db.prepare('SELECT startedAt FROM history_batch WHERE id = (SELECT batchId FROM history_item WHERE id = ?)').get(k.lastId) as { startedAt: string } | undefined
    const states = db
      .prepare(
        `SELECT s.taskId, COALESCE(t.lxPlaylistName, '已删除的任务 #' || s.taskId) AS taskName, s.status, s.quality, s.updatedAt
         FROM current_song_status s LEFT JOIN sync_task t ON t.id = s.taskId
         WHERE s.songKey = ? ORDER BY s.updatedAt DESC`,
      )
      .all(k.songKey) as SongSearchHit['states']
    const f = db.prepare('SELECT filePath, size, quality, firstDownloadedAt FROM song_files WHERE songKey = ? ORDER BY (size IS NULL), size DESC LIMIT 1').get(k.songKey) as SongSearchHit['file']
    const refs = (db.prepare('SELECT DISTINCT taskId FROM task_song_ref WHERE songKey = ?').all(k.songKey) as { taskId: number }[])
      .map((r) => ({ taskId: r.taskId, taskName: getTask(r.taskId)?.lxPlaylistName ?? `已删除的任务 #${r.taskId}` }))
    return {
      songKey: k.songKey,
      name: first?.songName ?? k.songKey,
      singer: first?.singer ?? '',
      records: k.n,
      firstId: k.firstId,
      firstAt: first?.startedAt ?? null,
      firstTask: first?.taskName ?? null,
      lastAt: last?.startedAt ?? null,
      states,
      file: f ?? null,
      refs,
    }
  })
}

/** 搜索卡：命中的歌单（按当前任务名） */
export function searchTasks(q: string, limit = 10): { taskId: number; taskName: string; taskType: string | null }[] {
  const db = getDb()
  return db
    .prepare('SELECT id AS taskId, lxPlaylistName AS taskName, taskType FROM sync_task WHERE lxPlaylistName LIKE ? LIMIT ?')
    .all(`%${q}%`, limit) as { taskId: number; taskName: string; taskType: string | null }[]
}

/**
 * 启动时收尾"没跑完"的批次：finishedAt IS NULL 说明上次运行时进程被中断
 * （崩溃 / 重启 / 部署）。不收尾的话它们在界面上会永远显示成 `null`。
 * 返回收尾条数。
 */
export function finalizeStaleBatches(): number {
  const r = getDb()
    .prepare(`UPDATE history_batch SET finishedAt = ?, result = 'failed', detail = ?
              WHERE finishedAt IS NULL`)
    .run(new Date().toISOString(), '本次运行被中断（程序重启或崩溃）——未完成，下次同步会重新处理')
  return r.changes
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
  /** 处理轨迹（查库/尝试档位/下载/入库/入歌单…），历史明细据此展示"到底做了什么" */
  detail?: string[]
  // ── 2026-09-13 起：结构化字段（平铺历史表据此筛选/展示）──
  /** 任务操作：in=入库 / out=移出。不传时按 status 推导（removed/skipped → out，其余 in） */
  action?: 'in' | 'out'
  /** 处理过程枚举码（download_new / reuse_skip / unsatisfied / ingest_fail / remove_p1~p3 / remove_manual / chart_out） */
  process?: string
  fileSize?: number
  /** 操作前/后引用该文件的任务快照 */
  refBefore?: RefTask[]
  refAfter?: RefTask[]
}): void {
  const action = item.action ?? (item.status === 'removed' || item.status === 'skipped' ? 'out' : 'in')
  getDb()
    .prepare(
      `INSERT INTO history_item (batchId, taskId, songKey, songName, singer, status, quality, filePath, errorReason, detail,
                                 action, process, fileSize, refBefore, refAfter)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      item.detail?.length ? JSON.stringify(item.detail) : null,
      action,
      item.process ?? null,
      item.fileSize ?? null,
      item.refBefore?.length ? JSON.stringify(item.refBefore) : null,
      item.refAfter?.length ? JSON.stringify(item.refAfter) : null,
    )
}

/**
 * 删除历史明细行（勾选「历史记录」时用）。
 * 批次被删空则批次行一并消失——否则列表上会留一个"0 成功 0 失败"的空壳。
 * 返回实际删除的 明细数 / 批次壳数。
 */
export function deleteHistoryItems(ids: number[]): { items: number; batches: number } {
  if (!ids.length) return { items: 0, batches: 0 }
  const db = getDb()
  return db.transaction((list: number[]) => {
    const ph = list.map(() => '?').join(',')
    const batchIds = (db.prepare(`SELECT DISTINCT batchId FROM history_item WHERE id IN (${ph})`).all(...list) as { batchId: number }[]).map((x) => x.batchId)
    const items = db.prepare(`DELETE FROM history_item WHERE id IN (${ph})`).run(...list).changes
    let batches = 0
    for (const b of batchIds) {
      const left = db.prepare('SELECT COUNT(*) AS n FROM history_item WHERE batchId = ?').get(b) as { n: number }
      if (left.n === 0) batches += db.prepare('DELETE FROM history_batch WHERE id = ?').run(b).changes
    }
    return { items, batches }
  })(ids)
}

/** 某批次的历史明细 id（历史页勾"整批"时服务端展开用） */
export function listHistoryItemIdsByBatch(batchId: number): number[] {
  return (getDb().prepare('SELECT id FROM history_item WHERE batchId = ?').all(batchId) as { id: number }[]).map((r) => r.id)
}

/** 删除批次行本身（明细已删光的空壳；明细由 deleteHistoryItems 负责） */
export function deleteHistoryBatches(ids: number[]): number {
  if (!ids.length) return 0
  const db = getDb()
  const ph = ids.map(() => '?').join(',')
  return db.prepare(`DELETE FROM history_batch WHERE id IN (${ph})`).run(...ids).changes
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
  if (existing) {
    // 同档重下（原文件被删后再次下载）→ 更新路径/文件名/大小，
    // 否则登记里还是旧路径，下次又会判定"文件不在"而反复重下
    getDb()
      .prepare('UPDATE song_files SET fileName = ?, filePath = ?, size = ? WHERE id = ?')
      .run(input.fileName, input.filePath, input.size ?? null, existing.id)
    return existing.id
  }
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

/** 文件当前被哪些任务引用（手动删文件的引用保护要按"谁在用"判断，不能只看数量） */
export function fileRefTasks(fileId: number): number[] {
  const rows = getDb().prepare('SELECT DISTINCT taskId FROM task_song_ref WHERE fileId = ?').all(fileId) as { taskId: number }[]
  return rows.map((r) => r.taskId)
}

/** 抹掉一个文件记录：引用 + 登记（手动删文件 → 移入回收站之后调用） */
export function removeFileRecord(fileId: number): void {
  getDb().transaction((id: number) => {
    getDb().prepare('DELETE FROM task_song_ref WHERE fileId = ?').run(id)
    getDb().prepare('DELETE FROM song_files WHERE id = ?').run(id)
  })(fileId)
}

/** 文件当前被哪些任务引用 */
export function fileRefCount(fileId: number): number {
  const r = getDb().prepare('SELECT COUNT(*) AS n FROM task_song_ref WHERE fileId = ?').get(fileId) as { n: number }
  return r.n
}

/** 本任务持有文件引用的全部歌曲（"删除任务"时 文件/歌单 两个选项的作用范围） */
export function listTaskSongKeys(taskId: number): string[] {
  return (getDb().prepare('SELECT DISTINCT songKey FROM task_song_ref WHERE taskId = ?').all(taskId) as { songKey: string }[]).map((r) => r.songKey)
}

/** 本任务的全部历史明细 id（"删除任务"勾选历史记录时用） */
export function listHistoryItemIds(taskId: number): number[] {
  return (getDb().prepare('SELECT id FROM history_item WHERE taskId = ?').all(taskId) as { id: number }[]).map((r) => r.id)
}

/** 各批次的历史明细条数（历史页批次勾选框要显示"整批 N 首"） */
export function historyItemCounts(): Record<number, number> {
  const rows = getDb().prepare('SELECT batchId, COUNT(*) AS n FROM history_item GROUP BY batchId').all() as { batchId: number; n: number }[]
  const out: Record<number, number> = {}
  for (const r of rows) out[r.batchId] = r.n
  return out
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

/**
 * 把某首歌从「同步基准」里摘掉：删除文件后调用。
 *
 * 为什么必须做：增量模式按 current_song_status=success 跳过、镜像模式按快照跳过，
 * **两条路都不看文件在不在磁盘上**。所以只删文件不清基准的话，这首歌会永远不再下载
 * （歌单里没有、文件也没了）——与「删掉文件，下次同步会重新下载」的承诺相矛盾。
 * 摘掉之后它就是个"新歌"，下次同步重新走下载→入库→入歌单。
 *
 * 顺带清掉该歌在本任务的状态行（引用/状态重建由下次运行自然完成）。
 */
export function dropSongFromBaseline(songKey: string): number {
  const db = getDb()
  let n = 0
  // playlist_snapshot 主键是 taskId；chart_snapshot 是自增 id
  const strip = (table: 'playlist_snapshot' | 'chart_snapshot', keyCol: 'taskId' | 'id') => {
    const del = db.prepare(`DELETE FROM ${table} WHERE ${keyCol} = ?`)
    const upd = db.prepare(`UPDATE ${table} SET songKeys = ? WHERE ${keyCol} = ?`)
    for (const r of db.prepare(`SELECT ${keyCol} AS k, songKeys FROM ${table}`).all() as { k: number; songKeys: string }[]) {
      let arr: string[]
      try {
        arr = JSON.parse(r.songKeys)
      } catch {
        continue
      }
      if (!Array.isArray(arr) || !arr.includes(songKey)) continue
      const next = arr.filter((k) => k !== songKey)
      if (next.length) upd.run(JSON.stringify(next), r.k)
      else del.run(r.k) // 快照空了 = 从没同步过 → 下次全量，正是我们要的
      n++
    }
  }
  strip('playlist_snapshot', 'taskId')
  strip('chart_snapshot', 'id')
  db.prepare('DELETE FROM current_song_status WHERE songKey = ?').run(songKey)
  return n
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
