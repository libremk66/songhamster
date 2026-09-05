import { readdirSync, statSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { AppConfig, Quality } from '../config.js'
import { QUALITY_ORDER, QUALITY_LABELS } from '../config.js'
import type { LxServerAdapter } from '../adapters/lxserver.js'
import { probeAudio } from './probe.js'
import { matchScore, type MatchTarget } from './matching.js'
import type { LxSong } from '../adapters/lxserver.js'
import { renderFilename } from './file-manager.js'
import { logger } from './logger.js'
import { getDb } from '../store/db.js'

/** 扫描发现的低码率文件 */
export interface LowQualityFile {
  filePath: string
  fileName: string
  title: string
  artist?: string
  probe: ReturnType<typeof probeAudio>
  /** 匹配结果 */
  matchScore?: number
  /** 处理结果 */
  result?: UpgradeResult
}

export type UpgradeStatus = 'success' | 'no_candidate' | 'has_higher' | 'failed' | 'skipped'
export interface UpgradeResult {
  status: UpgradeStatus
  newQuality?: string
  newPath?: string
  newSize?: number
  score?: number
  reason?: string
}

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav', '.ape', '.wma'])

/** 递归收集目录下音频文件 */
function collectAudioFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    let entries: string[] = []
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(d, e)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full)
      else if (AUDIO_EXTS.has(path.extname(e).toLowerCase())) out.push(full)
    }
  }
  walk(dir)
  return out
}

/**
 * 从文件名启发式解析 歌名/歌手（兼容两类命名模板）：
 * ① 本项目模板：[歌手] - [歌曲名] ([音质]).ext
 * ② lxserver 老模板：歌名 - 歌手 - <音质> - <专辑>.ext
 */
export function parseFileName(fileName: string): { title: string; artist?: string } {
  let base = fileName.replace(/\.(mp3|flac|m4a|aac|ogg|wav|ape|wma)$/i, '')
  // ① [音质] 括号后缀 → 歌手 - 歌曲名
  const m1 = base.match(/^(.*?)\s*-\s*(.*?)\s*\((?:flac24bit|flac|master|hires|atmos|320k|128k|192k)\)$/i)
  if (m1) {
    return { artist: m1[1].trim(), title: m1[2].trim() }
  }
  // ② lxserver 默认：歌名 - 歌手 - 音质 - 专辑（音质在第二三段）
  const parts = base.split(' - ')
  if (parts.length >= 3) {
    // parts[1] 是歌手位置？lxserver 模板 = "<name> - <singer> - <quality>..." → title=parts[0] artist=parts[1]
    const qIdx = parts.findIndex((p) => /^(128k|320k|flac24bit|flac|master|hires|atmos|192k)$/i.test(p.trim()))
    if (qIdx >= 2) {
      return { title: parts[0].trim(), artist: parts[1].trim() }
    }
  }
  // 兜底：去掉音质标记后按最后两个 " - " 段切
  base = base.replace(/\s*-\s*(flac24bit|flac|master|hires|atmos|320k|128k)\s*$/i, '')
  const last = base.split(' - ')
  if (last.length >= 2) {
    return { artist: last[0].trim(), title: last.slice(1).join(' - ').trim() }
  }
  return { title: base.trim() }
}

/** "04:36" → 秒 */
function parseDuration(interval?: string): number | undefined {
  if (!interval) return undefined
  const m = interval.trim().match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/)
  if (!m) return undefined
  return Number(m[1]) * 60 + Number(m[2])
}

export function isLowQuality(probe: ReturnType<typeof probeAudio>, thresholdKbps: number): boolean {
  // 无损格式（flac/m4a 无损等）不按码率阈值洗版——只针对有损低码率
  if (probe.format === 'flac') return false
  if (probe.estimate && probe.bitrateKbps === 0) return true // 无法判定 → 视为待确认低质（保守处理不洗？这里判定为待洗由匹配把关）
  return probe.bitrateKbps < thresholdKbps && probe.bitrateKbps > 0
}

/** 步骤1：扫描目录 → 低码率文件清单 */
export function scanLowQuality(scanDir: string, thresholdKbps: number): LowQualityFile[] {
  if (!scanDir || !existsSync(scanDir)) throw new Error(`扫描目录不存在: ${scanDir}`)
  const files = collectAudioFiles(scanDir)
  const out: LowQualityFile[] = []
  for (const f of files) {
    const probe = probeAudio(f)
    if (!isLowQuality(probe, thresholdKbps)) continue
    const { title, artist } = parseFileName(path.basename(f))
    out.push({ filePath: f, fileName: path.basename(f), title, artist, probe })
  }
  return out
}

/** 步骤2+3：低码率文件 → LX 搜索候选（跨平台）→ 190 分匹配 → 最佳候选（保留完整 LxSong） */
export async function findBestCandidate(
  lx: LxServerAdapter,
  item: LowQualityFile,
  maxDurDiffSec: number,
): Promise<{ song: LxSong; score: number } | null> {
  if (!item.title) return null
  const sources = ['kw', 'kg', 'tx', 'wy', 'mg']
  const results = await lx.searchSong(item.title, sources)
  if (!results.length) return null

  const target: MatchTarget = {
    title: item.title,
    artist: item.artist,
    durationSec: Math.round(item.probe.durationSec * 10) / 10 || undefined,
  }
  let best: LxSong | null = null
  let bestScore = 0
  for (const s of results) {
    const sc = matchScore(target, { title: s.name, artist: s.singer, durationSec: parseDuration(s.interval) }, maxDurDiffSec)
    if (sc.passed && sc.score > bestScore) {
      bestScore = sc.score
      best = s
    }
  }
  return best ? { song: best, score: bestScore } : null
}

/**
 * 步骤4：确认后自动下载到独立输出目录（不动旧文件）
 * 目标音质：勾选链 ∩ 候选 types，从 minQuality 起逐档尝试
 */
export async function upgradeOne(
  cfg: AppConfig,
  lx: LxServerAdapter,
  item: LowQualityFile,
  song: LxSong,
  score: number,
  outputDir: string,
  minQuality: Quality,
): Promise<UpgradeResult> {
  // 目标链：勾选档 ∩ 候选可用档，从 minQuality 起（含更高档：master→…→minQuality 段过滤勾选）
  const upTo = QUALITY_ORDER.slice(0, QUALITY_ORDER.indexOf(minQuality) + 1)
  const wanted = upTo.filter((q) => cfg.download.qualities.includes(q))
  const candQs = song.qualities.filter((q) => QUALITY_ORDER.includes(q))
  const tryChain = wanted.filter((q) => candQs.includes(q))
  if (!tryChain.length) return { status: 'no_candidate', score, reason: '候选无满足规则的高音质' }

  // 输出目录已有该歌目标音质 → 跳过
  const outBase = path.join(outputDir, `${item.artist ? item.artist + ' - ' : ''}${item.title}`)
  if (tryChain.some((q) => existsSync(`${outBase} (${q}).flac`))) {
    return { status: 'has_higher', score, reason: '输出目录已有高音质版本' }
  }

  for (const quality of tryChain) {
    logger.info(`[upgrade] ${item.title} [${quality}] 下载中`)
    try {
      const { url } = await lx.resolveUrl(song, quality)
      await lx.requestDownload(song, url, quality, {
        embedLyric: cfg.download.embedLyric,
        cacheLyric: cfg.download.cacheLyric,
      })
      const file = await lx.waitForFile(song, quality)
      if (!file) continue
      mkdirSync(outputDir, { recursive: true })
      const srcPath = path.join(cfg.lxserver.downloadRoot, file.filename)
      if (!existsSync(srcPath)) continue
      const destName = renderFilename('[歌手] - [歌曲名] ([音质])', song, quality)
      const destPath = path.join(outputDir, destName + (path.extname(file.filename) || '.flac'))
      if (existsSync(destPath)) rmSync(destPath, { force: true })
      renameSync(srcPath, destPath)
      const srcLrc = srcPath.slice(0, -path.extname(srcPath).length) + '.lrc'
      if (cfg.download.embedLyric && existsSync(srcLrc)) {
        try {
          renameSync(srcLrc, destPath.slice(0, -path.extname(destPath).length) + '.lrc')
        } catch { /* 忽略 */ }
      }
      logger.info(`[upgrade] ✅ ${item.title} 已洗版 → ${destPath}`)
      return { status: 'success', newQuality: quality, newPath: destPath, newSize: statSync(destPath).size, score }
    } catch (e) {
      logger.warn(`[upgrade] ${item.title} [${quality}] 失败: ${(e as Error).message}`)
    }
  }
  return { status: 'failed', score, reason: '下载失败（已尝试全部可用音质）' }
}

/** 记录洗版历史 */
export function recordUpgrade(
  item: LowQualityFile,
  result: UpgradeResult,
  minQuality: Quality,
): void {
  // 成功时补充新版真实时长（探测新文件）
  let newDur: number | null = null
  if (result.status === 'success' && result.newPath) {
    try {
      newDur = Math.round(probeAudio(result.newPath).durationSec) || null
    } catch { /* 忽略 */ }
  }
  getDb()
    .prepare(
      `INSERT INTO upgrade_history (createdAt, songName, singer, matchScore, status,
        oldQuality, oldBitrate, oldDurationSec, oldPath, oldSize,
        newQuality, newDurationSec, newPath, newSize, errorReason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      item.title,
      item.artist ?? null,
      result.score ?? null,
      result.status,
      (item.probe.estimate ? '~' : '') + item.probe.bitrateKbps + 'kbps ' + item.probe.format,
      item.probe.bitrateKbps,
      Math.round(item.probe.durationSec) || null,
      item.filePath,
      item.probe.size,
      result.newQuality ?? null,
      null,
      result.newPath ?? null,
      result.newSize ?? null,
      result.reason ?? null,
    )
}
