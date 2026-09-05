import { QUALITY_ORDER } from '../config.js'
import type { EmbyAdapter } from '../adapters/emby.js'

/** 库内歌曲条目（扫描结果） */
export interface DupeItem {
  id: string
  name: string
  artist: string
  path: string
  quality: string | null
  size: number
}

/** 重复组 */
export interface DupeGroup {
  key: string
  name: string
  artist: string
  items: DupeItem[] // 音质从高到低排序
}

export function qualityRank(q: string | null): number {
  if (!q) return -1
  const i = QUALITY_ORDER.indexOf(q as (typeof QUALITY_ORDER)[number])
  return i >= 0 ? i : -1
}

function norm(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
}

/** 扫描所选媒体库 → 返回重复组（同名同歌手 ≥2 份）
 * mode: per=每个库独立查重（跨库同名不算重复）；merged=多库合并查重（跨库同名也算） */
export async function scanDuplicates(
  emby: EmbyAdapter,
  libraryIds: string[],
  mode: 'per' | 'merged' = 'merged',
): Promise<{ groups: DupeGroup[]; scannedCount: number; scannedLibraries: string[] }> {
  const buckets = new Map<string, DupeItem[]>()
  const scannedLibraries: string[] = []
  let scannedCount = 0
  // per 模式：每组增加库维度 key；merged 模式：库维度不区分
  for (const libId of libraryIds) {
    const songs = await emby.listLibrarySongs(libId)
    scannedLibraries.push(libId)
    scannedCount += songs.length
    for (const s of songs) {
      if (!s.name) continue
      const artist = (s.artists ?? []).join('/') || ''
      const base = `${norm(s.name)}|${norm(artist)}`
      const key = mode === 'per' ? `${libId}|${base}` : base
      const list = buckets.get(key) ?? []
      list.push({ id: s.id, name: s.name, artist, path: s.path, quality: s.quality, size: s.size })
      buckets.set(key, list)
    }
  }
  const groups: DupeGroup[] = []
  for (const [key, items] of buckets) {
    if (items.length < 2) continue
    items.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))
    groups.push({ key, name: items[0].name, artist: items[0].artist, items })
  }
  // 按 歌曲名 排序便于浏览
  groups.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return { groups, scannedCount, scannedLibraries }
}

export interface CleanupPlan {
  /** 保留项（每组最高音质那份） */
  keep: DupeItem[]
  /** 自动清理候选 */
  autoDeletable: DupeItem[]
  /** 其余重复副本（不自动清理）——仅手动删除 */
  manualCandidates: DupeItem[]
  /** 被自动策略跳过的组（安全底线：整组音质均低于门槛 → 不删） */
  skippedGroups: number
}

/**
 * 生成清理计划
 * mode: off=仅查重；quality=按音质门槛清理；single=每组仅保留最高一份（同音质副本也清）
 * 安全规则：整组最高音质低于门槛时该组不自动删（避免删光唯一低质版本）——列 manual 并提示
 */
export function planCleanup(groups: DupeGroup[], mode: 'off' | 'quality' | 'single', thresholdQ: string | null): CleanupPlan {
  const keep: DupeItem[] = []
  const autoDeletable: DupeItem[] = []
  const manualCandidates: DupeItem[] = []
  let skippedGroups = 0
  const thRank = thresholdQ ? qualityRank(thresholdQ) : -1

  for (const g of groups) {
    const top = g.items[0]
    const topRank = qualityRank(top.quality)
    keep.push(top)
    const rest = g.items.slice(1)
    if (mode === 'single') {
      // 每组仅留最高一份；同音质重复副本也清理（最高那份始终保留，安全）
      autoDeletable.push(...rest)
    } else if (mode === 'quality' && thresholdQ && topRank >= thRank && thRank >= 0) {
      for (const it of rest) {
        if (qualityRank(it.quality) < thRank) autoDeletable.push(it)
        else manualCandidates.push(it)
      }
    } else {
      if (mode === 'quality' && thresholdQ && topRank < thRank) skippedGroups++
      manualCandidates.push(...rest)
    }
  }
  return { keep, autoDeletable, manualCandidates, skippedGroups }
}
