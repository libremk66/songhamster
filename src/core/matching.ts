/**
 * 190 分匹配算法（对齐 LxBridge）
 * 歌名 100：完全一致 +100 ｜ 一方包含另一方 +60
 * 歌手 60：完全一致 +60 ｜ 一方包含另一方 +35
 * 时长 30：完全一致 +30 ｜ 每差 1 秒扣 1 分，最低 0
 * 满分 190。有歌手信息需 ≥130，无歌手需 ≥90；
 * 超过 maxDurDiffSec 直接排除；同分优先时长差更小。
 * 格式/容量/码率/目标音质不参与匹配分。
 */

export interface MatchTarget {
  title: string
  artist?: string
  durationSec?: number
}

export interface MatchCandidate extends MatchTarget {
  /** 候选标识（如 songKey） */
  key?: string
}

export interface MatchScore {
  score: number
  /** 满分 190 */
  max: number
  titleScore: number
  artistScore: number
  durationScore: number
  durDiffSec: number
  passed: boolean
}

function norm(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[（(【\[].*?[）)】\]]/g, '') // 去掉括号内容（Live/翻唱等变体标记）
    .replace(/\s+/g, '')
    .toLowerCase()
}

function scoreComponent(a: string, b: string, exact: number, contains: number): number {
  const na = norm(a)
  const nb = norm(b)
  if (!na || !nb) return 0
  if (na === nb) return exact
  if (na.includes(nb) || nb.includes(na)) return contains
  return 0
}

export function matchScore(target: MatchTarget, candidate: MatchCandidate, maxDurDiffSec: number): MatchScore {
  const titleScore = scoreComponent(target.title, candidate.title, 100, 60)
  const artistScore = target.artist ? scoreComponent(target.artist, candidate.artist ?? '', 60, 35) : 0

  let durationScore = 0
  let durDiffSec = 0
  if (target.durationSec && candidate.durationSec) {
    durDiffSec = Math.abs(target.durationSec - candidate.durationSec)
    if (durDiffSec <= maxDurDiffSec) {
      durationScore = Math.max(0, 30 - Math.floor(durDiffSec))
    } else {
      // 超误差直接排除
      return { score: 0, max: 190, titleScore, artistScore, durationScore, durDiffSec, passed: false }
    }
  }

  const score = titleScore + artistScore + durationScore
  const threshold = target.artist ? 130 : 90
  // 时长差作为隐性门槛：超过误差即使歌名歌手满也排除（上面已 return）
  const passed = score >= threshold && titleScore >= 60
  return { score, max: 190, titleScore, artistScore, durationScore, durDiffSec, passed }
}

/** 候选排序：分数高优先；同分时长差小优先 */
export function pickBest(
  target: MatchTarget,
  candidates: MatchCandidate[],
  maxDurDiffSec: number,
): { best?: MatchCandidate; score?: MatchScore; ranked: { c: MatchCandidate; s: MatchScore }[] } {
  const ranked = candidates
    .map((c) => ({ c, s: matchScore(target, c, maxDurDiffSec) }))
    .filter((r) => r.s.passed)
    .sort((a, b) => b.s.score - a.s.score || a.s.durDiffSec - b.s.durDiffSec)
  return { best: ranked[0]?.c, score: ranked[0]?.s, ranked }
}
