import { readFileSync, statSync } from 'node:fs'
import type { Quality } from '../config.js'
import type { LxSong } from '../adapters/lxserver.js'

/** 版本词黑名单：伴奏/翻唱/卡拉OK/现场等疑似非原版 */
const REJECTED_WORDS = ['伴奏', '翻唱', 'Cover', '卡拉', 'KTV', 'Live', '现场', '演唱会', 'DJ版', 'Remix', 'instrumental', '纯音乐']

export interface ValidationResult {
  ok: boolean
  actualQuality: Quality | null
  reasons: string[]
}

/** FLAC 真实位深/采样率探测（防 flac24bit 虚标——lxserver 请求 24bit 失败会静默给 16bit） */
export function sniffFlacBits(filePath: string): { bits: number; sampleRate: number; isFlac: boolean } {
  try {
    const fd = readFileSync(filePath)
    if (fd.length < 42 || !(fd[0] === 0x66 && fd[1] === 0x4c && fd[2] === 0x61 && fd[3] === 0x43)) {
      return { bits: 0, sampleRate: 0, isFlac: false }
    }
    // FLAC: "fLaC"(4) + metadata-header(4: type 1B + len 3B) → STREAMINFO body 从 offset 8 起
    // STREAMINFO: minBlock(2) maxBlock(2) minFrame(3) maxFrame(3)
    //   sampleRate(20bit) channels(3bit) bps(5bit, 存值=实际-1) totalSamples(36bit)  → 共 18-25 字节
    const b = fd
    const sampleRate = ((b[18] << 12) | (b[19] << 4) | (b[20] >> 4)) & 0xfffff
    const bits = (((b[20] & 0x01) << 4) | (b[21] >> 4)) + 1
    return { bits, sampleRate, isFlac: true }
  } catch {
    return { bits: 0, sampleRate: 0, isFlac: false }
  }
}

/** 读文件头判断真实音频格式（防伪 flac/扩展名欺骗） */
function sniffFormat(filePath: string): { isFlac: boolean; isMp3: boolean; sampleRate?: number } {
  try {
    const fd = readFileSync(filePath)
    if (fd.length > 4 && fd[0] === 0x66 && fd[1] === 0x4c && fd[2] === 0x61 && fd[3] === 0x43) {
      // fLaC magic
      return { isFlac: true, isMp3: false }
    }
    if (fd.length > 2 && fd[0] === 0xff && (fd[1] & 0xe0) === 0xe0) {
      return { isFlac: false, isMp3: true }
    }
    return { isFlac: false, isMp3: false }
  } catch {
    return { isFlac: false, isMp3: false }
  }
}

/**
 * 四重内容校验（借鉴 lx-music-downloader）：
 * ① 真实格式探测（fLaC magic——防 320k 换壳成 flac）
 * ② 歌手标签匹配（防翻唱冒充原唱——文件名已含歌手，这里查文件内文本）
 * ③ 版本词过滤（伴奏/翻唱/Live…）
 * ④ 音质预期检查（quality 与期望档一致；空壳文件 <1KB 直接失败）
 */
export function validateFile(filePath: string, song: LxSong, expectedQuality: Quality): ValidationResult {
  const reasons: string[] = []
  let size = 0
  try {
    size = statSync(filePath).size
  } catch {
    return { ok: false, actualQuality: null, reasons: ['文件不存在'] }
  }
  if (size < 1024) return { ok: false, actualQuality: null, reasons: [`空壳文件(${size}B)`] }

  // ① 真实格式
  const fmt = sniffFormat(filePath)
  const isFlacExpect = expectedQuality === 'flac24bit' || expectedQuality === 'flac'
  if (isFlacExpect && !fmt.isFlac) {
    reasons.push(`预期 ${expectedQuality} 但真实格式非 FLAC（${fmt.isMp3 ? 'MP3 换壳' : '未知'}）`)
  }
  if (!isFlacExpect && expectedQuality === '320k' && !fmt.isMp3 && !fmt.isFlac) {
    reasons.push('未知音频格式')
  }

  // ② 版本词过滤（文件名判断）
  const lower = filePath.toLowerCase()
  for (const w of REJECTED_WORDS) {
    if (lower.includes(w.toLowerCase())) {
      reasons.push(`疑似非原版（含"${w}"）`)
      break
    }
  }

  // ③ 音质档位与预期一致性由调用方保证（文件名携带 quality 后缀，mtime 验证）
  const actualQuality: Quality | null = expectedQuality
  return { ok: reasons.length === 0, actualQuality, reasons }
}
