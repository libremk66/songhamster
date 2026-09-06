import { Router } from 'express'
import type { AppConfig, Quality } from '../config.js'
import { QUALITY_ORDER, QUALITY_LABELS, TARGET_LABEL } from '../config.js'
import { saveConfig } from '../config.js'
import { LxServerAdapter } from '../adapters/lxserver.js'
import type { MediaServerAdapter } from '../adapters/media-server.js'
import { EmbyAdapter } from '../adapters/emby.js'
import { NavidromeAdapter } from '../adapters/navidrome.js'
import { DaoliyuAdapter } from '../adapters/daoliyu.js'
import { SubsonicAdapter } from '../adapters/subsonic.js'
import * as repo from '../store/repo.js'
import { SyncEngine } from '../core/sync-engine.js'
import { Scheduler } from '../scheduler/index.js'
import { autoaddScan, initBaselineIfNeeded, autoaddStatus } from '../core/autoadd.js'
import { hashPassword, verifyPassword } from '../auth.js'
import { scanLowQuality, findBestCandidate, upgradeOne, recordUpgrade } from '../core/upgrade.js'
import { scanDuplicates, planCleanup, type DupeGroup, type DupeItem } from '../core/dupe.js'
import { localizeEmbyPath, moveToTrash, listTrash, restoreFromTrash, purgePath } from '../core/trash.js'
import { probeAudio } from '../core/probe.js'
import { logger } from '../core/logger.js'
import { getDb } from '../store/db.js'
import { renderBody } from '../views/render.js'
import { fmtLocal } from '../views/fmt.js'

const ok = (msg: string) => `<span class="ok">✅ ${msg}</span>`
const err = (msg: string) => `<span class="bad">❌ ${msg}</span>`
const bool = (v: unknown) => v === '1' || v === true || v === 1


export function apiRouter(
  cfg: AppConfig,
  lx: LxServerAdapter,
  emby: MediaServerAdapter,
  engine: SyncEngine,
  scheduler: Scheduler,
): Router {
  const r = Router()

  /** 服务器视角路径 → 宿主机可操作路径（按 target 分支；映射不了返回 null）
   * Navidrome：path 相对媒体库根（约定库根 = downloadRoot 同源）；绝对路径走 Emby 逻辑兜底 */
  const localizePath = (serverPath: string): string | null => {
    if (!serverPath) return null
    const dl = cfg.lxserver.downloadRoot?.replace(/\/+$/, '')
    if (!dl) return null
    if (cfg.target === 'navidrome') {
      if (!serverPath.startsWith('/')) return dl + '/' + serverPath
      return serverPath.startsWith(dl) ? serverPath : localizeEmbyPath(cfg, serverPath)
    }
    if (cfg.target === 'jellyfin') {
      // 与 Emby 同源：libraryRoot（jellyfin 段）前缀 → downloadRoot
      const lib = cfg.jellyfin.libraryRoot?.replace(/\/+$/, '')
      if (lib && serverPath.startsWith(lib + '/')) return dl + serverPath.slice(lib.length)
      return serverPath.startsWith(dl) ? serverPath : null
    }
    if (cfg.target === 'daoliyu') {
      // filePath 为容器内绝对路径（与 downloadRoot 同源）：libraryRoot 前缀 → downloadRoot
      const lib = cfg.daoliyu.libraryRoot?.replace(/\/+$/, '')
      if (lib && serverPath.startsWith(lib + '/')) return dl + serverPath.slice(lib.length)
      return serverPath.startsWith(dl) ? serverPath : null
    }
    return localizeEmbyPath(cfg, serverPath)
  }

  // ===== 配置保存 =====
  r.post('/config/lx', (req, res) => {
    const b = req.body ?? {}
    cfg.lxserver.baseUrl = String(b.baseUrl ?? '').trim()
    cfg.lxserver.apiKey = String(b.apiKey ?? '').trim()
    cfg.lxserver.username = String(b.username ?? 'king').trim() || 'king'
    cfg.lxserver.downloadRoot = String(b.downloadRoot ?? '').trim()
    saveConfig(cfg)
    res.send(ok('LX 连接配置已保存'))
  })

  r.post('/config/download', (req, res) => {
    const b = req.body ?? {}
    const qs = Array.isArray(b.qualities) ? b.qualities : b.qualities ? [b.qualities] : []
    const valid: Quality[] = QUALITY_ORDER.filter((q) => qs.includes(q)) as Quality[]
    if (!valid.length) return res.status(400).send(err('至少勾选一种音质'))
    cfg.download.qualities = valid
    cfg.download.filenameTemplate = String(b.filenameTemplate ?? '').trim() || cfg.download.filenameTemplate
    cfg.download.writeId3 = bool(b.writeId3)
    cfg.download.writeCover = bool(b.writeCover)
    cfg.download.embedLyric = bool(b.embedLyric)
    cfg.download.cacheLyric = bool(b.cacheLyric)
    cfg.download.concurrency = Math.min(10, Math.max(1, Number(b.concurrency) || 3))
    cfg.download.retries = Math.min(5, Math.max(0, Number(b.retries) || 2))
    saveConfig(cfg)
    res.send(ok('下载选项已保存'))
  })

  r.post('/config/emby', (req, res) => {
    const b = req.body ?? {}
    cfg.emby.baseUrl = String(b.baseUrl ?? '').trim()
    cfg.emby.apiKey = String(b.apiKey ?? '').trim()
    cfg.emby.libraryRoot = String(b.libraryRoot ?? '').trim()
    saveConfig(cfg)
    res.send(ok('Emby 配置已保存'))
  })

  // ===== 测试 / 探测 =====
  r.post('/test/lx', async (_req, res) => {
    const t = await lx.test()
    res.send(t.ok ? ok('LX 连接正常') : err(`LX ${t.error}`))
  })

  r.post('/test/emby', async (_req, res) => {
    const t = await emby.test()
    res.send(t.ok ? ok('Emby 连接正常') : err(`Emby ${t.error}`))
  })

  r.post('/emby/probe', async (_req, res) => {
    try {
      const libs = await emby.listLibraries()
      if (!libs.length) return res.send(err('未找到音乐类媒体库'))
      const id = await emby.resolveLibraryId()
      if (id) {
        cfg.emby.mediaLibraryId = id
        saveConfig(cfg)
        res.send(ok(`已识别媒体库 Id=${id}（匹配 libraryRoot）`))
      } else {
        const list = libs.map((l) => `${l.name}(${l.id})`).join('、')
        res.send(err(`libraryRoot 未匹配到库，现有音乐库: ${list}（请修正路径后重试）`))
      }
    } catch (e) {
      res.send(err((e as Error).message))
    }
  })

  // ===== Navidrome 连接（target=navidrome 时作为同步目标） =====
  r.post('/config/navidrome', (req, res) => {
    const b = req.body ?? {}
    cfg.navidrome.baseUrl = String(b.baseUrl ?? '').trim()
    cfg.navidrome.username = String(b.username ?? '').trim()
    cfg.navidrome.password = String(b.password ?? '').trim()
    cfg.navidrome.libraryRoot = String(b.libraryRoot ?? '').trim()
    saveConfig(cfg)
    res.send(ok('Navidrome 连接配置已保存'))
  })

  r.post('/test/navidrome', async (_req, res) => {
    const t = await new NavidromeAdapter(() => cfg).test()
    res.send(t.ok ? ok('Navidrome 连接正常') : err(`Navidrome ${t.error}`))
  })

  r.post('/navidrome/probe', async (_req, res) => {
    try {
      const nd = new NavidromeAdapter(() => cfg)
      const id = await nd.resolveLibraryId()
      if (id) {
        cfg.navidrome.libraryId = id
        saveConfig(cfg)
        res.send(ok(`已识别媒体库 Id=${id}`))
      } else {
        const libs = await nd.listLibraries()
        const list = libs.map((l) => `${l.name}(${l.id})`).join('、')
        res.send(err(`libraryRoot 未匹配到库，现有媒体库: ${list}（请先保存配置并核对路径）`))
      }
    } catch (e) {
      res.send(err((e as Error).message))
    }
  })

  // ===== 歌单下拉/列表刷新片段（蓝框内刷新按钮） =====
  // ===== 道理鱼连接（target=daoliyu 时使用；目录驱动） =====
  r.post('/config/daoliyu', (req, res) => {
    const b = req.body ?? {}
    cfg.daoliyu.baseUrl = String(b.baseUrl ?? '').trim()
    cfg.daoliyu.username = String(b.username ?? '').trim()
    cfg.daoliyu.password = String(b.password ?? '').trim()
    cfg.daoliyu.libraryRoot = String(b.libraryRoot ?? '').trim()
    saveConfig(cfg)
    res.send(ok('道理鱼连接配置已保存'))
  })

  r.post('/test/daoliyu', async (_req, res) => {
    const t = await new DaoliyuAdapter(() => cfg).test()
    res.send(t.ok ? ok('道理鱼连接正常') : err(`道理鱼 ${t.error}`))
  })

  r.post('/daoliyu/probe', async (_req, res) => {
    try {
      const dly = new DaoliyuAdapter(() => cfg)
      const libs = await dly.listLibraries()
      const root = libs[0]?.locations[0]
      if (root) {
        cfg.daoliyu.libraryRoot = root
        saveConfig(cfg)
        res.send(ok(`已识别媒体库根：<code>${escapeHtml(root)}</code>（已保存）`))
      } else {
        res.send(err('未探测到媒体库扫描路径（请先在道理鱼 Web 配置媒体库并全量扫描一次）'))
      }
    } catch (e) {
      res.send(err((e as Error).message))
    }
  })

  // ===== Jellyfin 连接（与 Emby API 同源） =====
  r.post('/config/jellyfin', (req, res) => {
    const b = req.body ?? {}
    cfg.jellyfin.baseUrl = String(b.baseUrl ?? '').trim()
    cfg.jellyfin.apiKey = String(b.apiKey ?? '').trim()
    cfg.jellyfin.libraryRoot = String(b.libraryRoot ?? '').trim()
    saveConfig(cfg)
    res.send(ok('Jellyfin 连接配置已保存'))
  })

  r.post('/test/jellyfin', async (_req, res) => {
    const t = await new EmbyAdapter(() => cfg, 'jellyfin').test()
    res.send(t.ok ? ok('Jellyfin 连接正常') : err(`Jellyfin ${t.error}`))
  })

  r.post('/jellyfin/probe', async (_req, res) => {
    try {
      const jf = new EmbyAdapter(() => cfg, 'jellyfin')
      const libs = await jf.listLibraries()
      if (!libs.length) return res.send(err('未找到音乐类媒体库（请先在 Jellyfin 后台建媒体库并扫描）'))
      const id = await jf.resolveLibraryId()
      if (id) {
        cfg.jellyfin.mediaLibraryId = id
        saveConfig(cfg)
        res.send(ok(`已识别媒体库 Id=${id}（匹配 libraryRoot）`))
      } else {
        const list = libs.map((l) => `${l.name}(${l.id})`).join('、')
        res.send(err(`libraryRoot 未匹配到库，现有音乐库: ${list}（请修正路径）`))
      }
    } catch (e) {
      res.send(err((e as Error).message))
    }
  })

  // ===== Subsonic 服务器（通用协议） =====
  r.post('/config/subsonic', (req, res) => {
    const b = req.body ?? {}
    cfg.subsonic.baseUrl = String(b.baseUrl ?? '').trim()
    cfg.subsonic.username = String(b.username ?? '').trim()
    cfg.subsonic.password = String(b.password ?? '').trim()
    saveConfig(cfg)
    res.send(ok('Subsonic 连接配置已保存'))
  })

  r.post('/test/subsonic', async (_req, res) => {
    const t = await new SubsonicAdapter(() => cfg).test()
    res.send(t.ok ? ok('Subsonic 连接正常') : err(`Subsonic ${t.error}`))
  })

  // ===== 榜单订阅 API =====
  const PLAT_LABEL: Record<string, string> = { tx: 'QQ', kw: '酷我', wy: '网易云', kg: '酷狗', mg: '咪咕', bd: '百度' }

  /** 榜单列表：as=table（浏览页表格）| as=options（表单下拉） */
  r.get('/charts/boards', async (req, res) => {
    const source = String(req.query.source ?? 'tx')
    try {
      const boards = await lx.getChartBoards(source)
      if (!boards.length) return res.send('<p class="hint">该平台暂无榜单（lxserver 榜单接口不可用？）</p>')
      if (String(req.query.as ?? '') === 'options') {
        const opts = ['<option value="" disabled selected>选择榜单…</option>']
        for (const b of boards) {
          opts.push(`<option value="${escapeHtml(b.id)}" data-name="${escapeHtml(b.name)}">${escapeHtml(b.name)}</option>`)
        }
        return res.send(opts.join(''))
      }
      const label = PLAT_LABEL[source] || source
      res.send(
        `<p class="hint" style="margin:.2rem 0">${label}音乐共 ${boards.length} 个榜单——点「查看歌曲」看当下榜单；点「订阅」自动跟进新上榜歌曲</p>
        <div class="multi-box" style="max-height:44em">
        ` +
          boards
            .map(
              (b) =>
                `<div style="display:flex;align-items:center;gap:.5rem;padding:.15rem .1rem;border-bottom:1px solid #f0f0f0">` +
                `<span style="flex:1">${escapeHtml(b.name)}</span>` +
                `<button type="button" class="btn-sm secondary" onclick="chLoadSongs('${source}','${escapeHtml(b.id)}','${escapeHtml(b.name)}')">查看歌曲</button>` +
                `<button type="button" class="btn-sm" onclick="chSubscribe('${source}','${escapeHtml(b.id)}','${escapeHtml(b.name)}')">订阅</button></div>`,
            )
            .join('') +
        `</div>`,
      )
    } catch (e) {
      res.send(`<span class="bad">拉取榜单失败：${escapeHtml((e as Error).message)}</span>`)
    }
  })

  /** 榜单歌曲浏览（前 100，标已收录） */
  r.get('/charts/songs', async (req, res) => {
    const source = String(req.query.source ?? 'tx')
    const bangid = String(req.query.bangid ?? '')
    const name = String(req.query.name ?? '')
    try {
      const songs = await lx.getChartSongs(source, bangid)
      const downloaded = repo.listDownloadedKeys()
      const shown = songs.slice(0, 100)
      const qLabel: Record<string, string> = {
        master: '臻品母带', atmos_plus: 'Atmos+', atmos: 'Atmos', hires: 'Hi-Res',
        flac24bit: '24bit FLAC', flac: 'FLAC', '320k': '320K', '128k': '128K',
      }
      res.send(
        `<div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin:.2rem 0">
          <h3 style="margin:0">${escapeHtml(PLAT_LABEL[source] || source)} · ${escapeHtml(name)}（共 ${songs.length} 首，显示前 ${shown.length}）</h3>
          <button type="button" class="btn-sm" id="ch-dl-btn" disabled onclick="chManualDownload('${source}','${escapeHtml(bangid)}')">⬇ 下载所选（0）</button>
          <span class="hint">下载到 <code>downloadRoot/手动下载/</code>，仅入库不入歌单</span>
          <span id="ch-dl-msg" class="msg"></span>
        </div>
        <p class="hint" style="margin:.2rem 0">✅=已下载收录 ｜ 勾选歌曲可手动下载</p>
        <div class="multi-box" style="max-height:44em">
        <table><thead><tr>
          <th style="white-space:nowrap">选</th><th style="white-space:nowrap">#</th><th style="white-space:nowrap">状态</th>
          <th style="white-space:nowrap">歌曲</th><th style="white-space:nowrap">歌手</th>
          <th style="white-space:nowrap">专辑</th><th style="white-space:nowrap">最高音质</th>
        </tr></thead><tbody>` +
          shown
            .map((sg, i) => {
              const dl = downloaded.has(sg.songKey)
              const best = sg.qualities.length ? sg.qualities[sg.qualities.length - 1] : ''
              return `<tr><td style="white-space:nowrap"><input type="checkbox" class="ch-sel" value="${escapeHtml(sg.songKey)}" onchange="chSelCount()"${dl ? ' disabled title="已下载"' : ''}></td>` +
                `<td style="white-space:nowrap;color:#999">${i + 1}</td>` +
                `<td style="white-space:nowrap">${dl ? '<span class="ok">✅</span>' : '—'}</td>` +
                `<td style="white-space:nowrap">${escapeHtml(sg.name)}</td>` +
                `<td style="white-space:nowrap">${escapeHtml(sg.singer)}</td>` +
                `<td class="hint">${escapeHtml(sg.albumName || '')}</td>` +
                `<td style="white-space:nowrap">${best ? escapeHtml(qLabel[best] || best) : '—'}</td></tr>`
            })
            .join('') +
        `</tbody></table></div>`,
      )
    } catch (e) {
      res.send(`<span class="bad">拉取歌曲失败：${escapeHtml((e as Error).message)}</span>`)
    }
  })

  /** 手动下载所选（榜单浏览页）：落盘 歌单同步/手动下载/，仅入库不入歌单 */
  r.post('/charts/manual-download', async (req, res) => {
    const b = req.body ?? {}
    const source = String(b.source ?? '')
    const bangid = String(b.bangid ?? '')
    const keysRaw = Array.isArray(b.songKeys) ? b.songKeys.map(String) : String(b.songKeys ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    if (!source || !bangid || !keysRaw.length) return res.send(err('参数缺失（source/bangid/songKeys）'))
    try {
      if (engine.isRunning) return res.send(err('已有任务在运行（全局单飞），请稍后再试'))
      const want = new Set(keysRaw)
      const full = await lx.getChartSongs(source, bangid)
      const songs = full.filter((sg) => want.has(sg.songKey))
      if (!songs.length) return res.send(err('所选歌曲均无法从榜单解析（可能已跌出榜单），请刷新后重试'))
      // 异步提交：立即返回，任务后台跑（进度/历史页可查看；落盘 downloadRoot/手动下载）
      void engine
        .runManualDownload(songs)
        .then((r) => {
          logger.info(`[charts] 手动下载后台完成: ok=${r.ok} fail=${r.fail} dup=${r.dup} unsatisfied=${r.unsatisfied}`)
        })
        .catch((e) => logger.warn(`[charts] 手动下载后台异常: ${(e as Error).message}`))
      res.send(ok(`已提交下载任务（${songs.length} 首）——请在「任务进度」或「历史记录」页查看`))
    } catch (e) {
      res.send(err((e as Error).message))
    }
  })

  /** 订阅编辑表单（卡片内联替换） */
  r.get('/charts/subs/:id/edit', (req, res) => {
    const t = repo.getTask(Number(req.params.id))
    if (!t || t.taskType !== 'chart') return res.send('<p class="bad">订阅不存在</p>')
    const tn = TARGET_LABEL[cfg.target] ?? 'Emby'
    res.send(`<article style="padding:.6rem .9rem;margin-bottom:.6rem">
      <form hx-post="/api/task/${t.id}/update" hx-swap="none" hx-on::after-request="htmx.ajax('GET','/api/charts/subs',{target:'#ch-subs-rows'})">
        <div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap">
          <strong>🏆 编辑订阅</strong>
          <small class="hint">${escapeHtml(t.chartSource ?? '')} · ${escapeHtml(t.chartName ?? '')}（平台与榜单不可改）</small>
        </div>
        <div class="line"><span>任务名（播放列表/落盘目录同名）</span>
          <input name="lxPlaylistName" value="${escapeHtml(t.lxPlaylistName)}" style="width:16rem">
        </div>
        <div class="line"><span>下载范围（榜单前 N 首，0=全榜）</span>
          <input type="number" name="maxCount" value="${t.maxCount}" min="0" style="width:7rem">
        </div>
        <div class="line">
          <label class="opt"><input type="checkbox" name="createSameNamePlaylist" value="1" ${t.createSameNamePlaylist ? 'checked' : ''}> 同步到新建同名 ${tn} 播放列表（歌单）</label>
        </div>
        <div class="line"><span>定时 cron（空 = 仅手动）</span>
          <input name="cronExpr" value="${escapeHtml(t.cronExpr || '')}" placeholder="0 8 * * *" style="width:12rem">
          <small class="hint">各榜单刷新周期不同，建议按榜单自定</small>
        </div>
        <div class="btn-row">
          <button type="submit">保存</button>
          <button type="button" class="secondary" hx-get="/api/charts/subs" hx-target="#ch-subs-rows" hx-swap="innerHTML">取消</button>
        </div>
      </form>
    </article>`)
  })

  /** 我的订阅列表片段 */
  r.get('/charts/subs', (_req, res) => {
    const tasks = repo
      .listTasks()
      .filter((t) => t.taskType === 'chart')
      .map((t) => ({ ...t, lastSnap: repo.getLatestChartSnapshot(t.id) }))
    res.send(renderBody('partials/chart-subs', { tasks, targetName: cfg.target === 'navidrome' ? 'Navidrome' : 'Emby' }))
  })

  r.get('/lx/playlists/options', async (_req, res) => {
    try {
      const ps = await lx.listPlaylists()
      const opts = ['<option value="" disabled selected>选择歌单…</option>']
      for (const p of ps) opts.push(`<option value="${escapeHtml(p.key)}">${escapeHtml(p.name)}（${p.songCount} 首）</option>`)
      res.send(opts.join(''))
    } catch (e) {
      res.send(`<option value="" disabled selected>刷新失败：${escapeHtml((e as Error).message)}</option>`)
    }
  })

  r.get('/emby/playlists/checkboxes', async (_req, res) => {
    try {
      const ps = await emby.listPlaylists()
      if (!ps.length) return res.send('<span class="hint">Emby 中暂无播放列表</span>')
      const html = ps
        .map(
          (p) =>
            `<label style="display:flex;align-items:center;gap:.3rem;margin:.15rem 0"><input type="checkbox" name="embyTarget" value="${escapeHtml(p.id)}"> ${escapeHtml(p.name)}</label>`,
        )
        .join('')
      res.send(html)
    } catch (e) {
      res.send(`<span class="bad">刷新失败：${escapeHtml((e as Error).message)}</span>`)
    }
  })

  // ===== 任务 CRUD（htmx 片段交互） =====
  async function lxKeyToName(): Promise<Record<string, string>> {
    const map: Record<string, string> = {}
    try {
      for (const p of await lx.listPlaylists()) map[p.key] = p.name
    } catch { /* LX 未连接 */ }
    return map
  }

  async function taskTableHtml(): Promise<string> {
    let idToName: Record<string, string> = {}
    const keyToName = await lxKeyToName()
    try {
      for (const p of await emby.listPlaylists()) idToName[p.id] = p.name
    } catch { /* Emby 未连接时显示 id */ }
    // 兜底：任务名缺失或仍是 key（旧数据/创建时未解析）→ 用 LX 歌单真实名称
    const tasks = repo
      .listTasks()
      .filter((t) => t.taskType !== 'adhoc') // 隐藏内部任务（手动下载容器）
      .map((t) => {
      const looksKey = !t.lxPlaylistName || t.lxPlaylistName === t.lxPlaylistKey || t.lxPlaylistName.startsWith('user:') || t.lxPlaylistName === 'loveList'
      return { ...t, lxPlaylistName: looksKey ? keyToName[t.lxPlaylistKey] ?? t.lxPlaylistKey : t.lxPlaylistName }
    })
    return renderBody('partials/task-table', { tasks, idToName, targetName: TARGET_LABEL[cfg.target] ?? 'Emby', })
  }

  r.get('/tasks/table', async (_req, res) => {
    res.send(await taskTableHtml())
  })

  r.post('/tasks', async (req, res) => {
    scheduler.reload()
    const b = req.body ?? {}
    const isChart = String(b.taskType ?? '') === 'chart'
    let key = String(b.lxPlaylistKey ?? '')
    let name = ''
    const chartSource = String(b.chartSource ?? '').trim()
    const chartId = String(b.chartId ?? '').trim()
    const chartName = String(b.chartName ?? '').trim()
    const maxCount = Math.max(0, Number(b.maxCount) || 30)
    if (isChart) {
      // 榜单订阅：key = chart:<source>:<bangid>（UNIQUE 天然防同榜重复订阅）
      if (!chartSource || !chartId) return res.status(400).send(err('请选择平台与榜单'))
      key = `chart:${chartSource}:${chartId}`
      if (repo.listTasks().some((t) => t.lxPlaylistKey === key)) {
        return res.send(err(`该榜单已订阅（任务「${repo.listTasks().find((t) => t.lxPlaylistKey === key)?.lxPlaylistName}」）`))
      }
      name = String(b.lxPlaylistName ?? '').trim() || `${chartSource}·${chartName}`
    } else {
      if (!key) return res.status(400).send(err('未选择 LX 歌单'))
      const keyToName = await lxKeyToName()
      name = keyToName[key] ?? String(b.lxPlaylistName ?? '') ?? key
    }
    const embyTargets = Array.isArray(b.embyTarget) ? b.embyTarget : b.embyTarget ? [b.embyTarget] : []
    repo.createTask({
      lxPlaylistKey: key,
      lxPlaylistName: name || key,
      embyTargetPlaylistIds: embyTargets.map(String),
      createSameNamePlaylist: bool(b.createSameNamePlaylist),
      cronExpr: String(b.cronExpr ?? '').trim() || null,
      syncMode: b.syncMode === 'full' ? 'full' : 'incremental',
      dedupCheck: bool(b.dedupCheck),
      dedupMinQuality: String(b.dedupMinQuality ?? '').trim() || null,
      taskType: isChart ? 'chart' : 'playlist',
      chartSource: isChart ? chartSource : undefined,
      chartId: isChart ? chartId : undefined,
      chartName: isChart ? chartName : undefined,
      maxCount: isChart ? maxCount : undefined,
    })
    // 榜单订阅由榜单页刷新；歌单任务刷新任务表
    res.send(isChart ? '<span class="ok">✅ 订阅已创建</span>' : await taskTableHtml())
  })

  r.post('/task/:id/toggle', async (req, res) => {
    scheduler.reload()
    const t = repo.getTask(Number(req.params.id))
    if (!t) return res.status(404).send(err('任务不存在'))
    repo.updateTask(t.id, { enabled: t.enabled ? 0 : 1 })
    res.send(await taskTableHtml())
  })

  r.post('/task/:id/delete', async (req, res) => {
    const id = Number(req.params.id)
    const t = repo.getTask(id)
    repo.deleteTask(id)
    // 自动新增开启时：删除任务视为"不要该歌单"，加入忽略列表防循环重建
    if (t && cfg.general.autoadd.enabled && t.lxPlaylistKey.startsWith('user:')) {
      if (!cfg.general.autoadd.ignoredKeys.includes(t.lxPlaylistKey)) {
        cfg.general.autoadd.ignoredKeys.push(t.lxPlaylistKey)
        saveConfig(cfg)
      }
    }
    scheduler.reload()
    res.send(await taskTableHtml())
  })

  // 行内编辑：渲染编辑表单（替换该行）
  r.get('/task/:id/edit', async (req, res) => {
    const t = repo.getTask(Number(req.params.id))
    if (!t) return res.status(404).send(err('任务不存在'))
    let embyPlaylists: { id: string; name: string }[] = []
    try {
      embyPlaylists = await emby.listPlaylists()
    } catch { /* 未连接 */ }
    res.send(renderBody('partials/task-edit', { t, embyPlaylists, qOrder: QUALITY_ORDER, qLabels: QUALITY_LABELS, targetName: TARGET_LABEL[cfg.target] ?? 'Emby', }))
  })

  // 保存编辑
  r.post('/task/:id/update', async (req, res) => {
    scheduler.reload()
    const id = Number(req.params.id)
    const t = repo.getTask(id)
    if (!t) return res.status(404).send(err('任务不存在'))
    const b = req.body ?? {}
    if (t.taskType === 'chart') {
      repo.updateTask(id, {
        lxPlaylistName: String(b.lxPlaylistName ?? '').trim() || t.lxPlaylistName,
        maxCount: Math.max(0, Number(b.maxCount) || 30),
        createSameNamePlaylist: bool(b.createSameNamePlaylist) ? 1 : 0,
        cronExpr: String(b.cronExpr ?? '').trim() || null,
      })
      return res.send(await taskTableHtml())
    }
    const embyTargets = Array.isArray(b.embyTarget) ? b.embyTarget : b.embyTarget ? [b.embyTarget] : []
    repo.updateTask(id, {
      embyTargetPlaylistIds: JSON.stringify(embyTargets.map(String)),
      createSameNamePlaylist: bool(b.createSameNamePlaylist) ? 1 : 0,
      syncMode: b.syncMode === 'full' ? 'full' : 'incremental',
      cronExpr: String(b.cronExpr ?? '').trim() || null,
      dedupCheck: bool(b.dedupCheck) ? 1 : 0,
      dedupMinQuality: String(b.dedupMinQuality ?? '').trim() || null,
    })
    res.send(await taskTableHtml())
  })

  r.post('/task/:id/run', async (req, res) => {
    const id = Number(req.params.id)
    const t = repo.getTask(id)
    if (!t) return res.status(404).send(err('任务不存在'))
    if (engine.isRunning) return res.send(err('已有任务在运行（全局单飞），稍后再试'))
    void engine.runTask(id, 'manual')
    res.send(ok('已开始同步，请到「任务进度」页查看'))
  })

  // ===== 任务进度 =====
  r.get('/progress/table', (_req, res) => {
    const tasks = repo.listTasks()
    const statusByTask: Record<number, unknown[]> = {}
    for (const t of tasks) statusByTask[t.id] = repo.listSongStatus(t.id)
    res.send(renderBody('partials/progress-table', { tasks, statusByTask, running: engine.isRunning }))
  })

  // ===== 历史 =====
  r.get('/history/partial', (_req, res) => {
    const batches = repo
      .listBatches(undefined, 20)
      .map((b) => ({ ...b, taskName: repo.getTask(b.taskId)?.lxPlaylistName ?? `#${b.taskId}` }))
    res.send(renderBody('partials/history', { batches }))
  })

  r.get('/history/batch/:id', (req, res) => {
    const items = dbAll('SELECT * FROM history_item WHERE batchId = ? ORDER BY id', [Number(req.params.id)])
    res.send(renderBody('partials/history-items', { items }))
  })

  r.post('/history/item/:id/retry', async (req, res) => {
    const item = dbGet('SELECT * FROM history_item WHERE id = ?', [Number(req.params.id)])
    if (!item) return res.status(404).send(err('记录不存在'))
    if (engine.isRunning) return res.send(err('已有任务在运行，稍后再试'))
    const r = await engine.retrySong(item.taskId, item.songKey)
    const msg = r === 'success' ? ok('重试成功，已补入库+入歌单') : err(`重试未成功（${r}）`)
    res.send(`<td colspan="5">${msg}</td>`)
  })

  // ===== 洗版历史（历史页标签） =====
  const QUALITY_LEVEL_LABEL: Record<string, string> = {
    '128k': '标准·128K', '192k': '高品质·192K', '320k': '高品质·320K',
    flac: '无损·FLAC', flac24bit: 'FLAC 24-Bit', hires: 'Hi-Res 无损',
    atmos: '沉浸声·Atmos', atmos_plus: '臻品音质·Atmos Plus', master: '臻品母带',
  }
  function fmtDur(sec: number | null): string {
    if (!sec) return '—'
    return Math.floor(sec / 60) + ':' + String(Math.round(sec % 60)).padStart(2, '0')
  }
  function fmtSize(b: number | null): string {
    if (!b) return '—'
    return (b / 1048576).toFixed(1) + ' MB'
  }
  r.get('/upgrade/history/partial', (_req, res) => {
    const rows = dbAll('SELECT * FROM upgrade_history ORDER BY id DESC LIMIT 30', [])
    const items = rows.map((r: any) => {
      // 旧版合成串 "~128kbps mp3" → 拆分（老数据兼容，仅作回退）
      const mOld = String(r.oldQuality || '').match(/^(~?)(\d+)kbps\s+([a-z0-9]+)$/i)
      const oldEst = mOld ? mOld[1] === '~' : false
      const oldBit = mOld ? Number(mOld[2]) : r.oldBitrate
      const oldFmt0 = mOld ? mOld[3].toLowerCase() : ''
      const newFmt0 = r.newPath ? String(r.newPath).split('.').pop()?.toLowerCase() || '' : ''
      const newLevel = (r.newQuality && QUALITY_LEVEL_LABEL[r.newQuality]) || r.newQuality || '—'

      // 实时探测新旧文件，补全 平均码率/采样率/位深（文件仍在时精确；FLAC 码率为估算 ~）
      // 实时探测（文件仍在时精确）；文件不存在/无法识别 → 视为无探测回退库值
      function probeFile(p: string | null): { bit?: number; est?: boolean; sr?: number; bits?: number; fmt?: string } {
        if (!p) return {}
        try {
          const pr = probeAudio(p)
          if (pr.format === 'unknown' || pr.bitrateKbps === 0) return {}
          return { bit: pr.bitrateKbps || undefined, est: pr.estimate, sr: pr.sampleRate || undefined, bits: pr.bits || undefined, fmt: pr.format }
        } catch {
          return {}
        }
      }
      const po = probeFile(r.oldPath)
      const pn = probeFile(r.newPath)

      const oldBitShow = po.bit ?? oldBit
      // 格式优先探测值，其次库值
      const oldFmt = po.fmt || oldFmt0
      // 音质档位按真实信息判定：mp3 由码率映射（128/192/320），其余格式直接用格式名
      const oldLevelKey =
        oldFmt === 'mp3' ? (oldBitShow >= 320 ? '320k' : oldBitShow >= 192 ? '192k' : '128k') : oldFmt
      const fmtSr = (sr?: number) => (sr ? (sr >= 1000 ? (sr / 1000).toFixed(1) + ' kHz' : sr + ' Hz') : '—')
      return {
        ...r,
        oldLevelLabel: QUALITY_LEVEL_LABEL[oldLevelKey] || r.oldQuality || '—',
        oldBitStr: oldBitShow ? (po.est === true || (po.est === undefined && oldEst) ? '~' : '') + oldBitShow + ' kbps' : '—',
        oldSrStr: fmtSr(po.sr),
        oldBitsStr: po.bits ? po.bits + ' bit' : '—',
        oldFmt: oldFmt || '—',
        oldDurStr: fmtDur(r.oldDurationSec),
        oldSizeStr: fmtSize(r.oldSize),
        oldPathShort: r.oldPath ? String(r.oldPath).split('/').pop() : '',
        newLevelLabel: newLevel,
        newBitStr: pn.bit ? (pn.est ? '~' : '') + pn.bit + ' kbps' : '—',
        newSrStr: fmtSr(pn.sr),
        newBitsStr: pn.bits ? pn.bits + ' bit' : '—',
        newFmt: newFmt0 === 'flac' ? 'FLAC' : newFmt0 || '—',
        newDurStr: fmtDur(r.newDurationSec),
        newSizeStr: fmtSize(r.newSize),
        newPathShort: r.newPath ? String(r.newPath).split('/').pop() : '',
        timeStr: fmtLocal(r.createdAt, true),
      }
    })
    res.send(renderBody('partials/upgrade-history', { items }))
  })

  // ===== 路径自检（部署引导） =====
  r.post('/paths/check', async (_req, res) => {
    const { existsSync, writeFileSync, rmSync } = await import('node:fs')
    const lines: string[] = []
    const dl = cfg.lxserver.downloadRoot
    // 1. 下载目录可写
    if (!dl) {
      lines.push('<p class="bad">❌ 未配置 LX 下载目录</p>')
    } else if (!existsSync(dl)) {
      lines.push(`<p class="bad">❌ 下载目录不存在：<code>${escapeHtml(dl)}</code>（检查卷挂载路径是否与界面填写一致）</p>`)
    } else {
      try {
        const t = dl.replace(/\/+$/, '') + '/.write_test'
        writeFileSync(t, 'x')
        rmSync(t)
        lines.push(`<p class="ok">✅ 下载目录可写：<code>${escapeHtml(dl)}</code></p>`)
      } catch {
        lines.push(`<p class="bad">❌ 下载目录不可写：<code>${escapeHtml(dl)}</code></p>`)
      }
    }
    // 2. Emby 媒体库匹配
    if (!cfg.emby.baseUrl || !cfg.emby.apiKey) {
      lines.push('<p class="hint">Emby 未连接，跳过媒体库匹配检查</p>')
    } else {
      try {
        const libs = await emby.listLibraries()
        const root = cfg.emby.libraryRoot?.replace(/\/+$/, '')
        const hit = libs.find((l) => l.locations.some((p) => (p.replace(/\/+$/, '') === root) || p.replace(/\/+$/, '').startsWith(root + '/') || (root && root.startsWith(p.replace(/\/+$/, '') + '/'))))
        if (hit) {
          lines.push(`<p class="ok">✅ 已匹配媒体库「${escapeHtml(hit.name)}」（Id=${hit.id}）</p>`)
        } else if (root) {
          lines.push(`<p class="bad">❌ 未匹配到媒体库：现有音乐库：${libs.map((l) => escapeHtml(l.name) + '(' + escapeHtml(l.locations[0] || '?') + ')').join('、')}<br><small>请确认 libraryRoot 填的是 <b>Emby 容器内</b>看到的路径，且媒体库确实指向它</small></p>`)
        } else {
          lines.push('<p class="hint">未填 Emby 媒体库根路径，可点击「探测媒体库」辅助</p>')
        }
      } catch (e) {
        lines.push(`<p class="bad">❌ Emby 探测失败：${escapeHtml((e as Error).message)}</p>`)
      }
    }
    // 3. 视角提示
    lines.push('<p class="hint">提示：两个路径字段是同一目录在不同容器里的名字；本机直跑则填宿主机真实路径。Docker 部署参照 docker-compose.example.yml。</p>')
    res.send(lines.join(''))
  })

  // ===== 日志 =====
  r.get('/logs/partial', (_req, res) => {
    const logs = logger
      .list(300)
      .map((l) => `${l.ts} [${l.level.toUpperCase().padEnd(5)}] ${l.msg}`)
      .join('\n')
    res.type('html').send(`<pre style="max-height:70vh;overflow:auto">${escapeHtml(logs)}</pre>`)
  })

  // ===== 通用设置 =====
  r.post('/config/general', (req, res) => {
    const b = req.body ?? {}
    cfg.general.autoIncludeNewPlaylists = bool(b.autoIncludeNewPlaylists)
    cfg.general.cleanupOrphanFiles = bool(b.cleanupOrphanFiles)
    cfg.general.pauseAll = bool(b.pauseAll)
    cfg.general.logRetentionDays = Math.min(365, Math.max(1, Number(b.logRetentionDays) || 30))
    cfg.general.githubUrl = String(b.githubUrl ?? '').trim()
    saveConfig(cfg)
    res.send(ok('设置已保存'))
  })

  // ===== 高级设置（默认关闭） =====
  r.post('/config/advanced', (req, res) => {
    const b = req.body ?? {}
    cfg.advanced.dedupCheck = bool(b.dedupCheck)
    cfg.advanced.dedupMinQuality = String(b.dedupMinQuality ?? '').trim() || null
    saveConfig(cfg)
    res.send(ok('高级设置已保存' + (cfg.advanced.dedupCheck ? '（查重已开启）' : '（查重保持关闭）')))
  })

  // ===== 批量下载保护 =====
  r.post('/config/protection', (req, res) => {
    const b = req.body ?? {}
    cfg.download.protection.enabled = bool(b.enabled)
    const dl = Number(b.downloadIntervalSec)
    const rs = Number(b.resolveIntervalSec)
    cfg.download.protection.downloadIntervalSec = Math.min(60, Math.max(2, dl || 5))
    cfg.download.protection.resolveIntervalSec = Math.min(30, Math.max(1, rs || 2))
    saveConfig(cfg)
    res.send(ok('保护设置已保存'))
  })

  // ===== 自动新增同步任务 =====
  r.post('/config/autoadd', async (req, res) => {
    const b = req.body ?? {}
    const a = cfg.general.autoadd
    const wasEnabled = a.enabled
    a.enabled = bool(b.enabled)
    if (b.baselineDate) a.baselineDate = String(b.baselineDate).trim()
    if (b.checkCron !== undefined) a.checkCron = String(b.checkCron ?? '').trim()
    a.createSameNamePlaylist = bool(b.createSameNamePlaylist)
    const embyTargets = Array.isArray(b.embyTarget) ? b.embyTarget : b.embyTarget ? [b.embyTarget] : []
    a.embyTargetPlaylistIds = embyTargets.map(String)
    a.syncMode = b.syncMode === 'full' ? 'full' : 'incremental'
    a.taskCron = String(b.taskCron ?? '').trim()
    a.dedupCheck = bool(b.dedupCheck)
    a.dedupMinQuality = String(b.dedupMinQuality ?? '').trim() || null
    saveConfig(cfg)
    if (!wasEnabled && a.enabled) {
      try {
        await initBaselineIfNeeded(cfg, lx)
        saveConfig(cfg)
      } catch { /* 忽略 */ }
    }
    scheduler.reload()
    res.send(ok('自动新增设置已保存' + (a.baselineKeys.length ? '（基线已记录 ' + a.baselineKeys.length + ' 个现有歌单）' : '')))
  })

  r.post('/autoadd/scan', async (req, res) => {
    if (!cfg.general.autoadd.enabled) return res.send(err('请先启用自动新增同步任务'))
    try {
      const r = await autoaddScan(cfg, lx, engine)
      if (r.created > 0) res.send(ok('检测完成：自动创建 ' + r.created + ' 个任务并同步（' + r.names.join('、') + '）'))
      else res.send(ok('检测完成：无新增歌单'))
    } catch (e) {
      res.send(err('检测失败：' + (e as Error).message))
    }
  })

  // 忽略列表管理（移除条目 → 该歌单可被重新自动纳入）
  r.post('/autoadd/ignored/remove', (req, res) => {
    const key = String((req.body ?? {}).key ?? '')
    cfg.general.autoadd.ignoredKeys = cfg.general.autoadd.ignoredKeys.filter((k) => k !== key)
    saveConfig(cfg)
    res.send(renderAutoaddPanel())
  })

  // 状态面板片段（含忽略列表）
  function renderAutoaddPanel(): string {
    const a = cfg.general.autoadd
    const last = autoaddStatus.lastScanAt ? fmtLocal(autoaddStatus.lastScanAt, true) : '（进程启动后尚未检测）'
    let html = `<p class="hint">基线歌单 ${a.baselineKeys.length} 个 ｜ 忽略 ${a.ignoredKeys.length} 个 ｜ 上次检测：${last}` +
      (autoaddStatus.lastCreated > 0 ? `，自动创建 ${autoaddStatus.lastCreated} 个（${escapeHtml(autoaddStatus.lastNames.join('、'))}）` : '') + '</p>'
    if (a.ignoredKeys.length) {
      html += '<details><summary>忽略列表管理（' + a.ignoredKeys.length + '）</summary><ul style="margin:.2rem 0">'
      for (const k of a.ignoredKeys) {
        html += `<li style="display:flex;align-items:center;gap:.5rem;list-style:none;margin:.1rem 0">` +
          `<code>${escapeHtml(k)}</code>` +
          `<button class="btn-sm secondary" hx-post="/api/autoadd/ignored/remove" hx-vals='{"key":"${escapeHtml(k)}"}' hx-target="#autoadd-panel" hx-swap="innerHTML">移除（重新允许自动纳入）</button></li>`
      }
      html += '</ul></details>'
    }
    return html
  }

  r.get('/autoadd/panel', (_req, res) => {
    res.send(renderAutoaddPanel())
  })

  // ===== 账号安全 =====
  r.post('/auth/settings', (req, res) => {
    const b = req.body ?? {}
    const a = cfg.auth
    const wantEnabled = bool(b.enabled)
    const username = String(b.username ?? '').trim()
    const current = String(b.currentPassword ?? '')
    const next = String(b.newPassword ?? '')

    if (!a.enabled) {
      // 未启用 → 启用需用户名 + 新密码
      if (!wantEnabled) return res.send(ok('认证保持未启用'))
      if (!username || !next) return res.send(err('启用认证需填写用户名和新密码'))
      a.enabled = true
      a.username = username
      a.passwordHash = hashPassword(next)
      saveConfig(cfg)
      return res.send(ok('账号认证已启用（用户 ' + username + '）'))
    }
    // 已启用：必须验证当前密码
    if (!verifyPassword(current, a.passwordHash)) return res.send(err('当前密码不正确'))
    if (!wantEnabled) {
      a.enabled = false
      saveConfig(cfg)
      return res.send(ok('账号认证已停用'))
    }
    if (username) a.username = username
    if (next) a.passwordHash = hashPassword(next)
    saveConfig(cfg)
    res.send(ok('账号设置已保存'))
  })

  // ===== 曲库管理：洗版 =====
  r.post('/upgrade/settings', (req, res) => {
    const b = req.body ?? {}
    const u = cfg.upgrade
    const threshold = Number(b.thresholdKbps)
    if ([128, 192, 256, 320, 500].includes(threshold)) u.thresholdKbps = threshold
    if (b.minQuality && QUALITY_ORDER.includes(b.minQuality)) u.minQuality = b.minQuality
    const dur = Number(b.maxDurDiffSec)
    if (dur >= 1 && dur <= 30) u.maxDurDiffSec = dur
    if (b.scanDir) u.scanDir = String(b.scanDir).trim()
    if (b.outputDir) u.outputDir = String(b.outputDir).trim()
    if (!u.outputDir && cfg.lxserver.downloadRoot) u.outputDir = cfg.lxserver.downloadRoot.replace(/\/+$/, '') + '/曲库洗版'
    saveConfig(cfg)
    res.send(ok('洗版规则已保存') + (u.outputDir ? `<p class="hint">新版保存目录：<code>${escapeHtml(u.outputDir)}</code></p>` : ''))
  })

  r.get('/upgrade/scan', (req, res) => {
    try {
      const u = cfg.upgrade
      if (!u.scanDir) return res.send(err('请先设置扫描目录'))
      const items = scanLowQuality(u.scanDir, u.thresholdKbps)
      res.send(
        `<p class="ok">扫描完成：发现 ${items.length} 个低码率文件（低于 ${u.thresholdKbps}kbps）</p>` +
          renderBody('partials/upgrade-list', { items }),
      )
    } catch (e) {
      res.send(err((e as Error).message))
    }
  })

  r.post('/upgrade/run', async (req, res) => {
    const u = cfg.upgrade
    if (!u.scanDir) return res.send(err('请先设置扫描目录'))
    if (!u.outputDir) return res.send(err('请先设置新版保存目录'))
    const items = scanLowQuality(u.scanDir, u.thresholdKbps)
    if (!items.length) return res.send(ok('无低码率文件需要洗版'))
    const out = []
    let okN = 0
    for (const it of items) {
      const hit = await findBestCandidate(lx, it, u.maxDurDiffSec)
      if (!hit) {
        recordUpgrade(it, { status: 'no_candidate' }, u.minQuality)
        out.push({ name: it.title, artist: it.artist, status: 'no_candidate' })
        continue
      }
      const r = await upgradeOne(cfg, lx, it, hit.song, hit.score, u.outputDir, u.minQuality)
      recordUpgrade(it, r, u.minQuality)
      if (r.status === 'success') okN++
      out.push({ name: it.title, artist: it.artist, status: r.status, quality: r.newQuality, reason: r.reason })
    }
    res.send(
      ok(`洗版完成：成功 ${okN} / ${items.length}`) +
        `<p class="hint">${out.map((o) => `${o.name}${o.artist ? ' - ' + o.artist : ''} → ${o.status}${o.quality ? '(' + o.quality + ')' : ''}${o.reason ? '：' + escapeHtml(o.reason) : ''}`).join('<br>')}</p>`,
    )
  })


  // ===== 查重清理（曲库管理） =====
  /** 渲染视图增强：标注每个候选是否已在回收站（供行内状态/恢复按钮） */
  function buildDupeView(groups: DupeGroup[]): { groups: any[]; trashByLocal: Map<string, string> } {
    const { files } = listTrash(cfg)
    const trashByLocal = new Map<string, string>()
    // 回收站 rel = <批次>/<downloadRoot 相对路径> → 还原原位置作为映射键
    const dl = cfg.lxserver.downloadRoot.replace(/\/+$/, '')
    for (const f of files) {
      const parts = f.rel.split('/')
      parts.shift()
      trashByLocal.set(dl + '/' + parts.join('/'), f.rel)
    }
    const data = groups.map((g) => ({
      ...g,
      items: g.items.map((it) => {
        const local = localizePath(it.path)
        const trashRel = local ? trashByLocal.get(local) || null : null
        return {
          ...it,
          localPath: local || '',
          inTrash: !!trashRel,
          trashRel: trashRel || '',
          qualityLabel: (it.quality && DUPE_QLABEL[it.quality]) || it.quality || '未知音质',
          sizeStr: it.size ? (it.size / 1048576).toFixed(1) + ' MB' : '',
        }
      }),
    }))
    return { groups: data, trashByLocal }
  }

  /** 生成行内"移入回收站"按钮 HTML */
  function trashBtnHtml(it: { id: string; path: string }): string {
    return `<button class="btn-sm secondary" hx-post="/api/dupe/delete" hx-vals='{"ids":"${escapeHtml(it.id)}"}' hx-target="closest td" hx-swap="innerHTML" hx-on::after-request="htmx.ajax('GET','/api/trash/partial',{target:'#trash-panel'})" hx-confirm="将移入回收站（可恢复）。确认？\n${escapeHtml(it.path)}">移入回收站</button>`
  }
  /** 生成行内"已移入回收站 + 恢复"按钮 HTML */
  function inTrashHtml(it: { id: string; path: string; trashRel: string }): string {
    return `<span class="bad" style="font-weight:600">🗑 已移入回收站</span> ` +
      `<button class="btn-sm" hx-post="/api/dupe/row/restore" hx-vals='{"id":"${escapeHtml(it.id)}","path":"${escapeHtml(it.path)}"}' hx-target="closest td" hx-swap="innerHTML">恢复</button>`
  }

  const DUPE_QLABEL: Record<string, string> = {
    '128k': '标准·128K', '192k': '高品质·192K', '320k': '高品质·320K',
    flac: '无损·FLAC', flac24bit: 'FLAC 24-Bit', hires: 'Hi-Res 无损',
    atmos: '沉浸声·Atmos', atmos_plus: '臻品音质·Atmos Plus', master: '臻品母带',
  }

  r.post('/dupe/scan', async (req, res) => {
    const b = req.body ?? {}
    let ids = Array.isArray(b.libraryIds) ? b.libraryIds.map(String) : b.libraryIds ? [String(b.libraryIds)] : []
    if (!ids.length && cfg.target === 'navidrome') {
      // Navidrome：单根整库查重，无需勾选——自动取目标库
      const libId = (await emby.resolveLibraryId().catch(() => null)) ?? '0'
      ids = [libId]
    }
    if (!ids.length) return res.send(err('请至少勾选一个媒体库'))
    const scanMode: 'per' | 'merged' = b.scanMode === 'per' ? 'per' : 'merged'
    const rawTh = String(b.threshold ?? '').trim()
    const cleanMode: 'off' | 'quality' | 'single' = rawTh === 'strict' ? 'single' : rawTh ? 'quality' : 'off'
    const thresholdQ = cleanMode === 'quality' ? rawTh : null
    try {
      const { groups, scannedCount } = await scanDuplicates(emby, ids, scanMode)
      const plan = planCleanup(groups, cleanMode, thresholdQ)
      // 落库（历史可翻查）
      const summary = {
        groups: groups.map((g) => ({ key: g.key, name: g.name, artist: g.artist, items: g.items })),
        autoIds: plan.autoDeletable.map((i) => i.id),
        keepIds: plan.keep.map((i) => i.id),
        threshold: rawTh || null,
        scanMode,
      }
      getDb()
        .prepare(
          `INSERT INTO dupe_scan (createdAt, libraryIds, threshold, groupsCount, autoCount, manualCount, summary) VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          new Date().toISOString(),
          JSON.stringify(ids),
          rawTh || null,
          groups.length,
          plan.autoDeletable.length,
          plan.manualCandidates.length,
          JSON.stringify(summary),
        )
      const { groups: data } = buildDupeView(groups)
      const autoIds = new Set(plan.autoDeletable.map((i) => i.id))
      const keepIds = new Set(plan.keep.map((i) => i.id))
      const modeTxt = scanMode === 'per' ? '各库独立查重' : '跨库合并查重'
      let head: string
      if (cleanMode === 'single') head = `每组仅保留最高一份：将自动清理 <b>${plan.autoDeletable.length}</b> 首（含同音质重复副本）`
      else if (cleanMode === 'quality') head = `将自动清理 <b>${plan.autoDeletable.length}</b> 首低于 ${DUPE_QLABEL[rawTh] || rawTh} 的副本` + (plan.skippedGroups ? `；<b>${plan.skippedGroups}</b> 组整组均低于门槛，已跳过不删（防误删唯一版本）` : '')
      else head = `仅查重（不自动清理，候选手动删除 <b>${plan.manualCandidates.length}</b> 首）`
      res.send(
        `<p class="ok">扫描完成（${modeTxt}）：${scannedCount} 首 ｜ 重复组 ${groups.length} ｜ 保留 ${plan.keep.length} ｜ ${head}</p>` +
          renderBody('partials/dupe-result', { groups: data, autoIds: [...autoIds], keepIds: [...keepIds], threshold: rawTh, targetName: TARGET_LABEL[cfg.target] ?? 'Emby', }),
      )
    } catch (e) {
      res.send(err('查重失败：' + escapeHtml((e as Error).message)))
    }
  })

  r.get('/dupe/history/partial', (req, res) => {
    // 分页：每页 10 条，页签切换（记录多时避免整页过长）
    const PER = 10
    const total = Number((dbGet('SELECT COUNT(*) AS c FROM dupe_scan', []) as any)?.c ?? 0)
    const pages = Math.max(1, Math.ceil(total / PER))
    const page = Math.min(Math.max(1, Number(req.query.page) || 1), pages)
    const rows = dbAll(
      'SELECT id, createdAt, libraryIds, threshold, groupsCount, autoCount, manualCount FROM dupe_scan ORDER BY id DESC LIMIT ? OFFSET ?',
      [PER, (page - 1) * PER],
    )
    res.send(renderBody('partials/dupe-history', { rows, page, pages, total }))
  })

  r.get('/dupe/history/:id', (_req, res) => {
    const row = dbGet('SELECT summary FROM dupe_scan WHERE id = ?', [Number(_req.params.id)])
    if (!row) return res.send('<p class="bad">扫描记录不存在</p>')
    try {
      const sm = JSON.parse(row.summary)
      const { groups } = buildDupeView((sm.groups || []).map((g: any) => ({ ...g, items: g.items.map((it: any) => ({ ...it, quality: it.quality || null })) })))
      res.send(renderBody('partials/dupe-result', { groups, autoIds: sm.autoIds || [], keepIds: sm.keepIds || [], threshold: sm.threshold || '', targetName: TARGET_LABEL[cfg.target] ?? 'Emby', }))
    } catch (e) {
      res.send('<p class="bad">记录解析失败</p>')
    }
  })

  r.get('/emby/music-libs/options', async (_req, res) => {
    try {
      const libs = await emby.listLibraries()
      if (!libs.length) return res.send('<span class="hint">未找到音乐媒体库</span>')
      const libRoot = cfg.emby.libraryRoot?.replace(/\/+$/, '')
      res.send(
        libs
          .map((l) => {
            const isProject =
              !!libRoot &&
              (l.locations || []).some((p) => {
                const x = p.replace(/\/+$/, '')
                return x === libRoot || x.startsWith(libRoot + '/') || libRoot.startsWith(x + '/')
              })
            const tag = isProject
              ? '<span style="color:#2f9e44;font-size:.78em">（在映射目录内，可回收）</span>'
              : '<span style="color:#e8590c;font-size:.78em">（文件不在本项目映射目录，回收受限，仅查重可看）</span>'
            return `<label class="lib-check"><input type="checkbox" name="libraryIds" value="${escapeHtml(l.id)}" checked><span class="lc-name">${escapeHtml(l.name)}${tag}</span><span class="lc-path">${escapeHtml((l.locations || [])[0] || '')}</span></label>`
          })
          .join(''),
      )
    } catch (e) {
      res.send(`<span class="bad">刷新失败：${escapeHtml((e as Error).message)}</span>`)
    }
  })

  r.post('/dupe/delete', async (req, res) => {
    // 安全缓冲：删除 = 文件移入回收站（.songferry-trash），可恢复；Emby 条目由后续扫描自然清理
    const b = req.body ?? {}
    const raw = b.ids
    const ids = Array.isArray(raw)
      ? raw.map(String)
      : String(raw ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    // 可选：单条时前端携带快照路径（条目可能已失效，文件仍在——直接用路径移入回收站）
    const rawPaths = b.paths
    const paths = Array.isArray(rawPaths) ? rawPaths.map(String) : rawPaths ? [String(rawPaths)] : []
    if (!ids.length) return res.send(err('未选择要处理的条目'))
    const moved: string[] = []
    const skipped: string[] = []
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      const snapshotPath = paths[i] || ''
      try {
        // ① 优先用快照路径直接定位本地文件（条目被 Emby 清理但文件仍在的场景）
        let local = snapshotPath ? localizePath(snapshotPath) : null
        if (local) {
          const { existsSync } = await import('node:fs')
          if (!existsSync(local)) local = null
        }
        // ② 兜底：从 Emby 条目实时取路径
        if (!local) {
          const embyPath = await emby.getItemPath(id)
          local = localizePath(embyPath)
        }
        if (!local) {
          skipped.push(snapshotPath || id)
          continue
        }
        await moveToTrash(cfg, local)
        moved.push(local)
      } catch (e) {
        skipped.push((e as Error).message)
      }
    }
    if (ids.length === 1) {
      // 单条（行内操作）：返回"已移入+恢复"状态按钮
      const embyPath = paths[0] || (await emby.getItemPath(ids[0]).catch(() => ''))
      const local = embyPath ? localizePath(embyPath) : null
      const { files } = listTrash(cfg)
      const dl = cfg.lxserver.downloadRoot.replace(/\/+$/, '')
      const rel = local
        ? files.find((f) => {
            const parts = f.rel.split('/')
            parts.shift()
            return dl + '/' + parts.join('/') === local
          })?.rel || ''
        : ''
      res.send(moved.length === 1 ? inTrashHtml({ id: ids[0], path: embyPath, trashRel: rel }) : err(`移入失败：${skipped.join('；')}`))
      return
    }
    res.send(
      ok(`已移入回收站 ${moved.length}/${ids.length} 首（可随时恢复；Emby 扫描后条目自动清理）`) +
        (skipped.length ? `<p class="bad">以下未能移入回收站：<br>${skipped.map(escapeHtml).join('<br>')}</p>` : '') +
        `<p class="hint">误操作？在下方"回收站"中可一键恢复。</p>`,
    )
  })

  // 历史/结果行内恢复（无需进回收站面板）
  // 手动扫库：让 Emby 清理缺失条目/发现恢复的文件（避免每次移入自动全库扫描）
  r.post('/dupe/scan-library', async (_req, res) => {
    try {
      let libId = cfg.emby.mediaLibraryId
      if (!libId) libId = (await emby.resolveLibraryId()) ?? undefined
      if (!libId) return res.send(err('未找到本项目媒体库（请在连接容器页探测/保存）'))
      await emby.scanLibrary(libId)
      res.send(ok('已触发媒体库扫描——缺失条目将自动清理，恢复的文件将重新入库；大库可能需要一些时间'))
    } catch (e) {
      res.send(err('扫描失败：' + escapeHtml((e as Error).message)))
    }
  })

  r.post('/dupe/row/restore', async (req, res) => {
    const b = req.body ?? {}
    const id = String(b.id ?? '')
    const embyPath = String(b.path ?? '')
    try {
      const local = localizePath(embyPath)
      if (!local) return res.send(err('无法定位本地文件'))
      const { files } = listTrash(cfg)
      const dl = cfg.lxserver.downloadRoot.replace(/\/+$/, '')
      const hit = files.find((f) => {
        const parts = f.rel.split('/')
        parts.shift()
        return dl + '/' + parts.join('/') === local
      })
      if (!hit) return res.send(err('回收站中未找到该文件（可能已恢复或已彻底删除）'))
      restoreFromTrash(cfg, hit.rel)
      res.send(trashBtnHtml({ id, path: embyPath }))
    } catch (e) {
      res.send(err((e as Error).message))
    }
  })

  // ===== 回收站（安全缓冲） =====
  const trashPanel = () => {
    const { batches, files } = listTrash(cfg)
    const fmtSize = (n: number) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB')
    let html = `<p class="hint">回收站共 ${files.length} 个文件（${batches.length} 个批次）——移入后 Emby 中的歌曲暂时不可见，可恢复；<b>彻底删除</b>才真正删除磁盘文件。</p>`
    if (!files.length) return html
    for (const b of batches) {
      const bfiles = files.filter((f) => f.batch === b)
      const batchIso = b.replace(/(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1:$2:$3.$4Z') // 批次目录名 → ISO
      html += `<details style="margin:.3rem 0"><summary>批次 ${fmtLocal(batchIso, true)}（${bfiles.length} 个文件）</summary>`
      for (const f of bfiles) {
        html += `<div style="display:flex;gap:.5rem;align-items:center;margin:.15rem 0;font-size:.85em">` +
          `<span style="word-break:break-all;flex:1">${escapeHtml(f.rel)}（${fmtSize(f.size)}）</span>` +
          `<button class="btn-sm" hx-post="/api/trash/restore" hx-vals='{"rel":"${escapeHtml(f.rel)}"}' hx-target="closest div" hx-swap="outerHTML" hx-on::after-request="htmx.ajax('GET','/api/trash/partial',{target:'#trash-panel'})">恢复</button>` +
          `<button class="btn-sm secondary" hx-post="/api/trash/purge" hx-vals='{"full":"${escapeHtml(f.full)}"}' hx-confirm="彻底删除该文件（不可恢复）？\n${escapeHtml(f.rel)}" hx-target="closest div" hx-swap="outerHTML" hx-on::after-request="htmx.ajax('GET','/api/trash/partial',{target:'#trash-panel'})">彻底删除</button>` +
          `</div>`
      }
      html += `</details>`
    }
    return html
  }
  r.get('/trash/partial', (_req, res) => res.send(trashPanel()))
  r.post('/trash/restore', (req, res) => {
    const rel = String((req.body ?? {}).rel ?? '')
    try {
      const dest = restoreFromTrash(cfg, rel)
      res.send(`<span class="ok">✅ 已恢复：${escapeHtml(dest)}</span>`)
    } catch (e) {
      res.send(`<span class="bad">❌ ${escapeHtml((e as Error).message)}</span>`)
    }
  })
  r.post('/trash/purge', (req, res) => {
    const full = String((req.body ?? {}).full ?? '')
    try {
      purgePath(full)
      res.send(`<span class="hint">已彻底删除</span>`)
    } catch (e) {
      res.send(`<span class="bad">❌ ${escapeHtml((e as Error).message)}</span>`)
    }
  })


  return r
}

function dbAll(sql: string, params: unknown[]): any[] {
  return getDb().prepare(sql).all(...params) as any[]
}
function dbGet(sql: string, params: unknown[]): any {
  return getDb().prepare(sql).get(...params) as any
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
