import { EventEmitter } from 'node:events'
import path from 'node:path'
import { rmSync, renameSync } from 'node:fs'
import type { AppConfig, Quality } from '../config.js'
import { HIGH_RES_FLAC, QUALITY_ORDER } from '../config.js'
import type { LxSong } from '../adapters/lxserver.js'
import { LxServerAdapter } from '../adapters/lxserver.js'
import type { MediaServerAdapter } from '../adapters/media-server.js'
import { moveToPlaylistDir, renderFilename } from './file-manager.js'
import { validateFile, sniffFlacBits } from './validator.js'
import * as repo from '../store/repo.js'
import { getDb } from '../store/db.js'
import { logger } from './logger.js'

export interface EngineEvents {
  'batch-start': (taskId: number, batchId: number) => void
  'song-status': (taskId: number, payload: { songKey: string; songName: string; status: string; quality?: string; errorReason?: string }) => void
  'batch-finish': (taskId: number, batchId: number, result: string) => void
}

export class SyncEngine {
  readonly events = new EventEmitter()
  private runningTaskId: number | null = null

  constructor(
    private cfg: () => AppConfig,
    private lx: LxServerAdapter,
    private emby: MediaServerAdapter,
  ) {}

  get isRunning(): boolean {
    return this.runningTaskId !== null
  }

  emit<K extends keyof EngineEvents>(name: K, ...args: Parameters<EngineEvents[K]>): void {
    this.events.emit(name, ...args)
  }

  /** 增量 diff：跳过已 success 的歌 */
  private diffIncremental(taskId: number, songs: LxSong[]): LxSong[] {
    const statuses = repo.listSongStatus(taskId)
    const done = new Set(statuses.filter((s) => s.status === 'success').map((s) => s.songKey))
    return songs.filter((s) => !done.has(s.songKey))
  }

  /** 完全同步 diff：与快照比对 → 新增下载 + 待移除 */
  private diffFull(
    taskId: number,
    songs: LxSong[],
  ): { toDownload: LxSong[]; toRemove: string[] } {
    const snap = repo.getSnapshot(taskId)
    if (!snap) return { toDownload: songs, toRemove: [] } // 首次=全量下载
    const snapSet = new Set(snap)
    const curSet = new Set(songs.map((s) => s.songKey))
    return {
      toDownload: songs.filter((s) => !snapSet.has(s.songKey)),
      toRemove: [...snapSet].filter((k) => !curSet.has(k)),
    }
  }

  /** 主入口：执行一个任务（全局单飞：一次只跑一个任务） */
  async runTask(taskId: number, trigger: 'cron' | 'manual'): Promise<string> {
    if (this.cfg().general.pauseAll) return 'skipped-paused'
    if (this.runningTaskId !== null) return 'skipped-busy'
    const task = repo.getTask(taskId)
    if (!task) return 'task-not-found'
    if (!task.enabled) return 'task-disabled'

    this.runningTaskId = taskId
    const batchId = repo.createBatch({ taskId, trigger })
    this.emit('batch-start', taskId, batchId)

    let okCount = 0
    let failCount = 0
    let unsatisfiedCount = 0
    let dupCount = 0
    let dedupCount = 0
    let removedCount = 0

    try {
      logger.info(`[engine] task#${taskId}(${task.lxPlaylistName}) ${trigger} 开始`)
      // 榜单订阅：歌曲源 = 榜单 API（订阅范围前 N 首，0=全榜）；恒增量（归档模式只增不删）
      const isChart = task.taskType === 'chart'
      let songs: LxSong[]
      if (isChart) {
        const full = await this.lx.getChartSongs(task.chartSource ?? '', task.chartId ?? '')
        const N = Number(task.maxCount ?? 30)
        songs = N > 0 ? full.slice(0, N) : full
      } else {
        songs = await this.lx.getSongs(task.lxPlaylistKey)
      }

      // diff
      let toDownload: LxSong[]
      let toRemove: string[] = []
      if (isChart || task.syncMode !== 'full') {
        toDownload = this.diffIncremental(taskId, songs)
      } else {
        const d = this.diffFull(taskId, songs)
        toDownload = d.toDownload
        toRemove = d.toRemove
      }
      logger.info(`[engine] ${isChart ? `榜单 ${task.lxPlaylistName}（范围 ${songs.length} 首）` : `源歌单 ${songs.length} 首`} | 待下载 ${toDownload.length} | 待移除 ${toRemove.length}`)

      // 完全同步：移除已删除的歌
      if (toRemove.length > 0) {
        const removed = await this.removeSongs(taskId, task, toRemove)
        removedCount = removed
      }

      // 逐歌下载（批量下载保护：每首结束后等待间隔，防音源限流）
      const prot = this.cfg().download.protection
      for (let idx = 0; idx < toDownload.length; idx++) {
        const song = toDownload[idx]
        // 查重 pre-check：Emby 已存在达标歌曲 → 跳过 LX 下载，仅入歌单
        let dedupHit: { id: string; quality: string | null } | null = null
        const ddOn = task.dedupCheck || this.cfg().advanced.dedupCheck
        if (ddOn) {
          const hit = await this.emby.findSongWithQuality(song.name, song.singer)
          const needQ = task.dedupMinQuality || this.cfg().advanced.dedupMinQuality
          const rank = (q: string | null) => (q && QUALITY_ORDER.includes(q as any) ? QUALITY_ORDER.indexOf(q as any) : -1)
          const met = hit && (!needQ || (hit.quality && rank(hit.quality) >= rank(needQ)))
          if (hit && !needQ && !hit.quality) {
            // 未检查音质时未知音质也视为已存在 → 跳过
            dedupHit = hit
          } else if (met) {
            dedupHit = hit
          } else if (hit && needQ && !hit.quality) {
            // 检查音质但库内条目音质未知 → 视为不达标，继续下载
          }
        }
        if (dedupHit) {
          dedupCount++
          const okAdd = await this.ensureInEmby(taskId, task, song, dedupHit.id)
          repo.upsertSongStatus({
            taskId, songKey: song.songKey, songName: song.name, singer: song.singer,
            status: okAdd ? 'dedup' : 'failed', quality: dedupHit.quality ?? undefined,
            errorReason: okAdd ? undefined : '查重命中但加入歌单失败',
          })
          repo.insertHistoryItem({
            batchId, taskId, songKey: song.songKey, songName: song.name, singer: song.singer,
            status: okAdd ? 'dedup' : 'failed', quality: dedupHit.quality ?? undefined,
            errorReason: okAdd ? undefined : '查重命中但加入歌单失败',
          })
          this.emit('song-status', taskId, {
            songKey: song.songKey, songName: song.name, status: okAdd ? 'dedup' : 'failed',
            quality: dedupHit.quality ?? undefined, errorReason: okAdd ? undefined : '查重命中但加入歌单失败',
          })
          continue
        }
        const outcome = await this.downloadOne(taskId, task, song)
        if (outcome.status === 'success') okCount++
        else if (outcome.status === 'dup') dupCount++
        else if (outcome.status === 'unsatisfied') unsatisfiedCount++
        else failCount++
        if (prot?.enabled && prot.downloadIntervalSec > 0 && idx < toDownload.length - 1) {
          await sleep(prot.downloadIntervalSec * 1000)
        }
        repo.insertHistoryItem({
          batchId,
          taskId,
          songKey: song.songKey,
          songName: song.name,
          singer: song.singer,
          status: outcome.status === 'dup' ? 'skipped_dup' : outcome.status,
          quality: outcome.quality,
          errorReason: outcome.reason,
        })
        this.emit('song-status', taskId, {
          songKey: song.songKey,
          songName: song.name,
          status: outcome.status,
          quality: outcome.quality,
          errorReason: outcome.reason,
        })
      }

      const result = failCount > 0 || unsatisfiedCount > 0 ? (okCount > 0 ? 'partial' : 'failed') : 'success'
      repo.finishBatch(batchId, {
        finishedAt: new Date().toISOString(),
        result,
        okCount,
        failCount,
        unsatisfiedCount,
        removedCount,
        dupCount,
        dedupCount,
      })
      repo.updateTask(taskId, {
        lastRunAt: new Date().toISOString(),
        lastResult: result,
      })
      // 快照：完全同步语义的删除检测依据 = 本次源歌单全集
      repo.setSnapshot(taskId, songs.map((s) => s.songKey))
      // 榜单任务：存当期快照 + 变化统计（时效性报告：本期新上榜/跌出）
      if (isChart) {
        const prev = repo.getLatestChartSnapshot(taskId)
        const curKeys = songs.map((s) => s.songKey)
        const curSet = new Set(curKeys)
        const prevKeys = prev?.songKeys ?? []
        const prevSet = new Set(prevKeys)
        const newCount = curKeys.filter((k) => !prevSet.has(k)).length
        const removedCount = prev ? prevKeys.filter((k) => !curSet.has(k)).length : 0
        repo.saveChartSnapshot({
          taskId,
          syncedAt: new Date().toISOString(),
          totalCount: curKeys.length,
          newCount,
          removedCount,
          songKeys: curKeys,
        })
        if (prev) {
          logger.info(`[engine] 榜单变化: 本期 ${curKeys.length} 首 | 新上榜 ${newCount} | 跌出 ${removedCount}`)
        }
      }
      logger.info(`[engine] task#${taskId} 完成: result=${result} ok=${okCount} fail=${failCount} unsatisfied=${unsatisfiedCount} dup=${dupCount} dedup=${dedupCount} removed=${removedCount}`)
      this.emit('batch-finish', taskId, batchId, result)
      return result
    } catch (e) {
      const err = (e as Error).message
      logger.error(`[engine] task#${taskId} 异常: ${err}`)
      repo.finishBatch(batchId, { finishedAt: new Date().toISOString(), result: 'failed', detail: err })
      this.emit('batch-finish', taskId, batchId, 'failed')
      return 'error'
    } finally {
      this.runningTaskId = null
    }
  }

  /** 单歌下载流程：质量链 → 直链 → 下载 → 移文件 → 校验 → Emby 入库+入歌单 */
  private async downloadOne(
    taskId: number,
    task: ReturnType<typeof repo.getTask> & {},
    song: LxSong,
    opts?: { dirName?: string; absoluteDir?: string; skipIngest?: boolean },
  ): Promise<{ status: 'success' | 'failed' | 'unsatisfied' | 'dup'; quality?: string; reason?: string }> {
    const cfg = this.cfg()
    // 尝试链 = 勾选档 ∩ 该歌实际可用档（types 未声明的不白试）；裁剪为空则退回全勾选
    let qualities = cfg.download.qualities
    if (song.qualities.length) {
      const intersect = cfg.download.qualities.filter((q) => song.qualities.includes(q))
      if (intersect.length) qualities = intersect
    }

    const dirName = opts?.dirName ?? task.lxPlaylistName
    for (const quality of qualities) {
      // 已有文件（该歌+该音质）→ dup 直接走 Emby 侧
      const existing = repo.findSongFile(song.songKey, quality)
      if (existing) {
        if (!opts?.skipIngest) await this.ensureInEmby(taskId, task, song)
        repo.upsertSongStatus({
          taskId, songKey: song.songKey, songName: song.name, singer: song.singer,
          status: 'success', quality,
        })
        return { status: 'dup', quality }
      }
      logger.info(`[engine] 下载 ${song.name} [${quality}]`)

      try {
        const { url } = await this.lx.resolveUrl(song, quality)
        await this.lx.requestDownload(song, url, quality, {
          embedLyric: cfg.download.embedLyric,
          cacheLyric: cfg.download.cacheLyric,
        })
        const file = await this.lx.waitForFile(song, quality)
        if (!file) {
          logger.warn(`[engine] ${song.name} [${quality}] 文件未出现(超时)`)
          continue // 尝试下一档
        }
        // 移到歌单目录
        const moved = moveToPlaylistDir({
          downloadRoot: cfg.lxserver.downloadRoot,
          srcFilename: file.filename,
          taskPlaylistName: dirName,
          absoluteDir: opts?.absoluteDir,
          song,
          quality,
          template: cfg.download.filenameTemplate,
          embedLyric: cfg.download.embedLyric,
        })
        if (!moved.moved) {
          logger.warn(`[engine] ${song.name} 移动失败: ${moved.reason}`)
          return { status: 'failed', quality, reason: moved.reason }
        }
        // 真实音质嗅探：请求高规格(flac24bit/hires/master)但实际不足（lxserver 静默降级）→ 按实际档收
        let effectiveQuality: Quality = quality
        if (HIGH_RES_FLAC.includes(quality)) {
          const sniff = sniffFlacBits(moved.filePath)
          if (sniff.isFlac && sniff.bits > 0) {
            if (sniff.bits < 24) {
              logger.warn(`[engine] ${song.name} 请求 ${quality} 实得 ${sniff.bits}bit，降级为 flac 收录`)
              effectiveQuality = 'flac'
            } else if (quality !== 'flac24bit' && sniff.sampleRate > 0 && sniff.sampleRate < 96000) {
              // master/hires 通常要求 ≥96kHz；不足则按 flac24bit 收
              logger.warn(`[engine] ${song.name} 请求 ${quality} 实得 ${sniff.sampleRate}Hz，按 flac24bit 收录`)
              effectiveQuality = 'flac24bit'
            }
          }
        }
        // 校验（格式/版本词；flac24bit→flac 降级视为可接受路径）
        const expectedCheck: Quality = effectiveQuality === 'flac' && quality === 'flac24bit' ? 'flac' : quality
        const v = validateFile(moved.filePath, song, expectedCheck)
        if (!v.ok) {
          rmSync(moved.filePath, { force: true })
          logger.warn(`[engine] ${song.name} 校验失败: ${v.reasons.join('; ')}`)
          if (quality === qualities[qualities.length - 1]) {
            return { status: 'failed', quality, reason: v.reasons.join('; ') }
          }
          continue
        }
        // 降级时按 flac 档检查用户是否勾选；未勾选 → 拒收
        if (effectiveQuality === 'flac' && quality === 'flac24bit' && !qualities.includes('flac')) {
          rmSync(moved.filePath, { force: true })
          return { status: 'unsatisfied', quality: 'flac24bit', reason: '实得 16bit flac，未勾选 flac 档' }
        }
        // 降级时修正文件名（flac24bit → flac）
        if (effectiveQuality !== quality) {
          const oldP = moved.filePath
          const reExt = path.extname(oldP)
          const base = oldP.slice(0, -reExt.length)
          const newName = renderFilename(this.cfg().download.filenameTemplate, song, effectiveQuality)
          const newP = path.join(path.dirname(oldP), newName + reExt)
          renameSync(oldP, newP)
          moved.filePath = newP
        }
        // 登记文件 + 引用
        const fileId = repo.registerFile({
          songKey: song.songKey, quality: effectiveQuality, fileName: path.basename(moved.filePath), filePath: moved.filePath,
          size: file.size,
        })
        repo.refTaskFile(taskId, song.songKey, fileId)
        // Emby 入库 + 入歌单（手动下载 skipIngest：仅落盘，媒体库扫描自然入库）
        const embyOk = opts?.skipIngest ? true : await this.ensureInEmby(taskId, task, song)
        repo.upsertSongStatus({
          taskId, songKey: song.songKey, songName: song.name, singer: song.singer,
          status: embyOk ? 'success' : 'failed', quality: effectiveQuality,
          errorReason: embyOk ? undefined : 'Emby 入库失败',
        })
        return { status: embyOk ? 'success' : 'failed', quality: effectiveQuality, reason: embyOk ? undefined : 'Emby 入库失败' }
      } catch (e) {
        const msg = (e as Error).message
        logger.warn(`[engine] ${song.name} [${quality}] 失败: ${msg}`)
        if (quality === qualities[qualities.length - 1]) {
          return { status: qualities.length > 1 ? 'unsatisfied' : 'failed', quality, reason: msg }
        }
      }
    }
    return { status: 'unsatisfied', reason: '无可用音质' }
  }

  /** Emby 侧：加入目标歌单（含同名创建）。knownId 提供时（查重命中）跳过扫描直接入歌单 */
  private async ensureInEmby(
    taskId: number,
    task: ReturnType<typeof repo.getTask> & {},
    song: LxSong,
    knownId?: string,
  ): Promise<boolean> {
    try {
      const cfg = this.cfg()
      let embySong = knownId ? { embySongId: knownId, lastVerifiedAt: new Date().toISOString() } : null
      if (!embySong) {
        // 媒体库 id 始终由当前适配器解析（各服务器配置段不同——Emby/Jellyfin/其他）
        const libraryId = (await this.emby.resolveLibraryId()) ?? undefined
        if (!libraryId) {
          logger.warn('[emby] 未找到匹配媒体库，跳过入库')
          return false
        }
        // 精确扫描媒体库
        await this.emby.scanLibrary(libraryId)
        // 等待入库并查找（scan 异步，重试几次）
        embySong = repo.getEmbyMap(song.songKey)
        if (!embySong) {
          for (let i = 0; i < 6; i++) {
            await sleep(5000)
            const found = await this.emby.findSong(song.name, song.singer)
            if (found) {
              embySong = { embySongId: found.id, lastVerifiedAt: new Date().toISOString() }
              repo.setEmbyMap(song.songKey, found.id)
              break
            }
          }
          if (!embySong) {
            logger.warn(`[emby] 未找到入库的歌曲: ${song.name}（扫描可能需要更久）`)
            return false
          }
        }
      }
      // 加入目标歌单（daoliyu 目录驱动：落盘即入库+入同名目录歌单，无需 API 操作）
      const playlistIds: string[] = this.emby.kind === 'daoliyu' ? [] : [...task.embyTargetPlaylistIdsParsed]
      if (task.createSameNamePlaylist) {
        const same = await this.findPlaylistByName(task.lxPlaylistName)
        if (same) {
          // 同名列表即本任务自动管理的同步目标 → 追加。
          // （旧"行为B不追加"会导致单次多首新歌的任务只加第一首——已修复；不需要自动管理时取消勾选"创建同名歌单"即可）
          playlistIds.push(same.id)
        } else {
          const np = await this.emby.createPlaylist(task.lxPlaylistName)
          playlistIds.push(np.id)
        }
      }
      for (const pid of new Set(playlistIds)) {
        await this.emby.addItems(pid, [embySong.embySongId])
      }
      return true
    } catch (e) {
      logger.warn(`[emby] 入库异常: ${(e as Error).message}`)
      return false
    }
  }

  private async findPlaylistByName(name: string) {
    const list = await this.emby.listPlaylists()
    return list.find((p) => p.name === name) ?? null
  }

  /**
   * 手动下载（榜单浏览页"下载所选"）：不入任何播放列表/订阅，落盘 歌单同步/手动下载/
   * 挂载单例任务「手动下载」记录历史与进度；完成后触发一次媒体库扫描（帮助入库）
   */
  async runManualDownload(songs: LxSong[]): Promise<{ ok: number; fail: number; dup: number; unsatisfied: number }> {
    if (this.runningTaskId !== null) throw new Error('已有任务在运行，稍后再试')
    if (!songs.length) return { ok: 0, fail: 0, dup: 0, unsatisfied: 0 }
    const taskId = repo.ensureManualTask()
    const task = repo.getTask(taskId)!
    this.runningTaskId = taskId
    const batchId = repo.createBatch({ taskId, trigger: 'manual' })
    this.emit('batch-start', taskId, batchId)
    let ok = 0
    let fail = 0
    let dup = 0
    let unsatisfied = 0
    const prot = this.cfg().download.protection
    try {
      logger.info(`[engine] 手动下载 ${songs.length} 首（落盘 downloadRoot/手动下载，不入歌单）`)
      for (let idx = 0; idx < songs.length; idx++) {
        const song = songs[idx]
        const outcome = await this.downloadOne(taskId, task, song, {
          absoluteDir: path.join(this.cfg().lxserver.downloadRoot?.replace(/\/+$/, '') ?? '', '手动下载'),
          skipIngest: true,
        })
        if (outcome.status === 'success') ok++
        else if (outcome.status === 'dup') dup++
        else if (outcome.status === 'unsatisfied') unsatisfied++
        else fail++
        if (prot?.enabled && prot.downloadIntervalSec > 0 && idx < songs.length - 1) {
          await sleep(prot.downloadIntervalSec * 1000)
        }
        repo.insertHistoryItem({
          batchId, taskId, songKey: song.songKey, songName: song.name, singer: song.singer,
          status: outcome.status === 'dup' ? 'skipped_dup' : outcome.status,
          quality: outcome.quality,
          errorReason: outcome.reason,
        })
        this.emit('song-status', taskId, {
          songKey: song.songKey, songName: song.name, status: outcome.status,
          quality: outcome.quality, errorReason: outcome.reason,
        })
      }
      const result = fail > 0 || unsatisfied > 0 ? (ok > 0 ? 'partial' : 'failed') : 'success'
      repo.finishBatch(batchId, {
        finishedAt: new Date().toISOString(), result,
        okCount: ok, failCount: fail, unsatisfiedCount: unsatisfied, dupCount: dup, dedupCount: 0, removedCount: 0,
      })
      repo.updateTask(taskId, { lastRunAt: new Date().toISOString(), lastResult: result })
      repo.setSnapshot(taskId, songs.map((s) => s.songKey))
      logger.info(`[engine] 手动下载完成: ok=${ok} fail=${fail} dup=${dup} unsatisfied=${unsatisfied}`)
      // 触发一次媒体库扫描帮助入库（Navidrome no-op；Emby 索引新文件）
      try {
        const libId = await this.emby.resolveLibraryId()
        if (libId) await this.emby.scanLibrary(libId)
      } catch { /* 扫描失败不阻断 */ }
      return { ok, fail, dup, unsatisfied }
    } catch (e) {
      const msg = (e as Error).message
      logger.warn(`[engine] 手动下载异常: ${msg}`)
      repo.finishBatch(batchId, {
        finishedAt: new Date().toISOString(), result: 'failed',
        okCount: ok, failCount: fail, unsatisfiedCount: unsatisfied, dupCount: dup, dedupCount: 0, removedCount: 0,
      })
      throw new Error(msg)
    } finally {
      this.runningTaskId = null
      this.emit('batch-finish', taskId, batchId, 'success')
    }
  }

  /**
   * 单曲重试（历史页 [重试]）：不进 plan/diff，直接对目标歌重走下载流程
   * 成功自动补 Emby 入库 + 入歌单
   */
  async retrySong(taskId: number, songKey: string): Promise<string> {
    if (this.runningTaskId !== null) return 'skipped-busy'
    const task = repo.getTask(taskId)
    if (!task) return 'task-not-found'
    const songs = await this.lx.getSongs(task.lxPlaylistKey)
    const song = songs.find((s) => s.songKey === songKey)
    if (!song) return 'song-not-in-source'

    this.runningTaskId = taskId
    const batchId = repo.createBatch({ taskId, trigger: 'retry' })
    try {
      logger.info(`[engine] 重试 ${song.name} (${songKey})`)
      const outcome = await this.downloadOne(taskId, task, song)
      const status = outcome.status === 'success' || outcome.status === 'dup' ? 'success' : outcome.status
      repo.insertHistoryItem({
        batchId,
        taskId,
        songKey: song.songKey,
        songName: song.name,
        singer: song.singer,
        status: outcome.status === 'dup' ? 'skipped_dup' : outcome.status,
        quality: outcome.quality,
        errorReason: outcome.reason,
      })
      repo.finishBatch(batchId, {
        finishedAt: new Date().toISOString(),
        result: status === 'success' ? 'success' : 'failed',
        okCount: status === 'success' ? 1 : 0,
        failCount: status === 'success' ? 0 : 1,
        detail: outcome.reason,
      })
      repo.updateTask(taskId, { lastRunAt: new Date().toISOString(), lastResult: status === 'success' ? 'success' : 'failed' })
      this.emit('batch-finish', taskId, batchId, status === 'success' ? 'success' : 'failed')
      return status
    } catch (e) {
      const msg = (e as Error).message
      repo.finishBatch(batchId, { finishedAt: new Date().toISOString(), result: 'failed', detail: msg })
      return 'error'
    } finally {
      this.runningTaskId = null
    }
  }

  /** 完全同步：移除源歌单已删除的歌（从目标歌单移除；文件默认保留） */
  private async removeSongs(taskId: number, task: ReturnType<typeof repo.getTask> & {}, songKeys: string[]): Promise<number> {
    let removed = 0
    const cfg = this.cfg()
    const playlistIds: string[] = [...task.embyTargetPlaylistIdsParsed]
    if (task.createSameNamePlaylist) {
      const same = await this.findPlaylistByName(task.lxPlaylistName)
      if (same) playlistIds.push(same.id)
    }
    for (const songKey of songKeys) {
      const map = repo.getEmbyMap(songKey)
      if (!map) continue
      for (const pid of new Set(playlistIds)) {
        const items = await this.emby.listPlaylistItems(pid)
        const entry = items.find((it) => it.itemId === map.embySongId)
        if (entry?.entryId) {
          await this.emby.removeItems(pid, [entry.entryId])
          removed++
        }
      }
      // 清理引用与状态（文件保留，除非开 cleanupOrphanFiles）
      getDb().prepare('DELETE FROM task_song_ref WHERE taskId = ? AND songKey = ?').run(taskId, songKey)
      getDb().prepare('DELETE FROM current_song_status WHERE taskId = ? AND songKey = ?').run(taskId, songKey)
    }
    // 清理孤立文件（可选）
    if (cfg.general.cleanupOrphanFiles) {
      // 交给维护任务/界面按钮触发，此处仅记录
      console.log('[engine] cleanupOrphanFiles 开启，孤立文件待维护任务处理')
    }
    return removed
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
