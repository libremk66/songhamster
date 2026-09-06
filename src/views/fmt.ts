/** 时间展示工具：DB 存 UTC ISO（new Date().toISOString()），展示统一转 Asia/Shanghai（UTC+8，无夏令时） */
export function fmtLocal(iso: string | null | undefined, withSec = false): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const s = new Date(d.getTime() + 8 * 3600_000).toISOString() // 上海 = UTC+8
  return withSec ? s.slice(5, 19).replace('T', ' ') : s.slice(5, 16).replace('T', ' ')
}
