import { existsSync } from 'node:fs'
import type { AppConfig } from '../config.js'
import { supportsFileDelete } from '../config.js'
import type { MediaServerAdapter } from '../adapters/media-server.js'
import * as repo from '../store/repo.js'
import { moveToTrash } from './trash.js'
import { logger } from './logger.js'

/**
 * 手动删除的统一实现（三选项：文件 / 歌单 / 历史记录）。
 *
 * 两处入口共用：
 *   ① 歌单同步 / 榜单订阅 列表上的「删除任务」→ targets = 该任务下全部歌曲
 *   ② 进度历史页勾选记录 → targets = 勾中记录展开的歌曲
 *
 * 三条不变量（与引擎镜像模式同一套规则，不另立门户）：
 *   · 文件：先移入回收站（可恢复）；只删「选中范围内已无其它任务引用」的
 *   · 歌单：只移除「本任务自己加入过」的歌（归属保护），别的任务加进来的不动
 *   · 历史：只清流水账，不动同步基准（不触发重新下载）——这与"删文件才会重下"配套
 */

export interface DeleteOptions {
  file?: boolean
  playlist?: boolean
  history?: boolean
}

/** 一首待删除的歌 + 它所在的任务上下文（歌单归属与所有权都是按任务算的） */
export interface DeleteTarget {
  taskId: number
  songKey: string
}

export interface DeleteReport {
  /** 移入回收站的文件数 */
  files: number
  /** 因仍被选中范围之外的任务引用而保留的文件数 */
  filesKept: number
  /** 从歌单移除的条目数 */
  playlistRemoved: number
  /** 歌单里找不到（条目 Id 缓存失效 / 未入库）的歌曲数 */
  playlistMissed: number
  /** 归属保护跳过（非本任务加入）的歌曲数 */
  notOwned: number
  /** 删除的历史明细行 / 空批次壳 */
  historyItems: number
  historyBatches: number
  /** 面向用户的提示（已去重、可直接拼进结果消息） */
  notes: string[]
  /** 单条失败（最多保留几条，避免刷屏） */
  errors: string[]
}

/** 歌单移除是否按"所有权"过滤（与引擎一致：歌单里非本任务加入的歌不动） */
export async function applyDeletion(input: {
  cfg: AppConfig
  emby: MediaServerAdapter
  targets: DeleteTarget[]
  /** 勾选「历史记录」时删除的明细行 id */
  itemIds?: number[]
  /** 整批勾选的批次 id（明细自动展开，批次壳一并删除） */
  batchIds?: number[]
  opts: DeleteOptions
}): Promise<DeleteReport> {
  const { cfg, emby, opts } = input
  const rep: DeleteReport = {
    files: 0,
    filesKept: 0,
    playlistRemoved: 0,
    playlistMissed: 0,
    notOwned: 0,
    historyItems: 0,
    historyBatches: 0,
    notes: [],
    errors: [],
  }
  // 同一首歌可能在多个批次里被勾中：文件按歌去重，歌单/所有权按 (任务,歌) 去重
  const songKeys = [...new Set(input.targets.map((t) => t.songKey))]
  const pairs = new Map<string, DeleteTarget>()
  for (const t of input.targets) pairs.set(`${t.taskId}|${t.songKey}`, t)
  const tasksInScope = new Set(input.targets.map((t) => t.taskId))

  // ⚠️ 顺序：歌单必须在文件之前——删文件会连带清掉 task_song_ref，
  // 而歌单的「归属保护」正是靠它判断"哪些歌是本任务加入的"，反了会把每首都当成别人的。
  if (opts.playlist) await removeFromPlaylists(emby, [...pairs.values()], rep)
  if (opts.file) await deleteFiles(cfg, songKeys, tasksInScope, rep)
  if (opts.history) {
    const ids = new Set(input.itemIds ?? [])
    for (const b of input.batchIds ?? []) for (const id of repo.listHistoryItemIdsByBatch(b)) ids.add(id)
    const r = repo.deleteHistoryItems([...ids]) // 顺带收掉被删空的批次壳
    const extra = repo.deleteHistoryBatches((input.batchIds ?? []).filter((b) => !repo.getBatch(b))) // 本来就空/已删空的整批
    rep.historyItems = r.items
    rep.historyBatches = r.batches + extra
    if (r.items || rep.historyBatches) {
      rep.notes.push(`已删除历史记录 ${r.items} 条${rep.historyBatches ? `（${rep.historyBatches} 个批次记录一并移除）` : ''}`)
    }
  }
  return rep
}

/**
 * 文件删除 = 移入回收站 + 从登记/基准里摘除。
 * 后者是"下次同步会重新下载"能兑现的关键：增量按 status、镜像按快照跳过，都不看磁盘。
 */
async function deleteFiles(cfg: AppConfig, songKeys: string[], tasksInScope: Set<number>, rep: DeleteReport): Promise<void> {
  if (!supportsFileDelete(cfg.target)) {
    rep.notes.push(`当前媒体服务器（${cfg.target}）不支持删除文件 → 已跳过「文件」`)
    return
  }
  let missing = 0
  for (const songKey of songKeys) {
    for (const f of repo.listFilesForSong(songKey)) {
      // 引用保护：选中范围之外还有任务在用 → 保留（否则会连锁破坏别的任务的歌单）
      const outside = repo.fileRefTasks(f.fileId).filter((tid) => !tasksInScope.has(tid))
      if (outside.length) {
        rep.filesKept++
        logger.info(`[delete] ${songKey} 文件仍被任务 ${outside.join('/')} 引用 → 保留（未删除）`)
        continue
      }
      if (existsSync(f.filePath)) {
        try {
          moveToTrash(cfg, f.filePath)
          rep.files++
        } catch (e) {
          rep.errors.push(`移入回收站失败：${(e as Error).message}`)
          continue // 文件没删成 → 登记/基准都不动，保持自洽
        }
      } else {
        missing++ // 登记在案但磁盘上早已不在：清掉残留登记即可
      }
      // 摘登记 + 引用 + 同步基准，让下次同步把它当"没下过"重新下载
      repo.dropSongFromBaseline(songKey)
      repo.removeFileRecord(f.fileId)
    }
  }
  if (rep.files) rep.notes.push(`${rep.files} 个文件已移入回收站（可恢复）——下次同步会重新下载这些歌`)
  if (missing) rep.notes.push(`${missing} 个文件此前已不在磁盘（仅清理了登记）`)
  if (rep.filesKept) rep.notes.push(`${rep.filesKept} 个文件仍被其它任务引用 → 已保留（未删除）`)
}

/**
 * 从歌单移除勾中的歌（任务范围：同名受管歌单 + 用户勾选的已有歌单；归档歌单不在此列——那是歌主动待着的地方）。
 * 逐个歌单取一次条目表再批量移除，避免"每首歌拉一次全表"。
 */
async function removeFromPlaylists(emby: MediaServerAdapter, targets: DeleteTarget[], rep: DeleteReport): Promise<void> {
  const byTask = new Map<number, DeleteTarget[]>()
  for (const t of targets) {
    if (!byTask.has(t.taskId)) byTask.set(t.taskId, [])
    byTask.get(t.taskId)!.push(t)
  }
  for (const [taskId, list] of byTask) {
    const task = repo.getTask(taskId)
    if (!task) continue // 任务已删：歌单里那点残留由下次同步或用户自行处理，不猜
    const pids = new Set<string>(task.embyTargetPlaylistIdsParsed)
    if (task.createSameNamePlaylist) {
      try {
        const p = await emby.listPlaylists()
        const same = p.find((x) => x.name === task.lxPlaylistName)
        if (same) pids.add(same.id)
      } catch (e) {
        rep.errors.push(`读取歌单失败：${(e as Error).message}`)
      }
    }
    if (!pids.size) continue
    // 只处理本任务加入过的歌（归属保护，与镜像模式同一规则）
    const owned = list.filter((t) => repo.hasTaskSongRef(taskId, t.songKey))
    if (owned.length < list.length) rep.notOwned += list.length - owned.length
    if (!owned.length) continue
    for (const pid of pids) {
      let items: Awaited<ReturnType<MediaServerAdapter['listPlaylistItems']>>
      try {
        items = await emby.listPlaylistItems(pid)
      } catch (e) {
        rep.errors.push(`读取歌单条目失败：${(e as Error).message}`)
        continue
      }
      const entryByItem = new Map(items.map((it) => [it.itemId, it.entryId]))
      const entryIds: string[] = []
      for (const t of owned) {
        const map = repo.getEmbyMap(t.songKey)
        const entryId = map ? entryByItem.get(map.embySongId) : undefined
        if (entryId) entryIds.push(entryId)
        else rep.playlistMissed++
      }
      if (!entryIds.length) continue
      try {
        await emby.removeItems(pid, entryIds)
        rep.playlistRemoved += entryIds.length
      } catch (e) {
        rep.errors.push(`从未在歌单中移除：${(e as Error).message}`)
      }
    }
  }
  if (rep.playlistRemoved) rep.notes.push(`已从歌单移除 ${rep.playlistRemoved} 首`)
  if (rep.playlistMissed) rep.notes.push(`${rep.playlistMissed} 首未能在歌单中定位（媒体库条目缓存失效或未入库）`)
  if (rep.notOwned) rep.notes.push(`${rep.notOwned} 首非本任务加入 → 归属保护，未从歌单移除`)
}

/** 把 DeleteReport 拼成一句给界面看的话 */
export function reportLine(rep: DeleteReport): string {
  const parts = [...rep.notes]
  for (const e of rep.errors.slice(0, 3)) parts.push(`⚠️ ${e}`)
  if (rep.errors.length > 3) parts.push(`⚠️ 另有 ${rep.errors.length - 3} 条失败未列出`)
  if (!parts.length) parts.push('没有可删除的内容（勾选项在所选范围内是空的）')
  return parts.join('；')
}
