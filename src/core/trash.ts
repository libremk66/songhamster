import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../config.js'
import { logger } from './logger.js'

/**
 * 回收站安全缓冲：
 * 删除操作 = 把文件移动到 <downloadRoot>/.songhamster-trash/<时间戳>/（保留相对层级），可恢复；
 * 只有回收站内的"彻底删除"才真正物理删除。
 *
 * Emby 条目路径（容器内）→ 本项目可操作路径的映射：
 * 约定本项目 downloadRoot 与 Emby 媒体库文件夹对应共享目录同一位置：
 *   本项目 /data/music ←→ Emby /media/music（共享根）
 *   歌单文件夹：本项目 /data/music/歌单同步 ←→ Emby 媒体库文件夹（如 /media/music/歌单同步）
 * 映射规则：Emby 路径去掉媒体库文件夹前缀后，接到本项目 downloadRoot/歌单同步 之后；
 * 无法映射（文件不在本项目挂载目录）返回 null。
 */

// 路径换算见 core/paths.ts（localizeEmbyPath / toServerPath）

/**
 * 回收站根目录。改名（SongFerry → SongHamster）兼容：
 * 新目录不存在而老的 `.songferry-trash` 在 → 继续用老目录，绝不会出现"两个回收站各存一半"。
 * 想迁到新名字：把老目录改名成新名字即可（程序下次就用新的）。
 */
export function trashRoot(cfg: AppConfig): string | null {
  if (!cfg.lxserver.downloadRoot) return null
  const dl = cfg.lxserver.downloadRoot.replace(/\/+$/, '')
  const fresh = dl + '/.songhamster-trash'
  const legacy = dl + '/.songferry-trash'
  if (!existsSync(fresh) && existsSync(legacy)) return legacy
  return fresh
}

/** 把本地文件移入回收站（新批次目录）；返回回收站内新路径；失败抛错 */
export function moveToTrash(cfg: AppConfig, localPath: string): string {
  const root = trashRoot(cfg)
  if (!root) throw new Error('未配置下载目录，无法使用回收站')
  if (!existsSync(localPath)) throw new Error('文件不存在：' + localPath)
  const batch = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(root, batch, path.relative(cfg.lxserver.downloadRoot.replace(/\/+$/, ''), localPath))
  mkdirSync(path.dirname(dest), { recursive: true })
  renameSync(localPath, dest)
  logger.info(`[trash] 已移入回收站: ${localPath} → ${dest}`)
  return dest
}

export interface TrashEntry {
  /** 相对回收站根的路径（含批次目录） */
  rel: string
  full: string
  batch: string
  size: number
}

/** 列出回收站全部文件（按批次聚合） */
export function listTrash(cfg: AppConfig): { batches: string[]; files: TrashEntry[] } {
  const root = trashRoot(cfg)
  if (!root || !existsSync(root)) return { batches: [], files: [] }
  const files: TrashEntry[] = []
  const batches: string[] = []
  for (const b of readdirSync(root)) {
    const bpath = path.join(root, b)
    let st
    try {
      st = statSync(bpath)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    batches.push(b)
    const walk = (dir: string, relDir: string) => {
      for (const e of readdirSync(dir)) {
        const full = path.join(dir, e)
        const rel = relDir ? `${relDir}/${e}` : e
        const fs = statSync(full)
        if (fs.isDirectory()) walk(full, rel)
        else files.push({ rel: `${b}/${rel}`, full, batch: b, size: fs.size })
      }
    }
    walk(bpath, '')
  }
  batches.sort().reverse()
  return { batches, files }
}

/** 恢复（移回 downloadRoot 原相对位置）；文件可能在批次目录下 */
export function restoreFromTrash(cfg: AppConfig, rel: string): string {
  const root = trashRoot(cfg)
  if (!root) throw new Error('回收站不可用')
  const src = path.join(root, rel)
  if (!existsSync(src)) throw new Error('回收站文件不存在：' + rel)
  // rel = <batch>/<downloadRoot 相对路径>
  const dl = cfg.lxserver.downloadRoot.replace(/\/+$/, '')
  const parts = rel.split(/[\\/]/)
  parts.shift() // 批次名
  const dest = path.join(dl, ...parts)
  mkdirSync(path.dirname(dest), { recursive: true })
  renameSync(src, dest)
  logger.info(`[trash] 已恢复: ${rel} → ${dest}`)
  return dest
}

export function purgePath(fullPath: string): void {
  if (!existsSync(fullPath)) return
  rmSync(fullPath, { force: true })
  logger.warn(`[trash] 已彻底删除: ${fullPath}`)
}
