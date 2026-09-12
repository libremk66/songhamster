import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DB_PATH } from '../config.js'
import type { DelPolicy, TaskMode } from '../config.js'

export type SyncMode = 'incremental' | 'full' // 旧列(兼容);新语义见 mode/taskSemantics
export type SongStatus = 'success' | 'failed' | 'unsatisfied' | 'removed' | 'skipped_dup' | 'dedup'
export type BatchResult = 'success' | 'partial' | 'failed'

/** 旧 full 在新语义下的映射(mirror+keep)——读取任务时统一走这里 */
export function taskSemantics(t: { mode?: TaskMode | null; syncMode?: SyncMode | null; delPolicy?: DelPolicy | null }) {
  return {
    taskMode: (t.mode ?? (t.syncMode === 'full' ? 'mirror' : 'incremental')) as TaskMode,
    delPolicy: (t.delPolicy ?? 'keep') as DelPolicy,
  }
}

export interface SyncTaskRow {
  id: number
  lxPlaylistKey: string
  lxPlaylistName: string
  taskType: 'playlist' | 'chart' | 'adhoc'
  chartSource: string | null
  chartId: string | null
  chartName: string | null
  maxCount: number
  enabled: number
  embyTargetPlaylistIds: string // JSON array
  createSameNamePlaylist: number
  cronExpr: string | null
  syncMode: SyncMode
  /** 新语义同步方式:null=旧任务(按 syncMode 映射:full→mirror) */
  mode: TaskMode | null
  /** 镜像删除策略 */
  delPolicy: DelPolicy
  /** 归档歌单名(delPolicy=archive 时用) */
  archivePlaylist: string | null
  /** 任务来源:manual | auto-all | auto-filtered(监听自动创建分组/切换策略用) */
  origin: string
  lastRunAt: string | null
  lastResult: string | null
  dedupCheck: number
  dedupMinQuality: string | null
}

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db
  mkdirSync(path.dirname(DB_PATH), { recursive: true })
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS sync_task (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lxPlaylistKey TEXT NOT NULL UNIQUE,
      lxPlaylistName TEXT NOT NULL,
      taskType TEXT NOT NULL DEFAULT 'playlist',   -- playlist=LX歌单 | chart=榜单订阅
      chartSource TEXT,                             -- 榜单平台 kw/tx/wy/kg/mg/bd
      chartId TEXT,                                 -- lxserver bangid
      chartName TEXT,                               -- 榜单原名（快照，如 热歌榜）
      maxCount INTEGER NOT NULL DEFAULT 30,         -- 订阅范围：榜单前 N 首（0=全榜）
      enabled INTEGER NOT NULL DEFAULT 1,
      embyTargetPlaylistIds TEXT NOT NULL DEFAULT '[]',
      createSameNamePlaylist INTEGER NOT NULL DEFAULT 1,
      cronExpr TEXT,
      syncMode TEXT NOT NULL DEFAULT 'incremental',
      mode TEXT,                                -- 新语义:incremental|mirror(null=旧任务按 syncMode 映射)
      delPolicy TEXT NOT NULL DEFAULT 'keep',   -- 镜像删除策略 keep|delete|archive
      archivePlaylist TEXT,                     -- 归档歌单名
      origin TEXT NOT NULL DEFAULT 'manual',    -- manual|auto-all|auto-filtered
      lastRunAt TEXT,
      lastResult TEXT,
      dedupCheck INTEGER NOT NULL DEFAULT 0,
      dedupMinQuality TEXT
    );

    CREATE TABLE IF NOT EXISTS chart_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      taskId INTEGER NOT NULL REFERENCES sync_task(id),
      syncedAt TEXT NOT NULL,
      totalCount INTEGER NOT NULL DEFAULT 0,
      newCount INTEGER NOT NULL DEFAULT 0,
      removedCount INTEGER NOT NULL DEFAULT 0,
      songKeys TEXT NOT NULL DEFAULT '[]'     -- 当期榜单（前 N 范围）songKey 全集 JSON
    );

    CREATE TABLE IF NOT EXISTS history_batch (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- ⚠️ 故意不加 REFERENCES sync_task(id)：删除任务时可以「保留历史」，
      -- 任务没了历史还在 → 名称/类型随批次快照一份（见 createBatch）
      taskId INTEGER NOT NULL,
      taskName TEXT,
      taskType TEXT,
      trigger TEXT NOT NULL,             -- 'cron' | 'manual' | 'retry'
      startedAt TEXT NOT NULL,
      finishedAt TEXT,
      result TEXT,                        -- success/partial/failed
      okCount INTEGER NOT NULL DEFAULT 0,
      failCount INTEGER NOT NULL DEFAULT 0,
      unsatisfiedCount INTEGER NOT NULL DEFAULT 0,
      removedCount INTEGER NOT NULL DEFAULT 0,
      dupCount INTEGER NOT NULL DEFAULT 0,
      dedupCount INTEGER NOT NULL DEFAULT 0,
      detail TEXT
    );

    CREATE TABLE IF NOT EXISTS history_item (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batchId INTEGER NOT NULL REFERENCES history_batch(id),
      taskId INTEGER NOT NULL,
      songKey TEXT NOT NULL,
      songName TEXT,
      singer TEXT,
      status TEXT NOT NULL,               -- success/failed/unsatisfied/removed/skipped_dup
      quality TEXT,
      filePath TEXT,
      errorReason TEXT,
      retriedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_history_item_batch ON history_item(batchId);

    CREATE TABLE IF NOT EXISTS current_song_status (
      taskId INTEGER NOT NULL,
      songKey TEXT NOT NULL,
      songName TEXT,
      singer TEXT,
      status TEXT NOT NULL,
      quality TEXT,
      errorReason TEXT,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (taskId, songKey)
    );

    CREATE TABLE IF NOT EXISTS song_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      songKey TEXT NOT NULL,              -- 平台_songmid（去重按歌）
      quality TEXT NOT NULL,              -- 文件按 歌+音质 存
      fileName TEXT NOT NULL,
      filePath TEXT NOT NULL,
      size INTEGER,
      verifiedQuality TEXT,
      firstDownloadedAt TEXT NOT NULL,
      UNIQUE (songKey, quality)
    );

    CREATE TABLE IF NOT EXISTS task_song_ref (
      taskId INTEGER NOT NULL,
      songKey TEXT NOT NULL,
      fileId INTEGER NOT NULL REFERENCES song_files(id),
      PRIMARY KEY (taskId, songKey)
    );

    CREATE TABLE IF NOT EXISTS emby_song_map (
      songKey TEXT PRIMARY KEY,
      embySongId TEXT NOT NULL,
      lastVerifiedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playlist_snapshot (
      taskId INTEGER PRIMARY KEY REFERENCES sync_task(id),
      songKeys TEXT NOT NULL,             -- JSON array，完全同步 diff 用
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS upgrade_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      createdAt TEXT NOT NULL,
      songName TEXT,
      singer TEXT,
      matchScore INTEGER,                 -- 190 分制
      status TEXT NOT NULL,               -- success / no_candidate / has_higher / failed / skipped
      oldQuality TEXT,                    -- 旧版音质标识（如 128k / 320k / flac…）
      oldBitrate INTEGER,                 -- 旧版码率 kbps（估算时带 ~）
      oldDurationSec INTEGER,
      oldPath TEXT,
      oldSize INTEGER,
      newQuality TEXT,                    -- 新版实际音质
      newDurationSec INTEGER,
      newPath TEXT,
      newSize INTEGER,
      errorReason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_upgrade_history_created ON upgrade_history(createdAt);

    CREATE TABLE IF NOT EXISTS auth_session (
      token TEXT PRIMARY KEY,
      user TEXT NOT NULL,
      exp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dupe_scan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      createdAt TEXT NOT NULL,
      libraryIds TEXT NOT NULL,
      threshold TEXT,
      groupsCount INTEGER NOT NULL DEFAULT 0,
      autoCount INTEGER NOT NULL DEFAULT 0,
      manualCount INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL
    );
  `)
  // 老库增量迁移（SQLite 无 ADD COLUMN IF NOT EXISTS）
  const ensureCol = (table: string, col: string, ddl: string) => {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!cols.some((c) => c.name === col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
  ensureCol('sync_task', 'dedupCheck', 'dedupCheck INTEGER NOT NULL DEFAULT 0')
  ensureCol('sync_task', 'dedupMinQuality', 'dedupMinQuality TEXT')
  ensureCol('sync_task', 'mode', 'mode TEXT')
  ensureCol('sync_task', 'delPolicy', "delPolicy TEXT NOT NULL DEFAULT 'keep'")
  ensureCol('sync_task', 'archivePlaylist', 'archivePlaylist TEXT')
  ensureCol('sync_task', 'origin', "origin TEXT NOT NULL DEFAULT 'manual'")
  ensureCol('sync_task', 'taskType', "taskType TEXT NOT NULL DEFAULT 'playlist'")
  ensureCol('sync_task', 'chartSource', 'chartSource TEXT')
  ensureCol('sync_task', 'chartId', 'chartId TEXT')
  ensureCol('sync_task', 'chartName', 'chartName TEXT')
  ensureCol('sync_task', 'maxCount', 'maxCount INTEGER NOT NULL DEFAULT 30')
  ensureCol('history_batch', 'dedupCount', 'dedupCount INTEGER NOT NULL DEFAULT 0')
  rebuildHistoryBatchIfFk(d)
}

/**
 * 老库迁移：history_batch.taskId 原本带 `REFERENCES sync_task(id)`。
 * 有了「删除任务」的三个复选框（可勾可不勾「历史记录」）之后，这个外键就成了拦路虎——
 * 想保留历史就必须留着任务行，做不到。SQLite 不能原地删外键 → 整表重建（标准 12 步），
 * 顺便把任务名/类型快照进批次，任务消失后历史页仍能正确显示与分标签。
 *
 * 幂等：只有检测到旧外键定义才重建；重建期间关外键（DROP 时才不会因子表 history_item 报错）。
 */
function rebuildHistoryBatchIfFk(d: Database.Database): void {
  const row = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='history_batch'").get() as { sql: string } | undefined
  if (!row || !/REFERENCES\s+sync_task/i.test(row.sql)) return
  d.pragma('foreign_keys = OFF') // 必须在事务外设置（事务内改 pragma 无效）
  d.exec(`
    BEGIN;
    CREATE TABLE history_batch_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      taskId INTEGER NOT NULL,
      taskName TEXT,
      taskType TEXT,
      trigger TEXT NOT NULL,
      startedAt TEXT NOT NULL,
      finishedAt TEXT,
      result TEXT,
      okCount INTEGER NOT NULL DEFAULT 0,
      failCount INTEGER NOT NULL DEFAULT 0,
      unsatisfiedCount INTEGER NOT NULL DEFAULT 0,
      removedCount INTEGER NOT NULL DEFAULT 0,
      dupCount INTEGER NOT NULL DEFAULT 0,
      dedupCount INTEGER NOT NULL DEFAULT 0,
      detail TEXT
    );
    INSERT INTO history_batch_new (id, taskId, taskName, taskType, trigger, startedAt, finishedAt, result, okCount, failCount, unsatisfiedCount, removedCount, dupCount, dedupCount, detail)
      SELECT b.id, b.taskId, t.lxPlaylistName, t.taskType, b.trigger, b.startedAt, b.finishedAt, b.result, b.okCount, b.failCount, b.unsatisfiedCount, b.removedCount, b.dupCount, b.dedupCount, b.detail
      FROM history_batch b LEFT JOIN sync_task t ON t.id = b.taskId;
    DROP TABLE history_batch;
    ALTER TABLE history_batch_new RENAME TO history_batch;
    COMMIT;
  `)
  d.pragma('foreign_keys = ON')
}
