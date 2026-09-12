import { EventEmitter } from 'node:events'
import path from 'node:path'
import { rmSync, renameSync, existsSync } from 'node:fs'
import type { AppConfig, DelPolicy, Quality } from '../config.js'
import { HIGH_RES_FLAC, QUALITY_ORDER, supportsFileDelete, archiveNameOf } from '../config.js'
import type { LxSong } from '../adapters/lxserver.js'
import { LxServerAdapter } from '../adapters/lxserver.js'
import type { MediaServerAdapter } from '../adapters/media-server.js'
import { moveToPlaylistDir, renderFilename } from './file-manager.js'
import { validateFile, sniffFlacBits } from './validator.js'
import * as repo from '../store/repo.js'
import { getDb, taskSemantics } from '../store/db.js'
import { moveToTrash } from './trash.js'
import { logger } from './logger.js'

/** checkRun 拦截原因 → 给用户看的话（路由回复 / 日志共用一份，避免两处走样） */
export const RUN_BLOCKED: Record<'paused' | 'busy' | 'not-found' | 'disabled', string> = {
  paused: '已开启「全部暂停」（下载选项里），先关掉再同步',
  busy: '已有任务在运行（全局单飞），等它跑完再试',
  'not-found': '任务不存在（可能已被删除）',
  disabled: '任务已停用（定时已停），需先启用',
}

export interface EngineEvents {
  'batch-start': (taskId: number, batchId: number) => void
  'song-status': (taskId: number, payload: { songKey: string; songName: string; status: string; quality?: string; errorReason?: string }) => void
  'batch-finish': (taskId: number, batchId: number, result: string) => void
}

/** 本次运行里已处理完的一首歌（实时面板的"最近"列表用） */
export interface LiveSong {
  songKey: string
  name: string
  singer: string
  status: string
  quality?: string
  reason?: string
}

/**
 * 实时进度（内存态）。单飞引擎所以只要一个槽：任务进度页据此显示
 * "正在下载第几首/共几首、当前阶段、当前歌曲、成功失败计数"。
 */
export interface LiveProgress {
  taskId: number
  taskName: string
  taskType: string
  batchId: number
  trigger: string
  startedAt: number
  finishedAt: number | null
  /** 准备中 | 处理移除 | 解析直链 | 下载中 | 校验入库 | 写入媒体库 | 完成 | 失败 */
  phase: string
  /** 第几首（1-based） */
  index: number
  /** 本次待处理总数 */
  total: number
  /** 已处理完的歌曲数 */
  done: number
  ok: number
  fail: number
  unsat: number
  dedup: number
  removed: number
  current: { name: string; singer: string; quality?: string } | null
  recent: LiveSong[]
  result?: string
  error?: string
}

export class SyncEngine {
  readonly events = new EventEmitter()
  private runningTaskId: number | null = null

  constructor(
    private cfg: () => AppConfig,
    private lx: LxServerAdapter,
    private emby: MediaServerAdapter,
  ) {}

  /** 本次运行已触发过扫描的媒体库（避免每首歌都触发一次全库刷新） */
  private scannedLibs = new Set<string>()

  /**
   * 当前这首歌是否真的请求过音源（解析直链/下载）。
   * 批量下载保护的节流只为"防音源限流"而存在，所以"已下载跳过"这类
   * 没碰音源的歌不该跟着睡 —— 否则换过同步目标后每首歌白等一个间隔。
   */
  private sourceHit = false

  /** 触发一次媒体库扫描；同一次运行内对同一媒体库只触发一次 */
  private async scanLibraryOnce(libraryId: string): Promise<void> {
    if (this.scannedLibs.has(libraryId)) return
    this.scannedLibs.add(libraryId)
    try {
      await this.emby.scanLibrary(libraryId)
      logger.info('[emby] 已触发媒体库扫描（本次运行仅一次，等待新文件入库）')
    } catch (e) {
      logger.warn(`[emby] 媒体库扫描触发失败：${(e as Error).message}`)
    }
  }

  get isRunning(): boolean {
    return this.runningTaskId !== null
  }

  /** 实时进度（内存态）；任务进度页读它显示"正在下载" */
  live: LiveProgress | null = null

  /** 开始一次运行：重置实时进度槽 */
  private liveBegin(opts: { taskId: number; taskName: string; taskType: string; batchId: number; trigger: string; total: number }): void {
    this.live = {
      ...opts,
      startedAt: Date.now(),
      finishedAt: null,
      phase: '准备中',
      index: 0,
      done: 0,
      ok: 0,
      fail: 0,
      unsat: 0,
      dedup: 0,
      removed: 0,
      current: null,
      recent: [],
    }
  }
  private liveSet(patch: Partial<LiveProgress>): void {
    if (this.live && this.live.finishedAt === null) Object.assign(this.live, patch)
  }
  private liveCount(status: string): void {
    if (!this.live) return
    if (status === 'success' || status === 'dup') this.live.ok++
    else if (status === 'unsatisfied') this.live.unsat++
    else if (status === 'dedup') this.live.dedup++
    else this.live.fail++
    this.live.done++
  }
  private livePush(row: LiveSong): void {
    if (!this.live) return
    this.live.recent.unshift(row)
    if (this.live.recent.length > 12) this.live.recent.length = 12
  }
  private liveEnd(result: string, error?: string): void {
    if (!this.live) return
    this.live.finishedAt = Date.now()
    this.live.phase = error ? '失败' : '完成'
    this.live.result = result
    this.live.error = error
    this.live.current = null
  }

  /**
   * 配置期：确保归档歌单存在（不存在则创建）——用户刚设定了这个目标 = 授权创建。
   * 运行期（removeSongs 里）只找不建：用户删掉的目标绝不静默重建，而是降级为"保留文件"。
   */
  async ensureArchiveTarget(name: string): Promise<{ ok: boolean; created: boolean; error?: string }> {
    try {
      if (await this.findPlaylistByName(name)) return { ok: true, created: false }
      await this.emby.createPlaylist(name)
      logger.info(`[engine] 已创建归档歌单「${name}」`)
      return { ok: true, created: true }
    } catch (e) {
      logger.warn(`[engine] 归档歌单「${name}」创建失败: ${(e as Error).message}`)
      return { ok: false, created: false, error: (e as Error).message }
    }
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

  /**
   * 运行前检查（同步、无副作用）。返回 null = 可以跑，否则是拦截原因码。
   *
   * ⚠️ 存在的理由：这些拦截原本散在 runTask 内部且**静默 return**，
   * 而路由在执行前就已经回了"已开始同步"——于是"停用的任务点同步"表现为
   * 界面说开始了、引擎一个字不说就退出（用户看到的"点了没反应"）。
   * 现在路由先用它拿到准确原因再回复。
   */
  checkRun(taskId: number, trigger: 'cron' | 'manual'): 'paused' | 'busy' | 'not-found' | 'disabled' | null {
    if (this.cfg().general.pauseAll) return 'paused'
    if (this.runningTaskId !== null) return 'busy'
    const task = repo.getTask(taskId)
    if (!task) return 'not-found'
    // 「停用」只停定时：手动运行是用户的明确指令，照跑（历史重试同理）
    if (!task.enabled && trigger === 'cron') return 'disabled'
    return null
  }

  /** 主入口：执行一个任务（全局单飞：一次只跑一个任务） */
  async runTask(taskId: number, trigger: 'cron' | 'manual'): Promise<string> {
    const blocked = this.checkRun(taskId, trigger)
    if (blocked) {
      logger.info(`[engine] task#${taskId} 本次未执行（${RUN_BLOCKED[blocked]}）`)
      return blocked === 'disabled' ? 'task-disabled' : blocked === 'paused' ? 'skipped-paused' : blocked === 'busy' ? 'skipped-busy' : 'task-not-found'
    }
    const task = repo.getTask(taskId)
    if (!task) return 'task-not-found'

    this.runningTaskId = taskId
    this.scannedLibs.clear() // 每次运行重置：扫描配额与播放列表缓存都按次算，不跨次
    this.playlistCache = null
    const batchId = repo.createBatch({ taskId, trigger })
    this.emit('batch-start', taskId, batchId)
    this.liveBegin({ taskId, taskName: task.lxPlaylistName, taskType: task.taskType ?? 'playlist', batchId, trigger, total: 0 })

    let okCount = 0
    let failCount = 0
    let unsatisfiedCount = 0
    let dupCount = 0
    let dedupCount = 0
    let removedCount = 0

    try {
      logger.info(`[engine] task#${taskId}(${task.lxPlaylistName}) ${trigger} 开始`)
      // 榜单订阅：歌曲源 = 榜单 API（订阅范围前 N 首，0=全榜）；默认增量，可切镜像（跌出即处理）
      const isChart = task.taskType === 'chart'
      let songs: LxSong[]
      if (isChart) {
        const full = await this.lx.getChartSongs(task.chartSource ?? '', task.chartId ?? '')
        const N = Number(task.maxCount ?? 30)
        songs = N > 0 ? full.slice(0, N) : full
      } else {
        songs = await this.lx.getSongs(task.lxPlaylistKey)
      }

      // diff:新语义 mode(null=旧任务按 syncMode 映射:full→mirror+keep)
      const sem = taskSemantics(task)
      const mirror = sem.taskMode === 'mirror'
      // "源消失"保护：镜像绝不能把"拉不到源"当成"全被移除"而清空目标播放列表
      // （空数组本身就是"待移除全部"的信号，所以只在 0 首时才判定）
      if (mirror && songs.length === 0) {
        if (isChart) {
          // 榜单永远不可能是"合法的空榜"：拉到 0 首 = 榜单 id 失效/接口异常
          repo.updateTask(taskId, { enabled: 0, lastRunAt: new Date().toISOString(), lastResult: '榜单拉取为空(已停用)' })
          throw new Error(`榜单「${task.lxPlaylistName}」本次拉取到 0 首（榜单 id 失效或接口异常）——已停用本任务，未做任何移除`)
        }
        if (!(await this.lx.hasPlaylist(task.lxPlaylistKey))) {
          repo.updateTask(taskId, { enabled: 0, lastRunAt: new Date().toISOString(), lastResult: '源歌单已不存在(已停用)' })
          throw new Error(`源歌单「${task.lxPlaylistName}」在 LX 中已不存在(可能被删除)——已停用本任务,未做任何移除`)
        }
      }
      let toDownload: LxSong[]
      let toRemove: string[] = []
      if (!mirror) {
        toDownload = this.diffIncremental(taskId, songs)
      } else {
        const d = this.diffFull(taskId, songs)
        toDownload = d.toDownload
        toRemove = d.toRemove
      }
      logger.info(`[engine] ${isChart ? `榜单 ${task.lxPlaylistName}（范围 ${songs.length} 首）` : `源歌单 ${songs.length} 首`} | 模式=${sem.taskMode}/${sem.delPolicy} | 待下载 ${toDownload.length} | 待移除 ${toRemove.length}`)

      // 镜像:按删除策略处理已删除的歌
      let archiveDegraded: string | null = null
      if (toRemove.length > 0) {
        this.liveSet({ phase: '处理移除（镜像删除）', current: null })
        const r = await this.removeSongs(taskId, task, toRemove, sem)
        removedCount = r.removed
        archiveDegraded = r.archiveDegraded
        this.liveSet({ removed: r.removed })
      }

      // 逐歌下载（批量下载保护：每首结束后等待间隔，防音源限流）
      const prot = this.cfg().download.protection
      for (let idx = 0; idx < toDownload.length; idx++) {
        const song = toDownload[idx]
        this.liveSet({ index: idx + 1, total: toDownload.length, phase: '解析直链', current: { name: song.name, singer: song.singer } })
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
          this.liveCount(okAdd ? 'dedup' : 'failed')
          this.livePush({ songKey: song.songKey, name: song.name, singer: song.singer, status: okAdd ? 'dedup' : 'failed', quality: dedupHit.quality ?? undefined, reason: okAdd ? undefined : '查重命中但加入歌单失败' })
          continue
        }
        const outcome = await this.downloadOne(taskId, task, song)
        this.liveCount(outcome.status)
        this.livePush({ songKey: song.songKey, name: song.name, singer: song.singer, status: outcome.status, quality: outcome.quality, reason: outcome.reason })
        if (outcome.status === 'success') okCount++
        else if (outcome.status === 'dup') dupCount++
        else if (outcome.status === 'unsatisfied') unsatisfiedCount++
        else failCount++
        // 只有真请求过音源的歌才节流（防音源限流）；"已下载跳过"没碰音源，不睡
        if (prot?.enabled && prot.downloadIntervalSec > 0 && this.sourceHit && idx < toDownload.length - 1) {
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
      // 归档目标不存在 → 已降级为"保留文件"：结果照常，但在结果串/批次详情里留痕
      const resultTxt = archiveDegraded ? `${result}·归档降级` : result
      repo.finishBatch(batchId, {
        finishedAt: new Date().toISOString(),
        result,
        okCount,
        failCount,
        unsatisfiedCount,
        removedCount,
        dupCount,
        dedupCount,
        ...(archiveDegraded ? { detail: `归档歌单「${archiveDegraded}」不存在 → 已降级为保留文件(未重建)` } : {}),
      })
      repo.updateTask(taskId, {
        lastRunAt: new Date().toISOString(),
        lastResult: resultTxt,
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
        const dropped = prev ? prevKeys.filter((k) => !curSet.has(k)).length : 0
        repo.saveChartSnapshot({
          taskId,
          syncedAt: new Date().toISOString(),
          totalCount: curKeys.length,
          newCount,
          removedCount: dropped,
          songKeys: curKeys,
        })
        if (prev) {
          logger.info(`[engine] 榜单变化: 本期 ${curKeys.length} 首 | 新上榜 ${newCount} | 跌出 ${dropped}${mirror ? ` | 已按策略处理 ${removedCount} 首` : ''}`)
        }
      }
      logger.info(`[engine] task#${taskId} 完成: result=${result} ok=${okCount} fail=${failCount} unsatisfied=${unsatisfiedCount} dup=${dupCount} dedup=${dedupCount} removed=${removedCount}`)
      this.liveSet({ phase: '完成' })
      this.liveEnd(resultTxt)
      this.emit('batch-finish', taskId, batchId, result)
      return result
    } catch (e) {
      const err = (e as Error).message
      logger.error(`[engine] task#${taskId} 异常: ${err}`)
      repo.finishBatch(batchId, { finishedAt: new Date().toISOString(), result: 'failed', detail: err })
      this.liveEnd('failed', err)
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
    this.sourceHit = false // 本首歌是否请求过音源（节流判定用）
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
      // ⚠️ 必须确认文件还在磁盘上：登记表可能残留（手动删过 / 处理2 移入回收站后清空），
      //    只看登记的话这首歌会"永远跳过、再也下不回来"
      const existing = repo.findSongFile(song.songKey, quality)
      if (existing && !existsSync(existing.filePath)) {
        logger.warn(`[engine] ${song.name} [${quality}] 有登记但文件已不在磁盘（${existing.filePath}）→ 按需重新下载`)
      }
      if (existing && existsSync(existing.filePath)) {
        // 入库结果如实上报：文件在但入不了库（比如媒体库里已无此条目）应记 failed 以便下次重试，
        // 旧实现无条件记 success，会让这类问题永远不被发现
        const embyOk = opts?.skipIngest ? true : await this.ensureInEmby(taskId, task, song)
        // 登记归属：这首歌经本任务加入了目标歌单 → 记 task_song_ref。
        // ⚠️ 缺了它会有两个后果：① 处理2 删文件时 fileRefCount 少算，把别的任务还在用的文件移进回收站；
        //    ② 镜像删除时 hasTaskSongRef 为 false，被当成"非本任务加入"而永远不移除。
        if (embyOk) repo.refTaskFile(taskId, song.songKey, existing.id)
        repo.upsertSongStatus({
          taskId, songKey: song.songKey, songName: song.name, singer: song.singer,
          status: embyOk ? 'success' : 'failed', quality: existing.quality,
          errorReason: embyOk ? undefined : '文件已在库但入库失败',
        })
        return { status: 'dup', quality: existing.quality, reason: embyOk ? undefined : '文件已在库但入库失败' }
      }
      logger.info(`[engine] 下载 ${song.name} [${quality}]`)

      try {
        this.liveSet({ phase: '解析直链', current: { name: song.name, singer: song.singer, quality } })
        this.sourceHit = true // 到这里才算真的碰了音源
        const { url } = await this.lx.resolveUrl(song, quality)
        this.liveSet({ phase: '下载中', current: { name: song.name, singer: song.singer, quality } })
        await this.lx.requestDownload(song, url, quality, {
          embedLyric: cfg.download.embedLyric,
          cacheLyric: cfg.download.cacheLyric,
        })
        const file = await this.lx.waitForFile(song, quality)
        if (!file) {
          logger.warn(`[engine] ${song.name} [${quality}] 文件未出现(超时)`)
          continue // 尝试下一档
        }
        this.liveSet({ phase: '校验入库', current: { name: song.name, singer: song.singer, quality } })
        // 移到歌单目录
        const moved = moveToPlaylistDir({
          downloadRoot: cfg.lxserver.downloadRoot,
          srcFilename: file.filename,
          taskPlaylistName: dirName,
          absoluteDir: opts?.absoluteDir,
          song,
          quality,
          template: cfg.download.filenameTemplate,
          cacheLyric: cfg.download.cacheLyric,
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
        // 校验(格式/版本词/有损档码率/沉浸声容器);expectedCheck 用【实得档】——
        // 修复原盲区:master/hires 降级为 flac 时曾用原始档校验,不查 FLAC magic
        const v = validateFile(moved.filePath, song, effectiveQuality)
        if (!v.ok) {
          rmSync(moved.filePath, { force: true })
          logger.warn(`[engine] ${song.name} 校验失败: ${v.reasons.join('; ')}`)
          if (quality === qualities[qualities.length - 1]) {
            return { status: 'failed', quality, reason: v.reasons.join('; ') }
          }
          continue
        }
        for (const w of v.warnings ?? []) logger.warn(`[engine] ${song.name} ${w}`)
        // 有损档实测降级(320k→192k/128k 等;validator 已实测)
        if (v.actualQuality && v.actualQuality !== effectiveQuality) {
          effectiveQuality = v.actualQuality
        }
        // 降级档必须在勾选链内(未勾选绝不使用);统一覆盖 无损/有损 全部降级路径
        if (effectiveQuality !== quality && !qualities.includes(effectiveQuality)) {
          rmSync(moved.filePath, { force: true })
          return { status: 'unsatisfied', quality, reason: `实得 ${effectiveQuality}，未勾选该档` }
        }
        // 降级时修正文件名(如 flac24bit → flac / 320k → 128k)
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
        this.liveSet({ phase: '写入媒体库', current: { name: song.name, singer: song.singer, quality: effectiveQuality } })
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
      let fromCache = false
      if (!embySong) {
        // ① 先直接搜一次。绝大多数情况（文件早已入库、只是本任务还没记账，
        //    或换过同步目标导致条目 Id 缓存被清空）这里就能秒中。
        //    ⚠️ 原来是无条件"先全库扫描 + 先睡 5 秒再搜"，每首歌白等 5~30 秒：
        //    实测 7 首歌 92 秒里 65 秒耗在这上面（每首歌还顺带触发一次全库刷新）。
        const first = await this.emby.findSong(song.name, song.singer)
        if (first) {
          embySong = { embySongId: first.id, lastVerifiedAt: new Date().toISOString() }
          repo.setEmbyMap(song.songKey, first.id)
          logger.info(`[emby] ${song.name} 直接搜到（跳过扫描与等待）`)
        } else {
          // ② 搜不到才解析媒体库 + 触发扫描（新下载的文件 Emby 还没索引到）
          //    ——扫描每次运行最多一次，不按歌重复扫；resolveLibraryId 也一并挪进来（省掉每首歌一次 HTTP）
          const libraryId = (await this.emby.resolveLibraryId()) ?? undefined
          if (!libraryId) {
            logger.warn('[emby] 未找到匹配媒体库，跳过入库')
            return false
          }
          await this.scanLibraryOnce(libraryId)
          for (let i = 0; i < 6 && !embySong; i++) {
            await sleep(5000)
            const found = await this.emby.findSong(song.name, song.singer)
            if (found) {
              embySong = { embySongId: found.id, lastVerifiedAt: new Date().toISOString() }
              repo.setEmbyMap(song.songKey, found.id)
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
          // 同步进缓存：否则本任务后面的每首歌都以为它还不存在，会反复创建
          this.playlistCache?.push({ id: np.id, name: task.lxPlaylistName })
          playlistIds.push(np.id)
        }
      }
      for (const pid of new Set(playlistIds)) {
        try {
          await this.emby.addItems(pid, [embySong.embySongId])
        } catch (e) {
          if (!fromCache) throw e
          // 缓存里的条目 Id 可能来自"切换前的另一台服务器"（emby_song_map 不含服务器维度）
          // → 作废它并重新走一遍"扫描 + 搜索"，否则这首歌会永久失败
          logger.warn(`[emby] 缓存条目 Id 在当前服务器无效（${embySong.embySongId}）→ 已作废并重新解析: ${(e as Error).message}`)
          repo.clearEmbyMap(song.songKey)
          return this.ensureInEmby(taskId, task, song)
        }
      }
      return true
    } catch (e) {
      logger.warn(`[emby] 入库异常: ${(e as Error).message}`)
      return false
    }
  }

  /** 本次运行的播放列表缓存（不然每首歌都要拉一次全量列表，纯浪费往返） */
  private playlistCache: Awaited<ReturnType<MediaServerAdapter['listPlaylists']>> | null = null

  private async listPlaylistsCached() {
    if (!this.playlistCache) this.playlistCache = await this.emby.listPlaylists()
    return this.playlistCache
  }

  private async findPlaylistByName(name: string) {
    const list = await this.listPlaylistsCached()
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
    this.liveBegin({ taskId, taskName: task.lxPlaylistName, taskType: 'adhoc', batchId, trigger: 'manual', total: songs.length })
    let ok = 0
    let fail = 0
    let dup = 0
    let unsatisfied = 0
    const prot = this.cfg().download.protection
    try {
      logger.info(`[engine] 手动下载 ${songs.length} 首（落盘 downloadRoot/手动下载，不入歌单）`)
      for (let idx = 0; idx < songs.length; idx++) {
        const song = songs[idx]
        this.liveSet({ index: idx + 1, phase: '解析直链', current: { name: song.name, singer: song.singer } })
        const outcome = await this.downloadOne(taskId, task, song, {
          absoluteDir: path.join(this.cfg().lxserver.downloadRoot?.replace(/\/+$/, '') ?? '', '手动下载'),
          skipIngest: true,
        })
        this.liveCount(outcome.status)
        this.livePush({ songKey: song.songKey, name: song.name, singer: song.singer, status: outcome.status, quality: outcome.quality, reason: outcome.reason })
        if (outcome.status === 'success') ok++
        else if (outcome.status === 'dup') dup++
        else if (outcome.status === 'unsatisfied') unsatisfied++
        else fail++
        if (prot?.enabled && prot.downloadIntervalSec > 0 && this.sourceHit && idx < songs.length - 1) {
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
      this.liveEnd(result)
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
      this.liveEnd('failed', msg)
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

  /**
   * 镜像同步:按删除策略移除源歌单已删除的歌(delPolicy 见 docs/sync-redesign-spec.md)
   * - keep   : 从受管播放列表移除,文件保留(默认;旧 full 等价)
   * - delete : 同时把独占文件移入回收站(能力受限目标自动降级 keep),并触发媒体库扫描
   * - archive: 移除后把曲目加入归档歌单(文件保留,status/ref 清理以便 LX 重加时能重新入列)
   * provenance:新语义任务(mode 非空)只处理"本任务加入过"的条目(strictOwned);
   *           旧 full 任务(mode=null)保持历史行为(兼容迁移)。
   */
  private async removeSongs(
    taskId: number,
    task: ReturnType<typeof repo.getTask> & {},
    songKeys: string[],
    sem: { taskMode: 'incremental' | 'mirror'; delPolicy: DelPolicy },
  ): Promise<{ removed: number; archiveDegraded: string | null }> {
    let removed = 0
    let movedFiles = 0
    const cfg = this.cfg()
    const strictOwned = task.mode != null // 新语义任务启用所有权;旧 full 保持旧行为
    const delFile = sem.delPolicy === 'delete' && supportsFileDelete(cfg.target)
    const archive = sem.delPolicy === 'archive'
    if (sem.delPolicy === 'delete' && !delFile) {
      logger.warn(`[engine] task#${taskId} 删除策略=delete 但目标 ${cfg.target} 不支持物理删文件 → 已降级为 keep`)
    }

    // 受管播放列表:同名自动列表恒受管;已有列表按所有权
    const entries: { pid: string; managed: boolean }[] = []
    for (const pid of new Set(task.embyTargetPlaylistIdsParsed)) entries.push({ pid, managed: false })
    if (task.createSameNamePlaylist) {
      const same = await this.findPlaylistByName(task.lxPlaylistName)
      if (same) entries.push({ pid: same.id, managed: true })
    }

    const archiveName = archiveNameOf(task)
    let archiveId: string | null = null
    let archiveDegraded: string | null = null
    // 只找不建：目标被删 → 降级为「保留文件」，绝不重建用户删掉的东西（配置期才创建）
    const ensureArchive = async (): Promise<string | null> => {
      if (archiveId) return archiveId
      try {
        const ex = await this.findPlaylistByName(archiveName)
        if (ex) { archiveId = ex.id; return archiveId }
        if (!archiveDegraded) {
          archiveDegraded = archiveName
          logger.warn(`[engine] task#${taskId} 归档歌单「${archiveName}」不存在 → 降级为「保留文件」(不重建、不删除)`)
        }
        return null
      } catch (e) {
        logger.warn(`[engine] 归档歌单不可用: ${(e as Error).message}`)
        return null
      }
    }

    for (const songKey of songKeys) {
      const map = repo.getEmbyMap(songKey)
      if (!map) continue
      const owned = strictOwned ? repo.hasTaskSongRef(taskId, songKey) : true
      if (!owned) {
        logger.info(`[engine] ${songKey} 非本任务加入(所有权保护) → 不动其歌单成员`)
        continue
      }
      let removedHere = false
      for (const e of entries) {
        if (!e.managed && !strictOwned) continue // 旧任务:managed 语义 = 全部
        const items = await this.emby.listPlaylistItems(e.pid)
        const entry = items.find((it) => it.itemId === map.embySongId)
        if (entry?.entryId) {
          await this.emby.removeItems(e.pid, [entry.entryId])
          removed++
          removedHere = true
        }
      }
      if (!removedHere) continue
      // archive:曲目进归档歌单(文件不动)
      if (archive) {
        const aid = await ensureArchive()
        if (aid) {
          try {
            await this.emby.addItems(aid, [map.embySongId])
            logger.info(`[engine] ${songKey} → 归档歌单`)
          } catch (e) {
            logger.warn(`[engine] 归档加曲失败: ${(e as Error).message}`)
          }
        }
      }
      // delete:独占文件移回收站(被其它任务引用则保留)
      if (delFile) {
        for (const f of repo.listFilesForSong(songKey)) {
          if (repo.fileRefCount(f.fileId) > 1) {
            logger.info(`[engine] ${songKey} 文件仍被其它任务引用 → 保留`)
            continue
          }
          try {
            moveToTrash(cfg, f.filePath)
            movedFiles++
          } catch (e) {
            logger.warn(`[engine] 移回收站失败 ${f.filePath}: ${(e as Error).message}`)
          }
        }
      }
      // 清理引用与状态(允许 LX 日后重新加入时能再次入列/入歌单)
      getDb().prepare('DELETE FROM task_song_ref WHERE taskId = ? AND songKey = ?').run(taskId, songKey)
      getDb().prepare('DELETE FROM current_song_status WHERE taskId = ? AND songKey = ?').run(taskId, songKey)
    }
    // 物理删除后触发媒体库扫描清理缺失条目(Emby/Jellyfin;Navidrome 文件监听自动处理)
    if (movedFiles > 0 && (cfg.target === 'emby' || cfg.target === 'jellyfin')) {
      try {
        const lib = await this.emby.resolveLibraryId()
        if (lib) await this.emby.scanLibrary(lib)
      } catch { /* 扫描失败不阻断 */ }
    }
    if (movedFiles > 0) logger.info(`[engine] 删除策略=delete:${movedFiles} 个文件移入回收站(可恢复)`)
    return { removed, archiveDegraded }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
