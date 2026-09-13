import { EventEmitter } from 'node:events'
import path from 'node:path'
import { rmSync, renameSync, existsSync, statSync } from 'node:fs'
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

/** 下载/复用完成、待统一入库的一首歌 */
interface PendingIngest {
  song: LxSong
  /** 下载阶段的结果（入库后可能降级为 failed） */
  status: 'success' | 'dup' | 'dedup'
  quality?: string
  /** 文件路径（用于"只认我们自己那份"的路径匹配） */
  filePath?: string
  /** 查重命中：媒体库里已知的条目 id */
  knownId?: string
  /** 复用文件的登记 id（入库成功后补记任务归属） */
  fileId?: number
  /** 处理轨迹（下载阶段） */
  trace: string[]
}

/** 入库阶段的结果 */
interface IngestResult extends PendingIngest {
  ok: boolean
  reason?: string
  itemId?: string
  /** 是否通过"按完整路径精确查"命中（用于轨迹展示） */
  byPath?: boolean
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
   * 当前这首歌的处理轨迹（查库 / 尝试档位 / 下载 / 校验 / 入库 / 入歌单…）。
   * 写进 history_item.detail —— 只记"成功/跳过"时用户根本看不出歌是怎么处理的。
   */
  private trace: string[] = []
  private traceAdd(step: string): void {
    if (this.trace.length < 12) this.trace.push(step)
  }

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
  async ensureArchiveTarget(name: string, scope = 'shared'): Promise<{ ok: boolean; created: boolean; error?: string }> {
    try {
      if (await this.findPlaylistByName(name, scope)) return { ok: true, created: false }
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

  // ===== 历史快照助手（2026-09-13 进度历史页重构 P1）=====

  /** 引用快照：当前有哪些任务引用这个文件（历史页「引用情况」列） */
  private refTasks(fileId?: number | null): repo.RefTask[] {
    if (!fileId) return []
    return repo.fileRefTasks(fileId).map((tid) => ({
      taskId: tid,
      taskName: repo.getTask(tid)?.lxPlaylistName ?? `已删除的任务 #${tid}`,
    }))
  }

  /** 一首歌名下**所有**文件被哪些任务引用（去重；移除时一首歌可能有多份音质文件） */
  private refTasksOfSong(songKey: string): repo.RefTask[] {
    const seen = new Map<number, repo.RefTask>()
    for (const f of repo.listFilesForSong(songKey)) {
      for (const rt of this.refTasks(f.fileId)) if (!seen.has(rt.taskId)) seen.set(rt.taskId, rt)
    }
    return [...seen.values()]
  }

  /** 文件大小（字节）——落历史时快照一份，文件以后被删/移走也还查得到 */
  private sizeOf(filePath?: string | null): number | undefined {
    if (!filePath) return undefined
    try {
      return statSync(filePath).size
    } catch {
      return undefined
    }
  }

  /** 批次快照用：目标歌单的**名字**（同名歌单直接用歌单名） */
  private async targetPlaylistNames(task: NonNullable<ReturnType<typeof repo.getTask>>): Promise<string[]> {
    const ids = task.embyTargetPlaylistIdsParsed ?? []
    if (!ids.length) return task.createSameNamePlaylist ? [task.lxPlaylistName] : []
    try {
      const list = await this.emby.listPlaylists(this.scopeOf(task))
      return ids.map((id) => list.find((p) => p.id === id)?.name).filter((n): n is string => !!n)
    } catch {
      return [] // 拿不到名字就不快照（不阻断运行）
    }
  }

  /** 跳过名单上限：只存前 N 首的名字（防超大歌单把每批次的 JSON 撑爆），计数永远是准确的 */
  private static readonly SKIP_LIST_CAP = 500

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
    this.playlistCache.clear()
    const batchId = repo.createBatch({
      taskId,
      trigger,
      // 任务属性快照：任务以后被改配置/被删除，历史行仍能如实还原"当时是什么模式、发到哪个歌单"
      snapshot: {
        mode: taskSemantics(task).taskMode,
        delPolicy: taskSemantics(task).delPolicy,
        archivePlaylist: task.archivePlaylist ?? null,
        targetPlaylists: await this.targetPlaylistNames(task),
      },
    })
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
      // 跳过名单：本次源里有、但没进处理流程的歌（增量=已 success 过；镜像=已在快照里）
      // 历史页据此回答"这次为什么没有它"——不落成事件行（那是噪声），只挂在批次上
      const dlSet = new Set(toDownload.map((s) => s.songKey))
      const skippedSongs = songs.filter((s) => !dlSet.has(s.songKey))
      logger.info(`[engine] ${isChart ? `榜单 ${task.lxPlaylistName}（范围 ${songs.length} 首）` : `源歌单 ${songs.length} 首`} | 模式=${sem.taskMode}/${sem.delPolicy} | 待下载 ${toDownload.length} | 待移除 ${toRemove.length} | 跳过 ${skippedSongs.length}`)

      // 镜像:按删除策略处理已删除的歌
      let archiveDegraded: string | null = null
      let failedRemovals: string[] = []   // 本次没移除成功的歌：留在快照里下次继续试（见下方 setSnapshot）
      if (toRemove.length > 0) {
        this.liveSet({ phase: '处理移除（镜像删除）', current: null })
        const r = await this.removeSongs(taskId, task, toRemove, sem, batchId)
        removedCount = r.removed
        archiveDegraded = r.archiveDegraded
        failedRemovals = r.failedRemovals
        this.liveSet({ removed: r.removed })
      }

      // ── 阶段1：逐歌下载（**不碰媒体库**，只把文件备好；批量下载保护：每首结束后等待间隔）──
      const prot = this.cfg().download.protection
      const pending: PendingIngest[] = []
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
          pending.push({
            song, status: 'dedup', knownId: dedupHit.id, quality: dedupHit.quality ?? undefined,
            trace: [`查重：库里已有《${dedupHit.quality ?? '同曲'}》→ 不重复下载`],
          })
          this.liveCount('dedup')
          this.livePush({ songKey: song.songKey, name: song.name, singer: song.singer, status: 'dedup', quality: dedupHit.quality ?? undefined })
          continue
        }
        const outcome = await this.downloadOne(taskId, task, song, { deferIngest: true })
        this.liveCount(outcome.status)
        this.livePush({ songKey: song.songKey, name: song.name, singer: song.singer, status: outcome.status, quality: outcome.quality, reason: outcome.reason })
        if (outcome.status === 'success' || outcome.status === 'dup') {
          if (outcome.status === 'success') okCount++
          else dupCount++
          pending.push({
            song, status: outcome.status, quality: outcome.quality,
            filePath: outcome.filePath, fileId: outcome.fileId, trace: this.trace,
          })
        } else {
          // 下载失败/各档位都不满足：不需要入库，直接落历史
          if (outcome.status === 'unsatisfied') unsatisfiedCount++
          else failCount++
          repo.insertHistoryItem({
            batchId, taskId, songKey: song.songKey, songName: song.name, singer: song.singer,
            status: outcome.status, quality: outcome.quality, detail: this.trace, errorReason: outcome.reason,
            action: 'in',
            // 没下成：要么音质链全拿不到（未满足），要么各档位试过都失败
            process: outcome.status === 'unsatisfied' ? 'unsatisfied' : 'download_fail',
          })
          this.emit('song-status', taskId, {
            songKey: song.songKey, songName: song.name, status: outcome.status,
            quality: outcome.quality, errorReason: outcome.reason,
          })
        }
        // 只有真请求过音源的歌才节流（防音源限流）；"已下载跳过"没碰音源，不睡
        if (prot?.enabled && prot.downloadIntervalSec > 0 && this.sourceHit && idx < toDownload.length - 1) {
          await sleep(prot.downloadIntervalSec * 1000)
        }
      }

      // ── 阶段2：批量入库（此时本次所有文件都已落盘 → 一次扫描即可全部索引到）──
      if (pending.length) {
        const ingested = await this.ingestPending(taskId, task, pending)
        for (const r of ingested) {
          if (!r.ok) {
            // 入库失败的，从原计数挪到失败
            if (r.status === 'dedup') dedupCount--
            else if (r.status === 'dup') dupCount--
            else okCount--
            failCount++
          }
          const histStatus = !r.ok ? 'failed' : r.status === 'dup' ? 'skipped_dup' : r.status
          const taskStatus = !r.ok ? 'failed' : r.status === 'dedup' ? 'dedup' : 'success'
          repo.upsertSongStatus({
            taskId, songKey: r.song.songKey, songName: r.song.name, singer: r.song.singer,
            status: taskStatus, quality: r.quality, errorReason: r.ok ? undefined : (r.reason ?? 'Emby 入库失败'),
          })
          // 引用快照：在「记归属」前后各取一次 —— 这正是排查"为什么这个文件没被删/为什么复用了"的关键
          // ⚠️ 新下载的文件是这一刻才出现的，之前必然无人引用（downloadOne 里已经写过归属，直接查会误报"本来就有"）
          const refBefore = r.status === 'success' ? [] : this.refTasks(r.fileId)
          if (r.ok && r.fileId) repo.refTaskFile(taskId, r.song.songKey, r.fileId)
          repo.insertHistoryItem({
            batchId, taskId, songKey: r.song.songKey, songName: r.song.name, singer: r.song.singer,
            status: histStatus, quality: r.quality, detail: r.trace,
            errorReason: r.ok ? undefined : (r.reason ?? 'Emby 入库失败'),
            action: 'in',
            process: !r.ok
              ? 'ingest_fail'
              : r.status === 'dedup'
                ? 'dedup_skip'
                : r.status === 'dup'
                  ? 'reuse_skip'
                  : 'download_new',
            filePath: r.filePath,
            fileSize: this.sizeOf(r.filePath),
            refBefore,
            refAfter: this.refTasks(r.fileId),
          })
          this.emit('song-status', taskId, {
            songKey: r.song.songKey, songName: r.song.name, status: histStatus,
            quality: r.quality, errorReason: r.ok ? undefined : (r.reason ?? 'Emby 入库失败'),
          })
        }
        // 实时面板的计数按最终结果校正（下载阶段是乐观计数）
        this.liveSet({ ok: okCount + dupCount, fail: failCount, unsat: unsatisfiedCount, dedup: dedupCount })
      }

      const result = failCount > 0 || unsatisfiedCount > 0 ? (okCount > 0 ? 'partial' : 'failed') : 'success'
      // 归档目标不存在 → 已降级为"保留文件"：结果照常，但在结果串/批次详情里留痕
      const resultTxt = archiveDegraded ? `${result}·归档降级` : result
      // 榜单：先把变化统计算出来（要写进批次摘要，故放在 finishBatch 之前）
      let chartJson: string | null = null
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
        chartJson = JSON.stringify({ total: curKeys.length, new: newCount, removed: dropped })
        if (prev) {
          logger.info(`[engine] 榜单变化: 本期 ${curKeys.length} 首 | 新上榜 ${newCount} | 跌出 ${dropped}${mirror ? ` | 已按策略处理 ${removedCount} 首` : ''}`)
        }
      }
      repo.finishBatch(batchId, {
        finishedAt: new Date().toISOString(),
        result,
        chartJson,
        // 跳过名单（超过上限只存前 N 首的名字，计数永远准确）
        skippedCount: skippedSongs.length,
        skippedJson: skippedSongs.length
          ? JSON.stringify(skippedSongs.slice(0, SyncEngine.SKIP_LIST_CAP).map((s) => ({ key: s.songKey, name: s.name })))
          : null,
        okCount,
        failCount,
        unsatisfiedCount,
        removedCount,
        dupCount,
        dedupCount,
        detail: [
          // 批次级摘要：让"什么都没做"的运行也有话可说（原来 detail 为 null → 历史里是条空记录）
          archiveDegraded ? `归档歌单「${archiveDegraded}」不存在 → 已降级为保留文件(未重建)` : '',
          toDownload.length === 0 && toRemove.length === 0
            ? `${isChart ? '榜单' : '源歌单'} ${songs.length} 首 · 本次无待处理（均已同步过，无需下载也无需移除）`
            : '',
          toRemove.length && removedCount === 0 ? `待移除 ${toRemove.length} 首，实际未移除（见下方明细）` : '',
        ].filter(Boolean).join(' ｜ ') || null,
      })
      repo.updateTask(taskId, {
        lastRunAt: new Date().toISOString(),
        lastResult: resultTxt,
      })
      // 快照：完全同步语义的删除检测依据 = 本次源歌单全集
      // ⚠️ 本次**没移除成功**的歌要留在快照里 —— 否则它们从此不再出现在"待移除"里，静默漏掉
      repo.setSnapshot(taskId, [...new Set([...songs.map((s) => s.songKey), ...failedRemovals])])
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
    opts?: { dirName?: string; absoluteDir?: string; skipIngest?: boolean; deferIngest?: boolean },
  ): Promise<{
    status: 'success' | 'failed' | 'unsatisfied' | 'dup'
    quality?: string
    reason?: string
    filePath?: string
    fileId?: number
    /** 复用旧文件时：**记归属之前**的引用快照（新下载的文件必然是空） */
    refsBefore?: repo.RefTask[]
  }> {
    this.sourceHit = false // 本首歌是否请求过音源（节流判定用）
    this.trace = []        // 本首歌的处理轨迹
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
        this.traceAdd(`查库：登记有《${quality}》但文件已不在磁盘 → 重新下载`)
      }
      if (existing && existsSync(existing.filePath)) {
        this.traceAdd(`查库：本地已有《${existing.quality}》→ 复用文件（不重新下载）`)
        if (opts?.deferIngest) {
          // 批量入库模式：这里只负责"文件已就绪"，入库/入歌单统一放到阶段2
          return { status: 'dup', quality: existing.quality, filePath: existing.filePath, fileId: existing.id }
        }
        // 入库结果如实上报：文件在但入不了库（比如媒体库里已无此条目）应记 failed 以便下次重试，
        // 旧实现无条件记 success，会让这类问题永远不被发现
        const refsBefore = this.refTasks(existing.id) // 记归属**之前**取，历史页要靠它解释"为什么复用/为什么没删"
        const embyOk = opts?.skipIngest
          ? true
          : await this.ensureInEmby(taskId, task, song, undefined, { expectPath: path.basename(existing.filePath), expectPathFull: existing.filePath })
        // 登记归属：这首歌经本任务加入了目标歌单 → 记 task_song_ref。
        // ⚠️ 缺了它会有两个后果：① 处理2 删文件时 fileRefCount 少算，把别的任务还在用的文件移进回收站；
        //    ② 镜像删除时 hasTaskSongRef 为 false，被当成"非本任务加入"而永远不移除。
        if (embyOk) repo.refTaskFile(taskId, song.songKey, existing.id)
        repo.upsertSongStatus({
          taskId, songKey: song.songKey, songName: song.name, singer: song.singer,
          status: embyOk ? 'success' : 'failed', quality: existing.quality,
          errorReason: embyOk ? undefined : '文件已在库但入库失败',
        })
        return {
          status: 'dup', quality: existing.quality, reason: embyOk ? undefined : '文件已在库但入库失败',
          filePath: existing.filePath, fileId: existing.id, refsBefore,
        }
      }
      logger.info(`[engine] 下载 ${song.name} [${quality}]`)
      this.traceAdd(`解析直链：${quality}`)

      try {
        this.liveSet({ phase: '解析直链', current: { name: song.name, singer: song.singer, quality } })
        this.sourceHit = true // 到这里才算真的碰了音源
        const { url } = await this.lx.resolveUrl(song, quality)
        // 下载前先探一眼：① 取不到 → 7 毫秒就知道（比等 20 秒超时快 3 个数量级）
        //                ② 源静默降级（要给 MP3 / 16bit）→ 也能当场识破，不必白下白等
        const probe = await this.lx.probeUrl(url, song.interval)
        if (!probe.ok) throw new Error(`直链探测取不到（${probe.reason}）`)
        if (probe.quality && QUALITY_ORDER.indexOf(probe.quality) > QUALITY_ORDER.indexOf(quality)) {
          // 实测：请求 hires 时源塞来一个 10MB 的 MP3，lxserver 会把它存成 320k，
          // 而我们按 quality 找文件永远等不到 → 白等 20 秒 + 白下一遍。这里直接换下一档。
          throw new Error(`源降级：请求 ${quality} 实得 ${probe.quality} → 换下一档`)
        }
        this.liveSet({ phase: '下载中', current: { name: song.name, singer: song.singer, quality } })
        await this.lx.requestDownload(song, url, quality, {
          embedLyric: cfg.download.embedLyric,
          cacheLyric: cfg.download.cacheLyric,
        })
        // 阶梯超时：成功的下载实测 4 秒就落盘，而失败档位要死等 60 秒 —— 那是成功耗时的 15 倍。
        // 非最后一档只探 20 秒（没戏就赶紧换下一档），**最后一档**才给满 60 秒
        // （它是最后的希望，宁可多等也别把本来能成的档位判死）
        const isLastQuality = quality === qualities[qualities.length - 1]
        const file = await this.lx.waitForFile(song, quality, isLastQuality ? 60000 : 20000)
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
              this.traceAdd(`校验：请求 ${quality} 实得 ${sniff.bits}bit → 降档收录为 flac`)
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
        this.traceAdd(`已下载并收录为《${effectiveQuality}》→ ${path.basename(moved.filePath)}`)
        this.liveSet({ phase: '写入媒体库', current: { name: song.name, singer: song.singer, quality: effectiveQuality } })
        if (opts?.deferIngest) {
          // 批量入库模式：入库/入歌单统一放到阶段2（文件刚落盘，此时扫描才能一并索引到）
          return { status: 'success', quality: effectiveQuality, filePath: moved.filePath, fileId }
        }
        // Emby 入库 + 入歌单（手动下载 skipIngest：仅落盘，媒体库扫描自然入库）
        const embyOk = opts?.skipIngest
          ? true
          : await this.ensureInEmby(taskId, task, song, undefined, { expectPath: path.basename(moved.filePath), expectPathFull: moved.filePath })
        repo.upsertSongStatus({
          taskId, songKey: song.songKey, songName: song.name, singer: song.singer,
          status: embyOk ? 'success' : 'failed', quality: effectiveQuality,
          errorReason: embyOk ? undefined : 'Emby 入库失败',
        })
        return { status: embyOk ? 'success' : 'failed', quality: effectiveQuality, reason: embyOk ? undefined : 'Emby 入库失败' }
      } catch (e) {
        const msg = (e as Error).message
        logger.warn(`[engine] ${song.name} [${quality}] 失败: ${msg}`)
        this.traceAdd(`${quality}：${msg}`)
        if (quality === qualities[qualities.length - 1]) {
          return { status: qualities.length > 1 ? 'unsatisfied' : 'failed', quality, reason: msg }
        }
      }
    }
    return { status: 'unsatisfied', reason: '无可用音质' }
  }

  /** Emby 侧：加入目标歌单（含同名创建）。knownId 提供时（查重命中）跳过扫描直接入歌单 */
  /**
   * 批量入库：把「下载/复用完成的歌」集中处理。
   *
   * 为什么集中：Emby 的媒体库扫描是**异步**的，扫描开始时还没落盘的文件不在其范围内。
   * 逐首歌"下载→扫描→等 30 秒"的做法，除了第一首，后面每首都注定等不到（实测：
   * 9 首歌跑了 9 分钟、6 首白等 30 秒后判失败）。集中之后：
   *   ① 先逐首解析（已入库的、查重命中的秒中）
   *   ② 剩下的**此时才触发一次扫描**（所有文件都已落盘）→ 共享轮询等待
   *   ③ 按目标歌单**批量**加入（原来每首歌都单独调一次 API）
   */
  private async ingestPending(
    taskId: number,
    task: NonNullable<ReturnType<typeof repo.getTask>>,
    pending: PendingIngest[],
  ): Promise<IngestResult[]> {
    const results: IngestResult[] = pending.map((p) => ({ ...p, ok: false, trace: [...p.trace] }))

    const resolve = async (r: IngestResult): Promise<string | null> => {
      if (r.knownId) return r.knownId
      // ① 首选：按完整路径精确查（Emby 支持 /Items?Path=）
      //    按歌名搜不可靠——常见歌名能搜出几十条，目标可能排在 limit 之外（实测：「此刻」55 条、目标第 35 位）
      if (r.filePath && this.emby.findItemByPath) {
        try {
          const hit = await this.emby.findItemByPath(r.filePath)   // 传本地路径，适配器自己换算成服务器视角
          if (hit) { r.byPath = true; return hit.id }
        } catch (e) {
          logger.warn(`[media] 按路径查条目失败（回退按歌名搜）: ${(e as Error).message}`)
        }
      }
      // ② 回退：按歌名搜 + 路径后缀过滤（其他服务器 / 路径映射不可用时）
      const want = r.filePath ? path.basename(r.filePath) : undefined
      const found = await this.emby.findSongWithQuality(r.song.name, r.song.singer, want ? { pathEndsWith: want } : undefined)
      return found ? found.id : null
    }

    // ① 先逐首解析（dup / 查重命中的通常秒中）
    const unresolved: IngestResult[] = []
    for (const r of results) {
      const id = await resolve(r)
      if (id) {
        r.itemId = id
        r.ok = true
        if (!r.knownId) r.trace.push(r.byPath ? '媒体库：按完整路径精确查到条目' : '媒体库：按歌名搜到条目（路径匹配）')
        repo.setEmbyMap(r.song.songKey, id)   // 记进条目缓存：镜像移除 / 手动删除都要靠它定位
      } else unresolved.push(r)
    }

    // ② 仍未解析到的（本次新下载的）→ 一次扫描 + 共享轮询
    if (unresolved.length) {
      const libraryId = (await this.emby.resolveLibraryId()) ?? undefined
      if (!libraryId) {
        logger.warn('[emby] 未找到匹配媒体库，跳过入库')
      } else {
        await this.scanLibraryOnce(libraryId)
        const ROUNDS = 18 // 最多等 3 分钟（每轮 10 秒）
        for (let round = 0; round < ROUNDS && unresolved.some((r) => !r.ok); round++) {
          this.liveSet({ phase: `等待媒体库索引（${unresolved.filter((r) => r.ok).length}/${unresolved.length}）`, current: null })
          await sleep(10000)
          for (const r of unresolved) {
            if (r.ok) continue
            const id = await resolve(r)
            if (id) {
              r.itemId = id
              r.ok = true
              r.trace.push('媒体库：扫描索引后找到条目')
              repo.setEmbyMap(r.song.songKey, id)
            }
          }
        }
        this.liveSet({ phase: `等待媒体库索引（${unresolved.filter((r) => r.ok).length}/${unresolved.length}）`, current: null })
      }
    }

    // ③ 按目标歌单批量加入
    const ready = results.filter((r) => r.ok)
    if (ready.length) await this.addAllToPlaylists(task, ready)

    // ④ 收尾：把没解析到的标失败
    for (const r of results) {
      if (!r.ok) {
        r.reason = 'Emby 入库失败'
        r.trace.push('媒体库：等待超时仍未索引到条目 → 入库失败')
      } else if (!r.itemId) {
        r.ok = false
        r.reason = r.reason ?? '加入歌单失败'
      }
    }
    return results
  }

  /** 把一批已解析到条目的歌，按目标歌单分组批量加入（每首歌记一条轨迹） */
  private async addAllToPlaylists(task: NonNullable<ReturnType<typeof repo.getTask>>, songs: IngestResult[]): Promise<void> {
    if (this.emby.kind === 'daoliyu') {
      for (const s of songs) s.trace.push('入库：目录驱动（落盘即入库，无需加入歌单）')
      return
    }
    const scope = this.scopeOf(task)
    const targets: { pid: string; label: string }[] = []
    for (const pid of new Set(task.embyTargetPlaylistIdsParsed)) targets.push({ pid, label: '（已有歌单）' })
    if (task.createSameNamePlaylist) {
      const same = await this.findPlaylistByName(task.lxPlaylistName, scope)
      if (same) targets.push({ pid: same.id, label: `「${task.lxPlaylistName}」` })
      else {
        const np = await this.emby.createPlaylist(task.lxPlaylistName)
        this.playlistCache.get(scope)?.push({ id: np.id, name: task.lxPlaylistName })
        targets.push({ pid: np.id, label: `「${task.lxPlaylistName}」(新建)` })
      }
    }
    if (!targets.length) {
      for (const s of songs) s.trace.push('入库：未启用任何目标歌单')
      return
    }
    for (const t of targets) {
      const ids = songs.filter((s) => s.ok && s.itemId).map((s) => s.itemId!)
      if (!ids.length) continue
      // ⚠️ 加入前先看歌单里有没有它：Emby 允许同一条重复加入，不查就会越加越多
      // （实测：同一首歌被重复处理几次后，歌单里出现 5 条一模一样的条目）
      let present = new Set<string>()
      try {
        present = new Set((await this.emby.listPlaylistItems(t.pid)).map((x) => x.itemId))
      } catch { /* 读不到就按老办法加，交给服务端 */ }
      const toAdd = ids.filter((id) => !present.has(id))
      if (!toAdd.length) {
        for (const s of songs) if (s.ok) s.trace.push(`已在歌单${t.label}（无需重复加入）`)
        continue
      }
      try {
        await this.emby.addItems(t.pid, toAdd)
        for (const s of songs) {
          if (!s.ok || !s.itemId) continue
          s.trace.push(toAdd.includes(s.itemId) ? `加入歌单${t.label}` : `已在歌单${t.label}（无需重复加入）`)
        }
      } catch (e) {
        logger.warn(`[emby] 批量加入歌单失败: ${(e as Error).message}`)
        for (const s of songs) if (s.ok && toAdd.includes(s.itemId!)) { s.ok = false; s.reason = `加入歌单失败：${(e as Error).message}` }
      }
    }
  }

  private async ensureInEmby(
    taskId: number,
    task: ReturnType<typeof repo.getTask> & {},
    song: LxSong,
    knownId?: string,
    opts?: { expectPath?: string; expectPathFull?: string },
  ): Promise<boolean> {
    try {
      const cfg = this.cfg()
      let embySong = knownId ? { embySongId: knownId, lastVerifiedAt: new Date().toISOString() } : null
      let fromCache = false
      if (!embySong) {
        // ⚠️ 认条目必须带上"我们自己那份文件的路径"，不能只按歌名+歌手搜：
        // 库里常有同名旧副本（例如用户自己另建的合集目录），只按歌名搜会认到旧副本 ——
        // 结果是新下载的歌没进歌单，歌单反而挂到别人的文件上（实测踩到过）。
        const want = opts?.expectPath
        const q = want ? { pathEndsWith: want } : undefined
        // ① 先搜一次。绝大多数情况（文件早已入库、只是本任务还没记账，或换过同步目标
        //    导致条目 Id 缓存被清空）这里就能秒中。
        //    ⚠️ 原来是无条件"先全库扫描 + 先睡 5 秒再搜"，每首歌白等 5~30 秒：
        //    实测 7 首歌 92 秒里 65 秒耗在这上面（每首歌还顺带触发一次全库刷新）。
        // 先按完整路径精确查（常见歌名按名字搜会搜出一堆、目标可能排在 limit 之外）
        let found: { id: string } | null = null
        if (want && this.emby.findItemByPath && opts?.expectPathFull) {
          try {
            const hit = await this.emby.findItemByPath(opts.expectPathFull)
            if (hit) found = { id: hit.id }
          } catch { /* 回退按歌名搜 */ }
        }
        if (!found) found = await this.emby.findSongWithQuality(song.name, song.singer, q)
        if (found) {
          logger.info(`[emby] ${song.name} 直接搜到${want ? '（路径匹配到本任务的文件）' : ''}`)
          this.traceAdd(want ? '媒体库：按文件路径精确匹配到条目' : '媒体库：搜索命中已有条目')
        } else {
          // ② 搜不到才解析媒体库 + 触发扫描（新下载的文件 Emby 还没索引到）
          //    ——扫描每次运行最多一次，不按歌重复扫；resolveLibraryId 也一并挪进来（省掉每首歌一次 HTTP）
          const libraryId = (await this.emby.resolveLibraryId()) ?? undefined
          if (!libraryId) {
            logger.warn('[emby] 未找到匹配媒体库，跳过入库')
            return false
          }
          await this.scanLibraryOnce(libraryId)
          for (let i = 0; i < 6 && !found; i++) {
            await sleep(5000)
            found = await this.emby.findSongWithQuality(song.name, song.singer, q)
          }
          if (!found) {
            logger.warn(`[emby] 未找到入库的歌曲: ${song.name}（扫描可能需要更久）`)
            this.traceAdd('媒体库：扫描后仍未找到条目 → 入库失败')
            return false
          }
          this.traceAdd('媒体库：触发扫描后找到条目')
        }
        embySong = { embySongId: found.id, lastVerifiedAt: new Date().toISOString() }
        repo.setEmbyMap(song.songKey, found.id)
      }
      // 加入目标歌单（daoliyu 目录驱动：落盘即入库+入同名目录歌单，无需 API 操作）
      const playlistIds: string[] = this.emby.kind === 'daoliyu' ? [] : [...task.embyTargetPlaylistIdsParsed]
      if (task.createSameNamePlaylist) {
        const same = await this.findPlaylistByName(task.lxPlaylistName, this.scopeOf(task))
        if (same) {
          // 同名列表即本任务自动管理的同步目标 → 追加。
          // （旧"行为B不追加"会导致单次多首新歌的任务只加第一首——已修复；不需要自动管理时取消勾选"创建同名歌单"即可）
          playlistIds.push(same.id)
          this.traceAdd(`目标歌单「${task.lxPlaylistName}」已存在`)
        } else {
          const np = await this.emby.createPlaylist(task.lxPlaylistName)
          this.traceAdd(`新建歌单「${task.lxPlaylistName}」并加入`)
          // 同步进缓存：否则本任务后面的每首歌都以为它还不存在，会反复创建
          const sc = this.scopeOf(task)
          this.playlistCache.get(sc)?.push({ id: np.id, name: task.lxPlaylistName })
          playlistIds.push(np.id)
        }
      }
      const picked = task.embyTargetPlaylistIdsParsed.length
      if (picked) this.traceAdd(`加入已有歌单 ${picked} 个`)
      for (const pid of new Set(playlistIds)) {
        try {
          // 同上：已在歌单里就不重复加（Emby 允许重复加入，不查会越加越多）
          const present = new Set((await this.emby.listPlaylistItems(pid)).map((x) => x.itemId))
          if (present.has(embySong.embySongId)) {
            this.traceAdd('已在目标歌单（无需重复加入）')
            continue
          }
          await this.emby.addItems(pid, [embySong.embySongId])
        } catch (e) {
          if (!fromCache) throw e
          // 缓存里的条目 Id 可能来自"切换前的另一台服务器"（emby_song_map 不含服务器维度）
          // → 作废它并重新走一遍"扫描 + 搜索"，否则这首歌会永久失败
          logger.warn(`[emby] 缓存条目 Id 在当前服务器无效（${embySong.embySongId}）→ 已作废并重新解析: ${(e as Error).message}`)
          repo.clearEmbyMap(song.songKey)
          return this.ensureInEmby(taskId, task, song, undefined, opts)
        }
      }
      return true
    } catch (e) {
      logger.warn(`[emby] 入库异常: ${(e as Error).message}`)
      return false
    }
  }

  /** 本次运行的播放列表缓存（按作用域分桶；不然每首歌都要拉一次全量列表，纯浪费往返） */
  private playlistCache = new Map<string, Awaited<ReturnType<MediaServerAdapter['listPlaylists']>>>()

  /** 任务的目标歌单作用域：'shared'（所有人可见）或某个用户 id；未设按 shared 处理 */
  private scopeOf(t: { playlistScope?: string | null }): string {
    return (t.playlistScope ?? '').trim() || 'shared'
  }

  private async listPlaylistsCached(scope: string) {
    const hit = this.playlistCache.get(scope)
    if (hit) return hit
    const list = await this.emby.listPlaylists(scope)
    this.playlistCache.set(scope, list)
    return list
  }

  private async findPlaylistByName(name: string, scope: string) {
    const list = await this.listPlaylistsCached(scope)
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
      logger.info(`[engine] 手动下载 ${songs.length} 首（落盘 downloadRoot/歌单同步/手动下载，不入歌单）`)
      for (let idx = 0; idx < songs.length; idx++) {
        const song = songs[idx]
        this.liveSet({ index: idx + 1, phase: '解析直链', current: { name: song.name, singer: song.singer } })
        const outcome = await this.downloadOne(taskId, task, song, {
          // ⚠️ 必须落在「歌单同步」里面 —— 媒体库根目录是 downloadRoot/歌单同步，
          // 放到它的兄弟目录（downloadRoot/手动下载）等于永远不入库（实测踩到过）
          absoluteDir: path.join(this.cfg().lxserver.downloadRoot?.replace(/\/+$/, '') ?? '', '歌单同步', '手动下载'),
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
          detail: this.trace,
          action: 'in',
          process: outcome.status === 'success' ? 'download_new'
            : outcome.status === 'dup' ? 'reuse_skip'
              : outcome.status === 'unsatisfied' ? 'unsatisfied' : 'download_fail',
          filePath: outcome.filePath,
          fileSize: this.sizeOf(outcome.filePath),
          // success = 文件这次刚落地 → 之前必然无人引用；dup = 复用旧文件，引用照旧
          refBefore: outcome.refsBefore ?? (outcome.status === 'success' ? [] : this.refTasks(outcome.fileId)),
          refAfter: this.refTasks(outcome.fileId),
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
    // ⚠️ 榜单任务的 key 是 chart:<平台>:<榜单id>，不是歌单 key —— 一律用 getSongs 会抛
    //    "未知歌单 key"（实测：榜单订阅的歌点重试必然 500）
    const songs = task.taskType === 'chart'
      ? await this.lx.getChartSongs(task.chartSource ?? '', task.chartId ?? '')
      : await this.lx.getSongs(task.lxPlaylistKey)
    const song = songs.find((s) => s.songKey === songKey)
    if (!song) return 'song-not-in-source'

    this.runningTaskId = taskId
    const batchId = repo.createBatch({ taskId, trigger: 'retry' })
    try {
      logger.info(`[engine] 重试 ${song.name} (${songKey})`)
      const outcome = await this.downloadOne(taskId, task, song)
      // ⚠️ dup 不等于成功：文件在但入库失败时 reason 会带上原因（旧写法一律当成功 → 假成功提示）
      const status = outcome.status === 'success'
        ? 'success'
        : outcome.status === 'dup'
          ? (outcome.reason ? 'failed' : 'success')
          : outcome.status
      repo.insertHistoryItem({
        batchId,
        taskId,
        songKey: song.songKey,
        songName: song.name,
        singer: song.singer,
        status: outcome.status === 'dup' ? (outcome.reason ? 'failed' : 'skipped_dup') : outcome.status,
        quality: outcome.quality,
        errorReason: outcome.reason,
        detail: this.trace,
        action: 'in',
        process: outcome.status === 'success' ? 'download_new'
          : outcome.status === 'dup' ? (outcome.reason ? 'ingest_fail' : 'reuse_skip')
            : outcome.status === 'unsatisfied' ? 'unsatisfied' : 'download_fail',
        filePath: outcome.filePath,
        fileSize: this.sizeOf(outcome.filePath),
        refBefore: outcome.refsBefore ?? (outcome.status === 'success' ? [] : this.refTasks(outcome.fileId)),
        refAfter: this.refTasks(outcome.fileId),
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
    batchId: number,
  ): Promise<{ removed: number; archiveDegraded: string | null; failedRemovals: string[] }> {
    let removed = 0
    let movedFiles = 0
    const failedRemovals: string[] = []   // 本次没移除成功的歌：留在快照里，下次继续试
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
    const scope = this.scopeOf(task)
    if (task.createSameNamePlaylist) {
      const same = await this.findPlaylistByName(task.lxPlaylistName, scope)
      if (same) entries.push({ pid: same.id, managed: true })
    }

    const archiveName = archiveNameOf(task)
    let archiveId: string | null = null
    let archiveDegraded: string | null = null
    // 只找不建：目标被删 → 降级为「保留文件」，绝不重建用户删掉的东西（配置期才创建）
    const ensureArchive = async (): Promise<string | null> => {
      if (archiveId) return archiveId
      try {
        const ex = await this.findPlaylistByName(archiveName, scope)
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
      // 歌名（历史明细用；从最近一条记录里取，取不到就退回 songKey）
      const prevRow = getDb()
        .prepare('SELECT songName, singer FROM history_item WHERE songKey = ? ORDER BY id DESC LIMIT 1')
        .get(songKey) as { songName: string; singer: string } | undefined
      const songName = prevRow?.songName ?? songKey
      const singer = prevRow?.singer ?? ''
      const steps: string[] = [task.taskType === 'chart' ? '镜像：该歌已跌出榜单' : '镜像：该歌已从 LX 歌单移除']
      // 引用快照：移除前/后各取一次 —— "文件被其它任务引用则保留"就靠它解释
      const refBefore = this.refTasksOfSong(songKey)
      const record = (status: 'removed' | 'skipped' | 'failed', reason?: string) => {
        repo.insertHistoryItem({
          batchId, taskId, songKey, songName, singer, status, errorReason: reason, detail: steps,
          action: 'out',
          // 移出做了什么，由删除策略决定（处理1 不删文件 / 处理2 删文件 / 处理3 归档）
          process: delFile ? 'remove_p2' : archive ? 'remove_p3' : 'remove_p1',
          refBefore,
          refAfter: this.refTasksOfSong(songKey),
        })
      }

      // 解析媒体库条目：优先条目缓存；缓存里没有（换过同步目标会被清空）就**按文件路径精确查**
      // ⚠️ 旧实现"缓存里没有就静默 continue"，于是"待移除 1 首、实际未移除、且没有任何明细"——用户完全看不出发生了什么
      let itemId = repo.getEmbyMap(songKey)?.embySongId ?? null
      if (!itemId) {
        for (const f of repo.listFilesForSong(songKey)) {
          if (!this.emby.findItemByPath) break
          try {
            const hit = await this.emby.findItemByPath(f.filePath)
            if (hit) { itemId = hit.id; repo.setEmbyMap(songKey, hit.id); steps.push('媒体库：按文件路径定位到条目'); break }
          } catch { /* 换下一个文件试 */ }
        }
      }
      if (!itemId) {
        steps.push('媒体库：未能定位到该歌的条目（可能未入库）→ 未动歌单')
        logger.warn(`[engine] ${songKey} 待移除但定位不到媒体库条目 → 未动歌单（下次同步继续尝试）`)
        record('failed', '未能定位媒体库条目')
        failedRemovals.push(songKey)
        continue
      }

      const owned = strictOwned ? repo.hasTaskSongRef(taskId, songKey) : true
      if (!owned) {
        logger.info(`[engine] ${songKey} 非本任务加入(所有权保护) → 不动其歌单成员`)
        steps.push('该歌不是本任务加入的（所有权保护）→ 未动歌单')
        record('skipped')
        continue
      }
      let removedHere = false
      for (const e of entries) {
        if (!e.managed && !strictOwned) continue // 旧任务:managed 语义 = 全部
        const items = await this.emby.listPlaylistItems(e.pid)
        const entry = items.find((it) => it.itemId === itemId)
        if (entry?.entryId) {
          await this.emby.removeItems(e.pid, [entry.entryId])
          removed++
          removedHere = true
          steps.push(`已从歌单移除（${e.managed ? '同名歌单' : '已有歌单'}）`)
        }
      }
      if (!removedHere) {
        steps.push('该歌不在本任务的目标歌单里 → 无需移除')
        record('skipped')
        continue
      }
      // archive:曲目进归档歌单(文件不动)
      if (archive) {
        const aid = await ensureArchive()
        if (aid) {
          try {
            await this.emby.addItems(aid, [itemId])
            logger.info(`[engine] ${songKey} → 归档歌单`)
            steps.push(`已移入归档歌单「${archiveName}」`)
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

      // 文件侧的结果补进轨迹，然后记一条"移除"历史
      if (archive && archiveDegraded) steps.push('归档目标不存在 → 降级为保留文件')
      if (delFile) steps.push(movedFiles > 0 ? '文件已移入回收站（可恢复）' : '文件保留（被其它任务引用或无登记）')
      else steps.push('文件保留')
      record('removed')
    }
    // 物理删除后触发媒体库扫描清理缺失条目(Emby/Jellyfin;Navidrome 文件监听自动处理)
    if (movedFiles > 0 && (cfg.target === 'emby' || cfg.target === 'jellyfin')) {
      try {
        const lib = await this.emby.resolveLibraryId()
        if (lib) await this.emby.scanLibrary(lib)
      } catch { /* 扫描失败不阻断 */ }
    }
    if (movedFiles > 0) logger.info(`[engine] 删除策略=delete:${movedFiles} 个文件移入回收站(可恢复)`)
    return { removed, archiveDegraded, failedRemovals }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
