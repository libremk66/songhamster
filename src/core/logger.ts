/** 简易内存环形日志（日志页数据源；同时输出到 stdout） */
type Level = 'info' | 'warn' | 'error'
interface LogEntry {
  ts: string
  level: Level
  msg: string
}

const RING: LogEntry[] = []
const MAX = 500

function push(level: Level, msg: string): void {
  // 显示用本地时间（上海）；存储/排序无关紧要（环形内存日志）
  const ts = new Date(new Date().getTime() + 8 * 3600_000).toISOString().slice(11, 19)
  const entry: LogEntry = { ts, level, msg }
  RING.push(entry)
  if (RING.length > MAX) RING.splice(0, RING.length - MAX)
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  fn(`[${entry.ts}] [${level}] ${msg}`)
}

export const logger = {
  info: (msg: string) => push('info', msg),
  warn: (msg: string) => push('warn', msg),
  error: (msg: string) => push('error', msg),
  /** 倒序（最新在前） */
  list(limit = 200): LogEntry[] {
    return RING.slice(-limit).reverse()
  },
}
