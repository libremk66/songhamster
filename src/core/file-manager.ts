import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { Quality } from '../config.js'
import type { LxSong } from '../adapters/lxserver.js'
import { getDb } from '../store/db.js'

/** 占位符渲染（命名模板）——界面预览与落盘共用同一实现 */
export function renderFilename(template: string, song: LxSong, quality: Quality): string {
  const map: Record<string, string> = {
    '歌手': song.singer,
    '专辑名': song.albumName ?? '',
    '歌曲名': song.name,
    '音质': quality,
  }
  const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').trim()
  return template.replace(/\[([^\]]+)\]/g, (m, key) => safe(map[key] ?? '')).replace(/\s+/g, ' ').trim()
}

/**
 * 把 lxserver 下载好的文件移动到歌单目录
 * 下载文件名（lxserver 索引）："歌名 - 歌手 - <quality> - <album>.ext"
 * 移动后按命名模板重命名
 */
export function moveToPlaylistDir(input: {
  downloadRoot: string
  srcFilename: string
  taskPlaylistName: string
  song: LxSong
  quality: Quality
  template: string
  /** 外置歌词(.lrc)：开=把 .lrc 一起搬走；关=清掉同名 .lrc 残留（不选就不该有） */
  cacheLyric: boolean
  /** 直接指定目标目录（绝对路径，替代 歌单同步/<name> 约定）——手动下载等场景 */
  absoluteDir?: string
}): { filePath: string; moved: boolean; reason?: string } {
  const src = path.join(input.downloadRoot, input.srcFilename)
  if (!existsSync(src)) return { filePath: '', moved: false, reason: `源文件不存在: ${src}` }

  const ext = path.extname(input.srcFilename) || '.flac'
  const newName = renderFilename(input.template, input.song, input.quality) + ext
  const dir = input.absoluteDir ?? path.join(input.downloadRoot, '歌单同步', input.taskPlaylistName)
  mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, newName)

  // 已存在同名（重试场景）→ 覆盖
  if (existsSync(dest)) renameSync(dest, dest + '.old')
  try {
    renameSync(src, dest)
  } catch (e) {
    return { filePath: '', moved: false, reason: `移动失败: ${(e as Error).message}` }
  }

  // 外置歌词 .lrc：按「外置歌词」开关决定去留。
  // ⚠️ 旧实现用的是 embedLyric（内嵌开关），导致"没勾外置歌词却出现 .lrc"。
  let lrcMoved = false
  const srcLrc = src.slice(0, -ext.length) + '.lrc'
  if (input.cacheLyric) {
    if (existsSync(srcLrc)) {
      const destLrc = dest.slice(0, -ext.length) + '.lrc'
      try {
        renameSync(srcLrc, destLrc)
        lrcMoved = true
      } catch {
        lrcMoved = false
      }
    }
  } else if (existsSync(srcLrc)) {
    // 没勾外置歌词：清掉同名残留（lxserver 缓存或历史遗留），保证落地目录里没有 .lrc
    try { rmSync(srcLrc, { force: true }) } catch { /* 忽略 */ }
  }
  return { filePath: dest, moved: true }
}

/** 孤立文件候选（无任何 task 引用的 song_files 对应文件；调用方确认后删除） */
export function collectOrphans(downloadRoot: string): string[] {
  const rows = getDb().prepare('SELECT * FROM song_files').all() as { id: number; filePath: string }[]
  const orphans: string[] = []
  for (const r of rows) {
    const cnt = getDb().prepare('SELECT COUNT(*) AS n FROM task_song_ref WHERE fileId = ?').get(r.id) as { n: number }
    if (cnt.n === 0 && existsSync(r.filePath)) orphans.push(r.filePath)
  }
  return orphans
}
