import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../config.js'

/**
 * 日志：内存环形（最新若干条）+ 按天落盘（重启不丢，日志页的数据源）。
 * 落盘目录 data/logs/songhamster-YYYY-MM-DD.log；启动时清理超过保留天数的旧文件。
 */
type Level = 'info' | 'warn' | 'error'
export interface LogEntry {
  ts: string
  level: Level
  msg: string
}

const RING: LogEntry[] = []
const MAX = 2000

export const LOGS_DIR = path.join(DATA_DIR, 'logs')

/** 显示用本地时间（上海） */
function nowParts(): { day: string; ts: string } {
  const iso = new Date(Date.now() + 8 * 3600_000).toISOString()
  return { day: iso.slice(0, 10), ts: iso.slice(11, 19) }
}
const fileOf = (day: string): string => path.join(LOGS_DIR, `songhamster-${day}.log`)

function push(level: Level, msg: string): void {
  const { day, ts } = nowParts()
  const entry: LogEntry = { ts: `${day.slice(5)} ${ts}`, level, msg }
  RING.push(entry)
  if (RING.length > MAX) RING.splice(0, RING.length - MAX)

  try {
    mkdirSync(LOGS_DIR, { recursive: true })
    appendFileSync(fileOf(day), `${entry.ts} [${level.toUpperCase().padEnd(5)}] ${msg}\n`, 'utf8')
  } catch {
    /* 落盘失败不影响运行（只丢文件日志） */
  }

  const line = `[${ts}] [${level}] ${msg}`
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  fn(line)
}

/** 读日志文件末尾若干行（大文件只读最后 1MB，避免整文件载入） */
function tailFile(file: string, limit: number): LogEntry[] {
  try {
    const size = statSync(file).size
    const start = Math.max(0, size - 1024 * 1024)
    const buf = readFileSync(file)
    const text = (start > 0 ? buf.subarray(start).toString('utf8').replace(/^[^\n]*\n/, '') : buf.toString('utf8'))
    const lines = text.split('\n').filter(Boolean).slice(-limit)
    return lines.map((l) => {
      const m = l.match(/^(\S+ \S+) \[(\w+)\s*\] (.*)$/)
      return m ? { ts: m[1], level: m[2].toLowerCase() as Level, msg: m[3] } : { ts: '', level: 'info' as Level, msg: l }
    })
  } catch {
    return []
  }
}

/** 日志文件列表（新→旧） */
function logFiles(): string[] {
  try {
    return readdirSync(LOGS_DIR)
      .filter((f) => /^(songhamster|songferry)-\d{4}-\d{2}-\d{2}\.log$/.test(f)) // 老前缀也认（改名前的日志仍可见）
      .sort()
      .reverse()
      .map((f) => path.join(LOGS_DIR, f))
  } catch {
    return []
  }
}

export const logger = {
  info: (msg: string) => push('info', msg),
  warn: (msg: string) => push('warn', msg),
  error: (msg: string) => push('error', msg),

  /** 倒序（最新在前）；level/q 为过滤条件，跨天回溯直到凑够 limit 条 */
  list(opts: { limit?: number; level?: string; q?: string } = {}): LogEntry[] {
    const limit = opts.limit ?? 300
    const level = (opts.level ?? '').toLowerCase()
    const q = (opts.q ?? '').trim().toLowerCase()
    const hit = (e: LogEntry) => (!level || e.level === level) && (!q || e.msg.toLowerCase().includes(q))
    const files = logFiles()
    if (!files.length) return RING.slice(-limit).reverse().filter(hit) // 还没落盘 → 退回内存
    const out: LogEntry[] = []
    for (const f of files) {
      const rows = tailFile(f, 4000)
      for (let i = rows.length - 1; i >= 0; i--) {
        if (hit(rows[i])) out.push(rows[i])
        if (out.length >= limit) return out
      }
    }
    return out
  },

  /** 清理超过保留天数的日志文件（启动时调用）；返回删除数 */
  cleanup(retentionDays: number): number {
    const days = Math.max(1, retentionDays || 30)
    const cutoff = new Date(Date.now() + 8 * 3600_000 - days * 86400_000).toISOString().slice(0, 10)
    let n = 0
    for (const f of logFiles()) {
      const day = path.basename(f).replace(/^(songhamster|songferry)-/, '').replace(/\.log$/, '')
      if (day < cutoff) {
        try {
          unlinkSync(f)
          n++
        } catch { /* 忽略 */ }
      }
    }
    return n
  },
}
