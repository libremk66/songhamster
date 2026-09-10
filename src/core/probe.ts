import { readFileSync, statSync } from 'node:fs'

/**
 * 音频文件真实参数探测（洗版判定核心）
 * 链路：FLAC STREAMINFO 精确 → MP3 帧头（CBR 精确 / VBR 近似）→ 大小估算（明确标记 estimate）
 */

export interface ProbeResult {
  /** 音频格式（小写） */
  format: string
  /** 平均码率 kbps（estimate=true 时为估算值） */
  bitrateKbps: number
  /** 是否估算（未能精确探测） */
  estimate: boolean
  /** FLAC 位深（非 flac 时 0） */
  bits?: number
  /** FLAC 采样率（非 flac 时 0） */
  sampleRate?: number
  /** 时长（秒） */
  durationSec: number
  /** 文件字节数 */
  size: number
}

const MP3_BITRATES_CBR = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const MP3_SAMPLERATES = [44100, 48000, 32000]

function readHead(path: string, n: number): Buffer {
  const fd = readFileSync(path)
  return fd.subarray(0, Math.min(n, fd.length))
}

/** FLAC：STREAMINFO 精确解析（bps/sampleRate/总时长） */
export function probeFlac(path: string, size: number): ProbeResult | null {
  const h = readHead(path, 64)
  if (h.length < 42 || !(h[0] === 0x66 && h[1] === 0x4c && h[2] === 0x61 && h[3] === 0x43)) return null
  const sampleRate = ((h[18] << 12) | (h[19] << 4) | (h[20] >> 4)) & 0xfffff
  const bits = (((h[20] & 0x01) << 4) | (h[21] >> 4)) + 1
  // totalSamples：36 bit（b[21] 低 4 位为高 4 bit，接 b[22..25] 共 32 bit）
  // ⚠️ 用乘法组合高位避免 <<32 no-op / int32 符号问题
  const totalSamples =
    (h[21] & 0x0f) * 4294967296 +
    (((h[22] << 24) | (h[23] << 16) | (h[24] << 8) | h[25]) >>> 0)
  const durationSec = sampleRate > 0 ? totalSamples / sampleRate : 0
  // 码率按文件大小估算（flac 无损无固定码率），标记估算
  const bitrateKbps = durationSec > 0 ? Math.round((size * 8) / durationSec / 1000) : 0
  return { format: 'flac', bitrateKbps, estimate: true, bits, sampleRate, durationSec, size }
}

/**
 * MP3：帧头解析
 * - CBR：帧码率即平均码率（精确）
 * - VBR：仅读首帧会偏高，扫帧统计平均（精确）；限制扫描前 2MB 近似
 */
export function probeMp3(path: string, size: number): ProbeResult | null {
  const MAX_SCAN = 2 * 1024 * 1024
  const head = readHead(path, 4)
  if (head.length < 4 || head[0] !== 0xff || (head[1] & 0xe0) !== 0xe0) return null
  const ver = (head[1] >> 3) & 0x03 // 0=MPEG2.5 2=MPEG2 3=MPEG1
  const layer = (head[1] >> 1) & 0x03 // 1=Layer3
  if (ver === 1 || layer !== 1) return null // 保留 2.5/2/1 的 Layer3
  const sampleRateIdx = (head[2] >> 2) & 0x03
  if (sampleRateIdx === 3) return null
  const srTable = ver === 3 ? MP3_SAMPLERATES : [22050, 24000, 16000]
  const sampleRate = srTable[sampleRateIdx]
  const bitrateIdx = (head[2] >> 4) & 0x0f
  const vbr = bitrateIdx === 0 || bitrateIdx === 15
  const bitrate = MP3_BITRATES_CBR[bitrateIdx]

  // VBR（Xing/Info 头常见）：扫帧统计
  if (vbr) {
    let frames = 0
    let bytes = 0
    let off = 0
    const buf = readHead(path, MAX_SCAN)
    const pad = (head[2] >> 1) & 0x01
    let frameLen = Math.floor((144 * bitrate * 1000) / sampleRate) + pad
    // 从首帧帧长起跳扫（帧长按首帧码率——VBR 首帧常为 0，用 128k 起步近似）
    if (bitrate === 0) frameLen = Math.floor((144 * 128 * 1000) / sampleRate) + pad
    off = 4 + frameLen
    while (off + 4 < buf.length) {
      if (buf[off] === 0xff && (buf[off + 1] & 0xe0) === 0xe0) {
        const bi = (buf[off + 2] >> 4) & 0x0f
        const br = MP3_BITRATES_CBR[bi]
        const pad2 = (buf[off + 2] >> 1) & 0x01
        const fl = Math.floor((144 * br * 1000) / sampleRate) + pad2
        if (fl > 0 && br > 0) {
          frames++
          bytes += fl
          off += fl
          continue
        }
      }
      off++
    }
    const avg = frames > 0 ? Math.round((bytes * 8) / (frames * 1152) / (sampleRate / 1000) / 1000 * 1000) / 1000 : 0
    const durByFrames = frames > 0 ? (frames * 1152) / sampleRate : 0
    const durEstimate = durByFrames > 0 ? durByFrames : size / (128 * 1000 / 8) / 1000
    return { format: 'mp3', bitrateKbps: Math.round(avg), estimate: avg === 0, durationSec: Math.round(durEstimate * 10) / 10, size }
  }

  // CBR：精确
  const pad = (head[2] >> 1) & 0x01
  const frameLen = Math.floor((144 * bitrate * 1000) / sampleRate) + pad
  const frames = Math.floor((size - 4) / frameLen)
  const durationSec = (frames * 1152) / sampleRate
  return { format: 'mp3', bitrateKbps: bitrate, estimate: false, durationSec: Math.round(durationSec * 10) / 10, size }
}

/** 估算回退：按扩展名/码率推断（标记 estimate） */
function probeFallback(path: string, size: number): ProbeResult {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  const format = ext || 'unknown'
  // 常见码率假设：mp3 按 128k 估（保守），flac 按 800k 估（只用于时长粗算）
  const guessKbps = format === 'flac' ? 800 : format === 'mp3' ? 128 : 320
  const durationSec = guessKbps > 0 ? (size * 8) / (guessKbps * 1000) : 0
  return { format, bitrateKbps: guessKbps, estimate: true, durationSec: Math.round(durationSec * 10) / 10, size }
}

/** 探测入口：按文件头识别格式分发 */
export function probeAudio(filePath: string): ProbeResult {
  let size = 0
  try {
    size = statSync(filePath).size
  } catch {
    return { format: 'unknown', bitrateKbps: 0, estimate: true, durationSec: 0, size: 0 }
  }
  const head = readHead(filePath, 16)
  if (head.length >= 12 && head[4] === 0x66 && head[5] === 0x4c && head[6] === 0x61 && head[7] === 0x43) {
    // 偏移 4 的 fLaC（ID3v2 前置）或 0 起（纯 flac）
  }
  if (head.length >= 4 && head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) {
    const r = probeFlac(filePath, size)
    if (r) return r
  }
  // ID3v2 前置的 flac/mp3：音频实际偏移 = 10(头) + tagSize（无 footer）
  if (head.length >= 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    const tagSize = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f)
    const audioOff = 10 + tagSize
    const inner = readHead(filePath, audioOff + 16).subarray(audioOff)
    if (inner.length >= 4 && inner[0] === 0x66 && inner[1] === 0x4c && inner[2] === 0x61 && inner[3] === 0x43) {
      const r = probeFlacWithOffset(filePath, audioOff, size)
      if (r) return r
    }
    if (inner.length >= 2 && inner[0] === 0xff && (inner[1] & 0xe0) === 0xe0) {
      const r = probeMp3ScanWhole(filePath, audioOff, size)
      if (r) return r
    }
    // ID3 后非 flac/mp3（如 m4a）→ 估算回退
    return probeFallback(filePath, size)
  }
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    const r = probeMp3(filePath, size)
    if (r) return r
  }
  return probeFallback(filePath, size)
}

/** 带 ID3 偏移的 FLAC 探测 */
function probeFlacWithOffset(path: string, offset: number, size: number): ProbeResult | null {
  const fd = readFileSync(path)
  const b = fd.subarray(offset)
  if (b.length < 42 || !(b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43)) return null
  const sampleRate = ((b[18] << 12) | (b[19] << 4) | (b[20] >> 4)) & 0xfffff
  const bits = (((b[20] & 0x01) << 4) | (b[21] >> 4)) + 1
  const totalSamples =
    (b[21] & 0x0f) * 4294967296 +
    (((b[22] << 24) | (b[23] << 16) | (b[24] << 8) | b[25]) >>> 0)
  const durationSec = sampleRate > 0 ? totalSamples / sampleRate : 0
  const bitrateKbps = durationSec > 0 ? Math.round((size * 8) / durationSec / 1000) : 0
  return { format: 'flac', bitrateKbps, estimate: true, bits, sampleRate, durationSec, size }
}

/** 跳过 ID3 的全文件 MP3 帧扫描（平均码率） */
function probeMp3ScanWhole(path: string, id3Size: number, size: number): ProbeResult | null {
  const fd = readFileSync(path)
  let off = id3Size
  let frames = 0
  let bytes = 0
  let sampleRate = 44100
  while (off + 4 < fd.length) {
    if (fd[off] === 0xff && (fd[off + 1] & 0xe0) === 0xe0) {
      const ver = (fd[off + 1] >> 3) & 0x03
      const sri = (fd[off + 2] >> 2) & 0x03
      if (ver !== 1 && sri !== 3) {
        const srTable = ver === 3 ? MP3_SAMPLERATES : [22050, 24000, 16000]
        sampleRate = srTable[sri]
        const br = MP3_BITRATES_CBR[(fd[off + 2] >> 4) & 0x0f]
        const pad = (fd[off + 2] >> 1) & 0x01
        if (br > 0) {
          const fl = Math.floor((144 * br * 1000) / sampleRate) + pad
          frames++
          bytes += fl
          off += fl
          continue
        }
      }
    }
    off++
  }
  const durationSec = frames > 0 ? (frames * 1152) / sampleRate : 0
  const avg = frames > 0 ? (bytes * 8) / 1000 / durationSec : 0
  return { format: 'mp3', bitrateKbps: Math.round(avg), estimate: false, durationSec: Math.round(durationSec * 10) / 10, size }
}
