/**
 * 进度历史页的展示元数据：处理过程/状态的枚举码 → 中文标签与配色。
 *
 * 落库的是**码**（process/status），展示时才翻译成中文——
 * 以后新增类型只要在这里加一行，表结构、索引、查询都不用动。
 */

/** 处理过程：这次到底做了什么 */
export const PROCESS_LABELS: Record<string, string> = {
  download_new: '新下载入库',
  reuse_skip: '跳过下载入库',
  dedup_skip: '查重跳过入库',
  unsatisfied: '未满足未入库',
  download_fail: '下载失败',
  ingest_fail: '入库失败',
  remove_p1: '移出·处理1',
  remove_p2: '移出·处理2',
  remove_p3: '移出·处理3',
  remove_manual: '移出·手动删除',
}

/** 处理过程分组（筛选下拉里的 optgroup） */
export const PROCESS_GROUPS: { label: string; codes: string[] }[] = [
  { label: '入库', codes: ['download_new', 'reuse_skip', 'dedup_skip', 'unsatisfied', 'download_fail', 'ingest_fail'] },
  { label: '移出', codes: ['remove_p1', 'remove_p2', 'remove_p3', 'remove_manual'] },
]

export function processLabel(code?: string | null): string {
  if (!code) return '—'
  return PROCESS_LABELS[code] ?? code
}

/** 事件状态：结果列 */
export const STATUS_META: Record<string, { label: string; cls: string }> = {
  success: { label: '✅ 成功', cls: 'st-ok' },
  skipped_dup: { label: '♻️ 复用已有', cls: 'st-skip' },
  dedup: { label: '🔍 查重跳过', cls: 'st-skip' },
  removed: { label: '🗑 已移出', cls: 'st-skip' },
  unsatisfied: { label: '⏭ 未满足', cls: 'st-warn' },
  skipped: { label: '⏭ 已跳过', cls: 'st-warn' },
  failed: { label: '❌ 失败', cls: 'st-bad' },
}

export function statusMeta(s: string): { label: string; cls: string } {
  return STATUS_META[s] ?? { label: s, cls: 'st-bad' }
}

/** 任务属性（触发方式 / 模式 / 删除策略） */
export const TRIGGER_LABELS: Record<string, string> = { manual: '手动', cron: '定时', retry: '重试' }
export const MODE_LABELS: Record<string, string> = { incremental: '增量', mirror: '镜像' }
export const DELPOLICY_LABELS: Record<string, string> = { keep: '处理1', delete: '处理2', archive: '处理3' }

/** 字节 → 人类可读 */
export function fmtSize(n?: number | null): string {
  if (!n || n <= 0) return '—'
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB'
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
  return Math.round(n / 1024) + ' KB'
}

/** 删除处理（处理1/2/3）的一句话说明 */
export const DELPOLICY_DESC: Record<string, string> = {
  keep: '处理1 不删文件',
  delete: '处理2 删文件',
  archive: '处理3 归档',
}

/**
 * 任务属性：把这次运行的任务设置**逐行**列出（一行一个关键词）。
 * 全部取自批次快照——任务以后改了配置、被删了，这里仍是"当时"的样子。
 */
export function taskAttrs(b: {
  trigger?: string | null
  mode?: string | null
  delPolicy?: string | null
  archivePlaylist?: string | null
  targetPlaylists?: string | null
  playlistScopeName?: string | null
  taskType?: string | null
  maxCount?: number | null
}): string[] {
  const out: string[] = []
  out.push(TRIGGER_LABELS[b.trigger ?? ''] ?? b.trigger ?? '—')
  let targets: string[] = []
  try {
    targets = b.targetPlaylists ? (JSON.parse(b.targetPlaylists) as string[]) : []
  } catch {
    targets = []
  }
  if (targets.length) out.push('《' + targets.join('》《') + '》')
  else if (b.taskType === 'adhoc') out.push('不入歌单')
  if (b.playlistScopeName) out.push(b.playlistScopeName)
  if (b.mode) out.push(MODE_LABELS[b.mode] ?? b.mode)
  // 只有镜像模式才谈得上"从 LX 移除时怎么处理"
  if (b.mode === 'mirror' && b.delPolicy) {
    const p = DELPOLICY_LABELS[b.delPolicy] ?? b.delPolicy
    out.push(b.delPolicy === 'archive' && b.archivePlaylist ? `${p}（${b.archivePlaylist}）` : p)
  }
  if (b.taskType === 'chart') out.push(b.maxCount && b.maxCount > 0 ? `前 ${b.maxCount} 首` : '全榜')
  return out
}

/** 任务属性那一格的文字：`手动 · 增量 · →《华语》`（批次视图等单行场景用） */
export function taskAttrText(b: { trigger?: string | null; mode?: string | null; targetPlaylists?: string | null; taskType?: string | null }): string {
  const parts: string[] = []
  parts.push(TRIGGER_LABELS[b.trigger ?? ''] ?? b.trigger ?? '—')
  if (b.mode) parts.push(MODE_LABELS[b.mode] ?? b.mode)
  let targets: string[] = []
  try {
    targets = b.targetPlaylists ? (JSON.parse(b.targetPlaylists) as string[]) : []
  } catch {
    targets = []
  }
  if (targets.length) parts.push('→《' + targets.join('》《') + '》')
  else if (b.taskType === 'adhoc') parts.push('不入歌单')
  return parts.join(' · ')
}

/** 处理轨迹（JSON 数组字符串）→ 字符串数组；坏数据不炸模板 */
export function detailSteps(detail?: string | null): string[] {
  if (!detail) return []
  try {
    const a = JSON.parse(detail) as unknown
    return Array.isArray(a) ? a.map((x) => String(x)) : []
  } catch {
    return []
  }
}

/** 批次里的跳过名单 → 歌曲名数组；坏数据不炸模板 */
export function skippedNames(json?: string | null): string[] {
  if (!json) return []
  try {
    const a = JSON.parse(json) as unknown
    return Array.isArray(a) ? (a as { name?: string }[]).map((x) => String(x?.name ?? '')) : []
  } catch {
    return []
  }
}

/** 引用快照 → `无 → 本任务` / `华语 → 华语、热歌榜` */
export function refsText(refBefore?: string | null, refAfter?: string | null): string {
  const parse = (s?: string | null): string[] => {
    if (!s) return []
    try {
      return (JSON.parse(s) as { taskName: string }[]).map((r) => r.taskName)
    } catch {
      return []
    }
  }
  const a = parse(refBefore)
  const b = parse(refAfter)
  const fmt = (arr: string[]) => (arr.length ? arr.join('、') : '无')
  if (a.join() === b.join()) return fmt(a)
  return `${fmt(a)} → ${fmt(b)}`
}
