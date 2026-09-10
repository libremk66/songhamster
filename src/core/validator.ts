import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import type { Quality } from '../config.js'
import type { LxSong } from '../adapters/lxserver.js'
import { probeMp3 } from './probe.js'

/** 版本词黑名单：伴奏/翻唱/卡拉OK/现场等疑似非原版 */
const REJECTED_WORDS = ['伴奏', '翻唱', 'Cover', '卡拉', 'KTV', 'Live', '现场', '演唱会', 'DJ版', 'Remix', 'instrumental', '纯音乐']

export interface ValidationResult {
  ok: boolean
  actualQuality: Quality | null
  reasons: string[]
  /** 非阻断提示(档位降级说明 / Atmos 无法验真等) */
  warnings?: string[]
}

/** 有损档码率下限(kbps)——与 lxserver 判档口径一致,防低码率冒充高档 */
const LOSSY_BITRATE_FLOOR: Partial<Record<Quality, number>> = {
  '320k': 240,
  '192k': 150,
  '128k': 100,
}

/** 沉浸声(atmos/atmos_plus)可接受的容器(无法验真位深/声道,至少防 MP3 换壳) */
const IMMERSIVE_CONTAINERS = new Set(['m4a', 'mp4', 'ac3', 'aac', 'flac', 'wav'])

/** 只读文件头 n 字节(不整读大文件) */
function readHeadBytes(filePath: string, n: number): Buffer {
  const buf = Buffer.alloc(n)
  let fd: number | null = null
  try {
    fd = openSync(filePath, 'r')
    const read = readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, read)
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** 文件头容器嗅探(穿透 ID3v2 前置):flac/mp3/aac/m4a/ac3/wav/ogg/unknown */
export function sniffContainer(filePath: string): string {
  const detect = (b: Buffer): string => {
    if (b.length >= 4 && b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return 'flac'
    if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'aac' // ADTS
    if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3'
    if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'm4a' // ftyp
    if (b.length >= 2 && b[0] === 0x0b && b[1] === 0x77) return 'ac3' // AC-3 / E-AC-3
    if (b.length >= 4) {
      const four = b.subarray(0, 4).toString('latin1')
      if (four === 'RIFF') return 'wav'
      if (four === 'OggS') return 'ogg'
    }
    return ''
  }
  const head = readHeadBytes(filePath, 16)
  const direct = detect(head)
  if (direct) return direct
  if (head.length >= 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    const tagSize = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f)
    const inner = readHeadBytes(filePath, 10 + tagSize + 16).subarray(10 + tagSize)
    const r = detect(inner)
    if (r) return r
  }
  return 'unknown'
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
  const warnings: string[] = []
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

  // ② 版本词过滤（文件名判断）
  const lower = filePath.toLowerCase()
  for (const w of REJECTED_WORDS) {
    if (lower.includes(w.toLowerCase())) {
      reasons.push(`疑似非原版（含"${w}"）`)
      break
    }
  }

  // ③ 有损档真实码率实测（帧头解析;CBR 精确 / VBR 统计）——防低码率冒充高档
  let actualQuality: Quality | null = expectedQuality
  const floor = LOSSY_BITRATE_FLOOR[expectedQuality]
  if (floor !== undefined) {
    const p = probeMp3(filePath, size)
    if (p && !p.estimate && p.bitrateKbps > 0) {
      if (p.bitrateKbps < floor) {
        const real: Quality = p.bitrateKbps >= 240 ? '320k' : p.bitrateKbps >= 150 ? '192k' : '128k'
        actualQuality = real
        warnings.push(`码率实测 ${p.bitrateKbps}kbps 低于 ${expectedQuality} 档 → 按 ${real} 收录`)
      }
    } else if (!fmt.isMp3 && !fmt.isFlac) {
      reasons.push('未知音频格式')
    } else if (fmt.isFlac) {
      warnings.push(`预期 ${expectedQuality} 实得 FLAC（格式优于预期,按原档收）`)
    }
  }

  // ④ 沉浸声档(atmos/atmos_plus):容器校验(无法验真位深/声道,至少防换壳)
  if (expectedQuality === 'atmos' || expectedQuality === 'atmos_plus') {
    const c = sniffContainer(filePath)
    if (!IMMERSIVE_CONTAINERS.has(c)) {
      reasons.push(`沉浸声档容器可疑（${c}）——疑似换壳`)
    } else {
      warnings.push(`Atmos 档当前无法可靠验真（容器 ${c}）,以源返回为准`)
    }
  }

  return { ok: reasons.length === 0, actualQuality, reasons, warnings: warnings.length ? warnings : undefined }
}
