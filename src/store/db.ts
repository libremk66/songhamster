import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DB_PATH } from '../config.js'

export type SyncMode = 'incremental' | 'full'
export type SongStatus = 'success' | 'failed' | 'unsatisfied' | 'removed' | 'skipped_dup' | 'dedup'
export type BatchResult = 'success' | 'partial' | 'failed'

export interface SyncTaskRow {
  id: number
  lxPlaylistKey: string
  lxPlaylistName: string
  enabled: number
  embyTargetPlaylistIds: string // JSON array
  createSameNamePlaylist: number
  cronExpr: string | null
  syncMode: SyncMode
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
      enabled INTEGER NOT NULL DEFAULT 1,
      embyTargetPlaylistIds TEXT NOT NULL DEFAULT '[]',
      createSameNamePlaylist INTEGER NOT NULL DEFAULT 1,
      cronExpr TEXT,
      syncMode TEXT NOT NULL DEFAULT 'incremental',
      lastRunAt TEXT,
      lastResult TEXT,
      dedupCheck INTEGER NOT NULL DEFAULT 0,
      dedupMinQuality TEXT
    );

    CREATE TABLE IF NOT EXISTS history_batch (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      taskId INTEGER NOT NULL REFERENCES sync_task(id),
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
  ensureCol('history_batch', 'dedupCount', 'dedupCount INTEGER NOT NULL DEFAULT 0')
}
