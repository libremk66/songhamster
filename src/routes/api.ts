import { Router } from 'express'
import type { AppConfig, ListenParams, Quality } from '../config.js'
import { QUALITY_ORDER, QUALITY_LABELS, TARGET_LABEL, DEFAULT_ARCHIVE_PLAYLIST, DEFAULT_CHART_ARCHIVE_PLAYLIST, isArchiveTemplate, resolveArchiveName, archiveNameOf, supportsFileDelete } from '../config.js'
import { saveConfig } from '../config.js'
import { LxServerAdapter } from '../adapters/lxserver.js'
import type { MediaServerAdapter } from '../adapters/media-server.js'
import { EmbyAdapter } from '../adapters/emby.js'
import { NavidromeAdapter } from '../adapters/navidrome.js'
import { DaoliyuAdapter } from '../adapters/daoliyu.js'
import { SubsonicAdapter } from '../adapters/subsonic.js'
import * as repo from '../store/repo.js'
import { SyncEngine, RUN_BLOCKED } from '../core/sync-engine.js'
import { Scheduler } from '../scheduler/index.js'
import { autoaddScan, initBaselineIfNeeded, autoaddStatus } from '../core/autoadd.js'
import { listenScan, listenStatus, originOfMode } from '../core/listen.js'
import { hashPassword, verifyPassword } from '../auth.js'
import { scanLowQuality, findBestCandidate, upgradeOne, recordUpgrade } from '../core/upgrade.js'
import { scanDuplicates, planCleanup, type DupeGroup, type DupeItem } from '../core/dupe.js'
import { moveToTrash, listTrash, restoreFromTrash, purgePath } from '../core/trash.js'
import { localizeEmbyPath } from '../core/paths.js'
import * as HMeta from '../core/history-meta.js'
import { applyDeletion, reportLine } from '../core/delete.js'
import { probeAudio } from '../core/probe.js'
import { SERVER_SPECS, specOf } from '../core/server-spec.js'
import { logger } from '../core/logger.js'
import { getDb, taskSemantics } from '../store/db.js'
import { renderBody } from '../views/render.js'
import { fmtLocal } from '../views/fmt.js'

const ok = (msg: string) => `<span class="ok">✅ ${msg}</span>`
const err = (msg: string) => `<span class="bad">❌ ${msg}</span>`
const bool = (v: unknown) => v === '1' || v === true || v === 1
// 表单复选:隐藏 0 占位 + 勾选 1 → qs 解析为数组;任一 '1' 即 true(未勾选只发 [0] → false)
const boolV = (v: unknown): boolean => (Array.isArray(v) ? v.some((x) => x === '1' || x === true || x === 1) : bool(v))


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
    cfg.download.embedLyric = bool(b.embedLyric)
    cfg.download.cacheLyric = bool(b.cacheLyric)
    saveConfig(cfg)
    logger.info(`[config] 下载选项：音质=${valid.join('>')} 模板=${cfg.download.filenameTemplate} 歌词=${cfg.download.embedLyric ? '内嵌' : ''}${cfg.download.cacheLyric ? '+外置' : ''}（标签/封面由 LX 服务端始终写入；下载逐首串行、无自动重试）`)
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

  // ===== 连接媒体服务器（统一分区：选项卡切类型 + 确定一键"存→测→探测→设为目标"）=====
  const serverVals = (type: string): Record<string, string> => {
    const c = (cfg as unknown as Record<string, Record<string, string>>)[type] ?? {}
    return {
      baseUrl: c.baseUrl ?? '', apiKey: c.apiKey ?? '', username: c.username ?? '', password: c.password ?? '', libraryRoot: c.libraryRoot ?? '',
    }
  }
  /** 解析表单里的「目标歌单归属」：'shared' 或 'id|名字'；返回 { scope, name } */
  const parseScope = (raw: unknown): { scope: string; name: string } => {
    const v = String(raw ?? '').trim()
    if (!v || v === 'shared') return { scope: 'shared', name: '共享（所有人可见）' }
    const [id, nm] = v.split('|')
    return { scope: id || 'shared', name: nm || id }
  }

  const renderConnSection = (type: string, oob = false): string => {
    const spec = specOf(type) ?? SERVER_SPECS[0]
    return renderBody('partials/connect-server', { specs: SERVER_SPECS, spec, type: spec.key, target: cfg.target, vals: serverVals(spec.key), oob })
  }
  r.get('/connect/section', (req, res) => {
    res.send(renderConnSection(String(req.query.type ?? cfg.target)))
  })

  /** 按类型把表单字段写进对应配置段（与各 /config/* 保持同一套字段名） */
  const applyServerCfg = (type: string, b: Record<string, unknown>): void => {
    const g = (k: string) => String(b[k] ?? '').trim()
    if (type === 'emby') {
      cfg.emby.baseUrl = g('baseUrl'); cfg.emby.apiKey = g('apiKey'); cfg.emby.libraryRoot = g('libraryRoot')
    } else if (type === 'jellyfin') {
      cfg.jellyfin.baseUrl = g('baseUrl'); cfg.jellyfin.apiKey = g('apiKey'); cfg.jellyfin.libraryRoot = g('libraryRoot')
    } else if (type === 'navidrome') {
      cfg.navidrome.baseUrl = g('baseUrl'); cfg.navidrome.username = g('username'); cfg.navidrome.password = g('password'); cfg.navidrome.libraryRoot = g('libraryRoot')
    } else if (type === 'daoliyu') {
      cfg.daoliyu.baseUrl = g('baseUrl'); cfg.daoliyu.username = g('username'); cfg.daoliyu.password = g('password'); cfg.daoliyu.libraryRoot = g('libraryRoot')
    } else if (type === 'subsonic') {
      cfg.subsonic.baseUrl = g('baseUrl'); cfg.subsonic.username = g('username'); cfg.subsonic.password = g('password')
    }
  }
  const adapterOf = (type: string): MediaServerAdapter =>
    type === 'emby' ? emby
      : type === 'jellyfin' ? new EmbyAdapter(() => cfg, 'jellyfin')
        : type === 'navidrome' ? new NavidromeAdapter(() => cfg)
          : type === 'daoliyu' ? new DaoliyuAdapter(() => cfg)
            : new SubsonicAdapter(() => cfg)

  /** 把底层报错翻成人话（让用户知道该去改哪个字段） */
  const friendlyErr = (e: string): string =>
    /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|network/i.test(e)
      ? '无法连接：地址不通或服务未启动'
      : /\b401\b|\b403\b|unauthor/i.test(e)
        ? '鉴权失败：API key / 账号密码不正确'
        : /\b404\b/.test(e)
          ? '接口返回 404：地址可能多写了路径（一般填到端口即可）'
          : e

  /**
   * 确定 = 保存该服务器配置 → 测试连接 → 探测媒体库 → 全部通过才设为同步目标。
   * 任一步不通过都不切换目标（避免把同步指向一台连不上/库没匹配的服务器）。
   */
  r.post('/connect/apply', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const spec = specOf(String(b.type ?? ''))
    if (!spec) return res.send(err('未知的媒体服务器类型'))
    applyServerCfg(spec.key, b)
    saveConfig(cfg)
    const back = (html: string) => res.send(html + renderConnSection(spec.key, true)) // 顺带刷新选项卡上的"当前目标"点
    const ad = adapterOf(spec.key)
    let connErr = ''
    try {
      const t = await ad.test()
      if (!t.ok) connErr = t.error ?? '未知错误'
    } catch (e) {
      connErr = (e as Error).message
    }
    if (connErr) return back(err(`${spec.label} 连接失败，请检查媒体服务器信息（${escapeHtml(friendlyErr(connErr))}）`))
    // 媒体库探测（Subsonic 无媒体库概念，跳过）
    if (spec.probePath) {
      try {
        const libs = await ad.listLibraries()
        const id = await ad.resolveLibraryId()
        if (!id) {
          const list = libs.map((l) => l.name).join('、')
          return back(`<span class="st-warn">⚠️ ${spec.label} 已连接，但媒体库根路径未匹配到库${list ? `（现有：${escapeHtml(list)}）` : '（该服务器上还没有音乐库）'}，请核对后重按「确定」；<b>同步目标未切换</b></span>`)
        }
      } catch (e) {
        return back(`<span class="st-warn">⚠️ ${spec.label} 已连接，但探测媒体库出错（${escapeHtml((e as Error).message)}）；<b>同步目标未切换</b></span>`)
      }
    }
    if (cfg.target !== spec.key) {
      // 条目 Id 体系随服务器不同（Emby 数字 / Navidrome base64 …）→ 换目标必须作废缓存
      const n = repo.clearAllEmbyMap()
      if (n) logger.info(`[connect] 同步目标 ${cfg.target} → ${spec.key}：已清空 ${n} 条媒体库条目缓存（换服务器后 Id 不再有效）`)
      else logger.info(`[connect] 同步目标切换为 ${spec.key}`)
    }
    cfg.target = spec.key
    if (spec.key === 'emby' || spec.key === 'jellyfin') {
      const id = await ad.resolveLibraryId().catch(() => null)
      if (id) (spec.key === 'emby' ? cfg.emby : cfg.jellyfin).mediaLibraryId = id
    }
    if (spec.key === 'navidrome') {
      const id = await ad.resolveLibraryId().catch(() => null)
      if (id) cfg.navidrome.libraryId = id
    }
    saveConfig(cfg)
    logger.info(`[connect] ${spec.label} 已连接并设为同步目标（${cfg[spec.key === 'jellyfin' ? 'jellyfin' : spec.key].baseUrl}）`)
    back(ok(`${spec.label} 已连接，已设为同步目标`))
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
                `<div class="ch-row" style="display:flex;align-items:center;gap:.5rem;padding:.15rem .1rem;border-bottom:1px solid oklch(var(--bc)/0.08)">` +
                `<span style="flex:1">${escapeHtml(b.name)}</span>` +
                `<button type="button" class="btn-sm secondary" onclick="chLoadSongs('${source}','${escapeHtml(b.id)}','${escapeHtml(b.name)}',this)">查看歌曲</button>` +
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

  /** 订阅编辑（卡片内联替换，DaisyUI 版 partial） */
  r.get('/charts/subs/:id/edit', async (req, res) => {
    const t = repo.getTask(Number(req.params.id))
    if (!t || t.taskType !== 'chart') return res.send('<p class="bad">订阅不存在</p>')
    let embyPlaylists: { id: string; name: string }[] = []
    try {
      embyPlaylists = await emby.listPlaylists()
    } catch { /* 未连接 */ }
    res.send(
      renderBody('partials/chart-edit', {
        t,
        targetName: TARGET_LABEL[cfg.target] ?? 'Emby',
        fileDeleteOK: supportsFileDelete(cfg.target),
        embyPlaylists,
        scopeUI: cfg.target === 'emby' || cfg.target === 'jellyfin',
        targetKey: cfg.target,
      }),
    )
  })

  /** 我的订阅列表片段 */
  const chartSubsRows = (): string => {
    const tasks = repo
      .listTasks()
      .filter((t) => t.taskType === 'chart')
      .map((t) => ({ ...t, lastSnap: repo.getLatestChartSnapshot(t.id), sem: taskSemantics(t) }))
    return renderBody('partials/chart-subs', { tasks, targetName: cfg.target === 'navidrome' ? 'Navidrome' : 'Emby', live: engine.live, fdelOk: supportsFileDelete(cfg.target) })
  }

  r.get('/charts/subs', (_req, res) => {
    res.send(chartSubsRows())
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

  /** 「播放列表归属用户」下拉：用表单里当前填的地址/key 拉用户列表（还没保存也能用） */
  r.get('/media/users/options', async (req, res) => {
    const type = String(req.query.type ?? 'emby')
    const cur = String(req.query.playlistUserId ?? '').split('|')[0]  // 选项值是 id|名字
    const pick = (v: unknown, fb: string) => (v === undefined || v === '' ? fb : String(v))
    const tmp: AppConfig = type === 'jellyfin'
      ? { ...cfg, jellyfin: { ...cfg.jellyfin, baseUrl: pick(req.query.baseUrl, cfg.jellyfin.baseUrl), apiKey: pick(req.query.apiKey, cfg.jellyfin.apiKey) } }
      : { ...cfg, emby: { ...cfg.emby, baseUrl: pick(req.query.baseUrl, cfg.emby.baseUrl), apiKey: pick(req.query.apiKey, cfg.emby.apiKey) } }
    try {
      const ad = new EmbyAdapter(() => tmp, type === 'jellyfin' ? 'jellyfin' : 'emby')
      const users = (await ad.listUsers()) ?? []
      const opts = [`<option value="shared"${!cur || cur === 'shared' ? ' selected' : ''}>共享（所有人可见）</option>`]
      for (const u of users) {
        opts.push(`<option value="${escapeHtml(u.id)}|${escapeHtml(u.name)}"${u.id === cur ? ' selected' : ''}>${escapeHtml(u.name)}</option>`)
      }
      res.send(opts.join(''))
    } catch (e) {
      res.send(`<option value="">读取用户列表失败：${escapeHtml((e as Error).message)}</option>`)
    }
  })

  /** 「同步到已有播放列表」候选：按当前作用域列（hx-include 会带上表单里的 scope 与已勾选项） */
  r.get('/emby/playlists/checkboxes', async (req, res) => {
    try {
      const scope = parseScope(req.query.playlistScope ?? req.query.scope ?? 'shared').scope
      const checked = new Set((Array.isArray(req.query.embyTarget) ? req.query.embyTarget : req.query.embyTarget ? [req.query.embyTarget] : []).map(String))
      const ps = await emby.listPlaylists(scope)
      if (!ps.length) return res.send('<span class="hint">该作用域下没有可选播放列表</span>')
      const html = ps
        .map(
          (p) =>
            `<label style="display:flex;align-items:center;gap:.3rem;margin:.15rem 0"><input type="checkbox" name="embyTarget" value="${escapeHtml(p.id)}"${checked.has(p.id) ? ' checked' : ''}> ${escapeHtml(p.name)}</label>`,
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

  async function taskTableHtml(scope: 'all' | 'playlist' = 'all'): Promise<string> {
    let idToName: Record<string, string> = {}
    const keyToName = await lxKeyToName()
    try {
      for (const p of await emby.listPlaylists()) idToName[p.id] = p.name
    } catch { /* Emby 未连接时显示 id */ }
    // 「进度历史」列：跑着的显示实时进度，没跑的显示上次结果 + 那天批次的关键计数
    const lastBatch: Record<number, repo.BatchRow> = {}
    for (const b of repo.listBatches(undefined, 300)) if (!(b.taskId in lastBatch)) lastBatch[b.taskId] = b // 已按 id DESC，首条即最新
    // 兜底：任务名缺失或仍是 key（旧数据/创建时未解析）→ 用 LX 歌单真实名称
    const tasks = repo
      .listTasks()
      .filter((t) => t.taskType !== 'adhoc') // 隐藏内部任务（手动下载容器）
      .filter((t) => scope !== 'playlist' || t.taskType === 'playlist')
      .map((t) => {
      const looksKey = !t.lxPlaylistName || t.lxPlaylistName === t.lxPlaylistKey || t.lxPlaylistName.startsWith('user:') || t.lxPlaylistName === 'loveList'
      return {
        ...t,
        lxPlaylistName: looksKey ? keyToName[t.lxPlaylistKey] ?? t.lxPlaylistKey : t.lxPlaylistName,
        sem: taskSemantics(t), // 模式列按新语义显示（旧 full 任务 → 镜像+keep）
      }
    })
    return renderBody('partials/task-table', {
      tasks,
      idToName,
      targetName: TARGET_LABEL[cfg.target] ?? 'Emby',
      watchOn: autoWatchOn(),
      fdelOk: supportsFileDelete(cfg.target),
      live: engine.live,
      lastBatch,
    })
  }

  /** 是否存在"自动纳入"机制（决定删除任务时是否提示「永久忽略」） */
  function autoWatchOn(): boolean {
    return cfg.general.listen.enabled || cfg.general.autoadd.enabled
  }

  r.get('/tasks/table', async (req, res) => {
    // scope=playlist（歌单同步页）只显示歌单任务；榜单订阅在榜单页、手动下载为内部任务
    const scope = String(req.query.scope ?? 'playlist')
    res.send(await taskTableHtml(scope === 'all' ? 'all' : 'playlist'))
  })

  // 批量创建(选择歌单多选):一次为多个 LX 歌单建同步任务(同默认设置)
  r.post('/tasks/bulk', async (req, res) => {
    const b = req.body ?? {}
    const raw = b.lxPlaylistKey
    const keys = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String).filter(Boolean)
    if (!keys.length) return res.status(400).send(err('未选择 LX 歌单'))
    const keyToName = await lxKeyToName()
    const existing = new Set(repo.listTasks().map((t) => t.lxPlaylistKey))
    const created: string[] = []
    const skipped: string[] = []
    let archiveNote = ''
    for (const key of keys) {
      if (existing.has(key)) { skipped.push(keyToName[key] ?? key); continue }
      const name = keyToName[key] ?? key
      repo.createTask({
        lxPlaylistKey: key,
        lxPlaylistName: name,
        embyTargetPlaylistIds: (Array.isArray(b.embyTarget) ? b.embyTarget : b.embyTarget ? [b.embyTarget] : []).map(String),
        createSameNamePlaylist: bool(b.createSameNamePlaylist),
        cronExpr: String(b.cronExpr ?? '').trim() || null,
        syncMode: b.syncMode === 'full' ? 'full' : 'incremental',
        mode: b.mode === 'mirror' || b.mode === 'incremental' ? b.mode : undefined,
        delPolicy: ['keep', 'delete', 'archive'].includes(b.delPolicy) ? b.delPolicy : undefined,
        archivePlaylist: String(b.archivePlaylist ?? '').trim() || undefined,
        taskType: 'playlist',
      })
      created.push(name)
      // 归档目标：配置期创建（含 [歌单名] 占位符时按来源逐个建）
      if (b.delPolicy === 'archive') {
        const an = resolveArchiveName(String(b.archivePlaylist ?? ''), name)
        const ar = await engine.ensureArchiveTarget(an, parseScope(b.playlistScope).scope)
        if (ar.created) archiveNote = `；已创建归档歌单「${an}」`
        else if (!ar.ok) archiveNote = `；归档歌单「${an}」创建失败：${ar.error}`
      }
    }
    scheduler.reload()
    const msg = []
    if (created.length) msg.push(ok('已创建 ' + created.length + ' 个任务:' + created.join('、') + '——请在「任务管理」页查看与操作' + archiveNote))
    if (skipped.length) msg.push('<span class="c-sub">已跳过(已存在):' + skipped.join('、') + '</span>')
    res.send(msg.join('<br>') || err('所选歌单均已有任务'))
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
      // 同一歌单重复建任务：友好提示（lxPlaylistKey 是 UNIQUE，不拦会抛 500）
      const dup = repo.listTasks().find((t) => t.lxPlaylistKey === key)
      if (dup) return res.send(err(`该歌单已有同步任务（任务「${dup.lxPlaylistName}」）—— 请勿重复添加`))
      const keyToName = await lxKeyToName()
      name = keyToName[key] ?? String(b.lxPlaylistName ?? '') ?? key
    }
    const embyTargets = Array.isArray(b.embyTarget) ? b.embyTarget : b.embyTarget ? [b.embyTarget] : []
    const sc = parseScope(b.playlistScope)
    const newTaskId = repo.createTask({
      lxPlaylistKey: key,
      lxPlaylistName: name || key,
      embyTargetPlaylistIds: embyTargets.map(String),
      createSameNamePlaylist: bool(b.createSameNamePlaylist),
      cronExpr: String(b.cronExpr ?? '').trim() || null,
      syncMode: b.syncMode === 'full' || b.mode === 'mirror' ? 'full' : 'incremental',
      mode: b.mode === 'mirror' || b.mode === 'incremental' ? b.mode : undefined,
      delPolicy: ['keep', 'delete', 'archive'].includes(b.delPolicy) ? b.delPolicy : undefined,
      archivePlaylist: String(b.archivePlaylist ?? '').trim() || undefined,
      dedupCheck: bool(b.dedupCheck),
      dedupMinQuality: String(b.dedupMinQuality ?? '').trim() || null,
      taskType: isChart ? 'chart' : 'playlist',
      chartSource: isChart ? chartSource : undefined,
      chartId: isChart ? chartId : undefined,
      chartName: isChart ? chartName : undefined,
      maxCount: isChart ? maxCount : undefined,
      playlistScope: sc.scope,
      playlistScopeName: sc.name,
    } as never)
    logger.info(`[task] 新建任务 #${newTaskId}「${name}」${isChart ? '（榜单订阅）' : ''}${b.delPolicy === 'archive' ? ' 归档目标=' + String(b.archivePlaylist ?? '') : ''}${b.mode === 'mirror' ? ' 镜像' : ' 增量'}`)
    // 配置期创建归档目标（运行期只找不建：用户删了不重建，降级为"保留文件"）
    let archiveNote = ''
    if (b.delPolicy === 'archive' && b.mode === 'mirror') {
      const an = resolveArchiveName(
        String(b.archivePlaylist ?? ''),
        name || key,
        isChart ? DEFAULT_CHART_ARCHIVE_PLAYLIST : DEFAULT_ARCHIVE_PLAYLIST,
      )
      const ar = await engine.ensureArchiveTarget(an, sc.scope)
      if (ar.created) archiveNote = `；已创建归档歌单「${an}」`
      else if (!ar.ok) archiveNote = `；归档歌单「${an}」创建失败：${ar.error}`
    }
    // 任务列表已移至任务管理页——创建后提示，去任务管理页查看
    const msg = isChart
      ? ok(`订阅已创建（${name}）——请在「榜单订阅 · 我的订阅」查看与同步`)
      : ok(`任务已创建（${name}）——请在「任务管理」页查看与操作${archiveNote}`)
    res.send(msg)
  })

  r.post('/task/:id/toggle', async (req, res) => {
    scheduler.reload()
    const t = repo.getTask(Number(req.params.id))
    if (!t) return res.status(404).send(err('任务不存在'))
    repo.updateTask(t.id, { enabled: t.enabled ? 0 : 1 })
    logger.info(`[task] ${t.enabled ? '停用' : '启用'}任务 #${t.id}「${t.lxPlaylistName}」`)
    res.send(await taskTableHtml('playlist'))
  })

  /**
   * 删除任务（三个复选框：文件 / 歌单 / 历史记录）。
   * 顺序要紧：先 applyDeletion（读得到本任务的归属与引用），再 deleteTask（把任务行收掉）。
   */
  r.post('/task/:id/delete', async (req, res) => {
    const id = Number(req.params.id)
    const t = repo.getTask(id)
    if (!t) return res.status(404).send(err('任务不存在'))
    if (engine.isRunning) return res.send(err('有任务正在运行，稍后再删除（避免和同步过程抢同一批文件）'))
    const body = (req.body ?? {}) as Record<string, unknown>
    const opts = { file: bool(body.file), playlist: bool(body.playlist), history: bool(body.history) }
    const rep = await applyDeletion({
      cfg,
      emby,
      targets: repo.listTaskSongKeys(id).map((songKey) => ({ taskId: id, songKey })),
      itemIds: repo.listHistoryItemIds(id),
      opts,
    })
    repo.deleteTask(id, { keepHistory: !opts.history })
    // 删除任务 = "不要这个歌单"：确认框勾选「永久忽略」时写入忽略列表，防止下次扫描重建。
    // ⚠️ listenScan 读的是 listen.ignoredKeys（旧代码只写 autoadd → 监听模式下删了又被重建）
    logger.info(`[task] 删除任务 #${id}「${t.lxPlaylistName}」（文件=${opts.file ? '删' : '留'} 歌单=${opts.playlist ? '移除' : '留'} 历史=${opts.history ? '删' : '留'}${bool(body.ignore) ? ' ·永久忽略' : ''}）｜${reportLine(rep)}`)
    if (t.lxPlaylistKey.startsWith('user:') && bool(body.ignore)) {
      const key = t.lxPlaylistKey
      const lists = [cfg.general.listen.ignoredKeys]
      if (cfg.general.autoadd.enabled) lists.push(cfg.general.autoadd.ignoredKeys)
      if (lists.some((arr) => !arr.includes(key))) {
        for (const arr of lists) if (!arr.includes(key)) arr.push(key)
        saveConfig(cfg)
      }
    }
    scheduler.reload()
    const gone = String(body.scope) === 'chart' ? '订阅已删除' : '任务已删除'
    const line = !opts.file && !opts.playlist && !opts.history
      ? `${gone}（未勾选连带清理项：文件 / 歌单内容 / 历史均保留）`
      : `${gone}。${reportLine(rep)}`
    const msgHtml = rep.errors.length ? err(line) : ok(line)
    if (String(body.scope) === 'chart') {
      // 榜单页：行表在 #ch-subs-rows，提示在 #ch-list-msg（两处都换掉）
      return res.send(chartSubsRows() + `<div id="ch-list-msg" hx-swap-oob="innerHTML">${msgHtml}</div>`)
    }
    res.send((await taskTableHtml('playlist')) + `<div id="task-msg" hx-swap-oob="innerHTML">${msgHtml}</div>`)
  })

  // 行内编辑：渲染编辑表单（替换该行）
  r.get('/task/:id/edit', async (req, res) => {
    const t = repo.getTask(Number(req.params.id))
    if (!t) return res.status(404).send(err('任务不存在'))
    if (t.taskType === 'chart') return res.send(err('榜单订阅请在「榜单订阅」页编辑'))
    let embyPlaylists: { id: string; name: string }[] = []
    try {
      embyPlaylists = await emby.listPlaylists()
    } catch { /* 未连接 */ }
    res.send(renderBody('partials/task-edit', { t, embyPlaylists, qOrder: QUALITY_ORDER, qLabels: QUALITY_LABELS, targetName: TARGET_LABEL[cfg.target] ?? 'Emby', scopeUI: cfg.target === 'emby' || cfg.target === 'jellyfin', targetKey: cfg.target }))
  })

  // 保存编辑
  r.post('/task/:id/update', async (req, res) => {
    scheduler.reload()
    const id = Number(req.params.id)
    const t = repo.getTask(id)
    if (!t) return res.status(404).send(err('任务不存在'))
    const b = req.body ?? {}
    if (t.taskType === 'chart') {
      const chMode = b.mode === 'mirror' || b.mode === 'incremental' ? (b.mode as 'mirror' | 'incremental') : null
      const chDel = ['keep', 'delete', 'archive'].includes(String(b.delPolicy)) ? (b.delPolicy as 'keep' | 'delete' | 'archive') : 'keep'
      repo.updateTask(id, {
        lxPlaylistName: String(b.lxPlaylistName ?? '').trim() || t.lxPlaylistName,
        maxCount: Math.max(0, Number(b.maxCount) || 30),
        createSameNamePlaylist: bool(b.createSameNamePlaylist) ? 1 : 0,
        cronExpr: String(b.cronExpr ?? '').trim() || null,
        syncMode: chMode === 'mirror' ? 'full' : 'incremental',
        mode: chMode,
        delPolicy: chDel,
        archivePlaylist: String(b.archivePlaylist ?? '').trim() || null,
        playlistScope: parseScope(b.playlistScope).scope,
        playlistScopeName: parseScope(b.playlistScope).name,
      })
      // 配置期创建归档目标（运行期只找不建）
      let chNote = ''
      if (chMode === 'mirror' && chDel === 'archive') {
        const t2 = repo.getTask(id)!
        const an = archiveNameOf(t2)
        const ar = await engine.ensureArchiveTarget(an, t2.playlistScope ?? 'shared')
        if (ar.created) chNote = `；已创建归档歌单「${an}」`
        else if (!ar.ok) chNote = `；归档歌单「${an}」创建失败：${ar.error}`
      }
      // hx-swap="none"：正文用不到，提示走 oob 写到列表标题旁（编辑卡保存后会消失）
      const oobMsg = chNote
        ? `<div id="ch-list-msg" hx-swap-oob="innerHTML"><span class="ok">✅ 订阅已保存${escapeHtml(chNote)}</span></div>`
        : ''
      return res.send(ok('订阅已保存' + chNote) + oobMsg)
    }
    const embyTargets = Array.isArray(b.embyTarget) ? b.embyTarget : b.embyTarget ? [b.embyTarget] : []
    const newMode = b.mode === 'mirror' || b.mode === 'incremental' ? (b.mode as 'incremental' | 'mirror') : undefined
    repo.updateTask(id, {
      embyTargetPlaylistIds: JSON.stringify(embyTargets.map(String)),
      createSameNamePlaylist: boolV(b.createSameNamePlaylist) ? 1 : 0,
      syncMode: b.mode === 'mirror' || b.syncMode === 'full' ? 'full' : 'incremental',
      mode: newMode ?? null,
      delPolicy: ['keep', 'delete', 'archive'].includes(String(b.delPolicy)) ? (b.delPolicy as 'keep' | 'delete' | 'archive') : 'keep',
      archivePlaylist: String(b.archivePlaylist ?? '').trim() || null,
      cronExpr: String(b.cronExpr ?? '').trim() || null,
      dedupCheck: boolV(b.dedupCheck) ? 1 : 0,
      dedupMinQuality: String(b.dedupMinQuality ?? '').trim() || null,
      playlistScope: parseScope(b.playlistScope).scope,
      playlistScopeName: parseScope(b.playlistScope).name,
    })
    // 配置期创建归档目标（运行期只找不建）——用 oob 提示，表格照常刷新
    const t2 = repo.getTask(id)
    let oob = ''
    if (t2 && t2.delPolicy === 'archive') {
      const an = resolveArchiveName(t2.archivePlaylist, t2.lxPlaylistName)
      const ar = await engine.ensureArchiveTarget(an, t2.playlistScope ?? 'shared')
      if (ar.created) oob = `<div id="task-msg" hx-swap-oob="innerHTML">${ok(`已创建归档歌单「${escapeHtml(an)}」`)}</div>`
      else if (!ar.ok) oob = `<div id="task-msg" hx-swap-oob="innerHTML">${err(`归档歌单「${escapeHtml(an)}」创建失败：${escapeHtml(ar.error ?? '')}`)}</div>`
    }
    res.send((await taskTableHtml('playlist')) + oob)
  })

  r.post('/task/:id/run', async (req, res) => {
    const id = Number(req.params.id)
    const t = repo.getTask(id)
    if (!t) return res.status(404).send(err('任务不存在'))
    // 先用引擎的预检拿准确原因再回复：不能"先答应已开始、引擎再静默退出"
    const blocked = engine.checkRun(id, 'manual')
    if (blocked) return res.send(err(RUN_BLOCKED[blocked]))
    const wasDisabled = !t.enabled
    void engine.runTask(id, 'manual')
    res.send(ok(`已开始同步${wasDisabled ? '（该任务处于停用状态，本次为手动单次运行，不影响定时）' : ''}——进度见「进度历史」页`))
  })

  // ===== 任务进度 =====
  // 实时进度（内存态，1 秒轮询）：正在下载第几首/共几首、阶段、当前歌曲、计数
  r.get('/progress/live', (_req, res) => {
    const l = engine.live
    const now = Date.now()
    res.send(
      renderBody('partials/progress-live', {
        live: l,
        elapsedSec: l ? Math.max(0, Math.round(((l.finishedAt ?? now) - l.startedAt) / 1000)) : 0,
        pct: l && l.total > 0 ? Math.min(100, Math.round((l.done / l.total) * 100)) : 0,
      }),
    )
  })

  // 实时进度（JSON）：列表页轮询用（微缩进度条）
  r.get('/progress/json', (_req, res) => {
    const l = engine.live
    if (!l || l.finishedAt !== null) return res.json({ running: false })
    const pct = l.total > 0 ? Math.min(100, Math.round((l.done / l.total) * 100)) : 0
    res.json({
      running: true,
      taskId: l.taskId,
      taskName: l.taskName,
      phase: l.phase,
      index: l.index,
      total: l.total,
      done: l.done,
      pct,
      ok: l.ok,
      fail: l.fail,
      unsat: l.unsat,
      current: l.current?.name ?? null,
    })
  })

  r.get('/progress/table', (req, res) => {
    const onlyIssue = String(req.query.onlyIssue ?? '') === '1'
    const tasks = repo.listTasks()
    const counts = repo.historyCountsByTaskSong()
    const refs = repo.refCountsBySong()
    const statusByTask: Record<number, unknown[]> = {}
    for (const t of tasks) {
      const rows = repo.listSongStatus(t.id)
      statusByTask[t.id] = onlyIssue ? rows.filter((s) => s.status === 'failed' || s.status === 'unsatisfied') : rows
    }
    res.send(renderBody('partials/progress-table', { tasks, statusByTask, counts, refs, running: engine.isRunning, onlyIssue, H: HMeta }))
  })

  // ===== 进度历史（重构后的查询层，P2）=====
  const qs = (v: unknown): string | undefined => {
    const s = String(v ?? '').trim()
    return s ? s : undefined
  }

  /** 平铺事件表：一次「任务运行 × 歌曲」一行，支持表头筛选 + keyset 分页 */
  r.get('/history/rows', (req, res) => {
    const q = req.query
    // 日期筛选按**本地时区**解释（库里存的是 UTC ISO）：'2026-09-12' → 本地当天 00:00 ~ 23:59:59.999
    const localStart = (d?: string) => (d && !d.includes('T') ? new Date(`${d}T00:00:00`).toISOString() : d)
    const localEnd = (d?: string) => (d && !d.includes('T') ? new Date(`${d}T23:59:59.999`).toISOString() : d)
    const f: repo.HistoryQuery = {
      q: qs(q.q), song: qs(q.song), singer: qs(q.singer), attr: qs(q.attr),
      taskName: qs(q.taskName), trigger: qs(q.trigger), mode: qs(q.mode),
      quality: qs(q.quality), action: qs(q.action), process: qs(q.process), status: qs(q.status),
      from: localStart(qs(q.from)), to: localEnd(qs(q.to)), path: qs(q.path),
      cursor: Number(q.cursor) || undefined,
      limit: Number(q.limit) || undefined,
    }
    const PAGE = Math.min(500, f.limit ?? 100)
    const rows = repo.listHistoryRows({ ...f, limit: PAGE + 1 })
    const hasMore = rows.length > PAGE
    f.limit = PAGE
    const facets = repo.historyFacets()
    // 筛选框回填用原始输入（f.from/to 已转成 UTC ISO，不能再回显给日期控件）
    const raw = { from: qs(q.from) ?? '', to: qs(q.to) ?? '' }
    res.send(renderBody('partials/history-rows', { rows: rows.slice(0, PAGE), hasMore, f, raw, facets, H: HMeta }))
  })

  /** 批次视图：每批次一行（含跳过名单），空批次也在这里出现 */
  r.get('/history/batches', (req, res) => {
    const q = req.query
    const f = { taskName: qs(q.taskName), trigger: qs(q.trigger), mode: qs(q.mode), from: qs(q.from), to: qs(q.to), cursor: Number(q.cursor) || undefined }
    const PAGE = 100
    const rows = repo.listBatchRows({ ...f, limit: PAGE + 1 })
    const hasMore = rows.length > PAGE
    res.send(renderBody('partials/history-batches', { batches: rows.slice(0, PAGE), hasMore, f, H: HMeta }))
  })

  /** 搜索卡：命中歌单 + 命中歌曲（按歌聚合：当前状态/文件来源/首次·最近/记录数） */
  r.get('/history/search', (req, res) => {
    const q = qs(req.query.q)
    if (!q) return res.send('')
    const tasks = repo.searchTasks(q)
    const songs = repo.searchSongs(q)
    res.send(renderBody('partials/history-search', { q, tasks, songs, H: HMeta }))
  })

  // ===== 历史 =====
  // type=playlist 歌单同步任务 | type=chart 榜单订阅任务（含手动下载） | 缺省 all
  r.get('/history/partial', (req, res) => {
    const type = String(req.query.type ?? 'all')
    const counts = repo.historyItemCounts()
    const batches = repo
      .listBatches(undefined, 80)
      .map((b) => {
        const t = repo.getTask(b.taskId)
        // 任务可能已被删（删除任务时选择"保留历史"）→ 用批次里的快照名/类型兜底
        return {
          ...b,
          taskName: t?.lxPlaylistName ?? b.taskName ?? `已删除的任务 #${b.taskId}`,
          taskType: t?.taskType ?? b.taskType ?? 'playlist',
          itemCount: counts[b.id] ?? 0,
        }
      })
      .filter((b) => type === 'all' || (type === 'chart' ? b.taskType === 'chart' || b.taskType === 'adhoc' : b.taskType === type))
      .slice(0, 20)
    res.send(renderBody('partials/history', { batches }))
  })

  /**
   * 历史页批量删除（勾选若干条记录 + 三个复选框）。
   * 选择以 token 传：`b:<批次id>`（整批）/ `i:<明细id>`（单曲）；整批由服务端展开成明细。
   */
  r.post('/history/delete', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const tokens = String(body.sel ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!tokens.length) return res.send(err('未勾选任何记录'))
    if (engine.isRunning) return res.send(err('有任务正在运行，稍后再删除（避免和同步过程抢同一批文件）'))
    const opts = { file: bool(body.file), playlist: bool(body.playlist), history: bool(body.history) }
    if (!opts.file && !opts.playlist && !opts.history) return res.send(err('请至少勾选一项要删除的内容'))

    const itemIds = new Set<number>()
    const batchIds: number[] = []
    const targets = new Map<string, { taskId: number; songKey: string }>()
    const addItem = (it: { id: number; taskId: number; songKey: string } | undefined) => {
      if (!it) return
      itemIds.add(it.id)
      targets.set(`${it.taskId} ${it.songKey}`, { taskId: it.taskId, songKey: it.songKey })
    }
    for (const tok of tokens) {
      const parts = tok.split(':')
      const kind = parts[0]
      const id = Number(parts[1])
      if (kind === 's') {
        // s:<taskId>:<songKey>：按「任务×歌曲」删（台账里没有具体事件行 id，只能这么指）
        const songKey = parts.slice(2).join(':')
        if (!id || !songKey) continue
        for (const it of dbAll('SELECT id, taskId, songKey FROM history_item WHERE taskId = ? AND songKey = ?', [id, songKey])) addItem(it)
        targets.set(`${id} ${songKey}`, { taskId: id, songKey })
      } else if (!id) {
        continue
      } else if (kind === 'b') {
        batchIds.push(id)
        for (const it of dbAll('SELECT id, taskId, songKey FROM history_item WHERE batchId = ?', [id])) addItem(it)
      } else {
        addItem(dbGet('SELECT id, taskId, songKey FROM history_item WHERE id = ?', [id]))
      }
    }
    const rep = await applyDeletion({ cfg, emby, targets: [...targets.values()], itemIds: [...itemIds], batchIds, opts })
    const line = reportLine(rep)
    res.send(rep.errors.length ? err(line) : ok(line))
  })

  r.get('/history/batch/:id', (req, res) => {
    const items = dbAll('SELECT * FROM history_item WHERE batchId = ? ORDER BY id', [Number(req.params.id)])
    res.send(renderBody('partials/history-items', { items }))
  })

  r.post('/history/item/:id/retry', async (req, res) => {
    const item = dbGet('SELECT * FROM history_item WHERE id = ?', [Number(req.params.id)])
    if (!item) return res.status(404).send(err('记录不存在'))
    if (engine.isRunning) return res.send(err('已有任务在运行，稍后再试'))
    // ⚠️ 必须兜住异常：抛 500 时 htmx 不会替换内容，用户点了按钮"毫无反馈"（实测踩到）
    let msg: string
    try {
      const r = await engine.retrySong(item.taskId, item.songKey)
      msg = r === 'success' ? ok('重试成功，已补入库+入歌单') : err(`重试未成功（${r === 'song-not-in-source' ? '这首歌已不在源歌单/榜单里' : r}）`)
    } catch (e) {
      logger.warn(`[retry] 重试失败: ${(e as Error).message}`)
      msg = err(`重试出错：${escapeHtml((e as Error).message)}`)
    }
    res.send(`<td colspan="7">${msg}</td>`)
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
  // 日志片段：按级别/关键字过滤（数据源 = 落盘文件，重启不丢）
  r.get('/logs/partial', (req, res) => {
    const level = String(req.query.level ?? '')
    const q = String(req.query.q ?? '')
    const limit = Math.min(2000, Math.max(50, Number(req.query.limit) || 400))
    const rows = logger.list({ limit, level, q })
    if (!rows.length) return res.type('html').send('<p class="text-xs c-sub py-8 text-center">没有匹配的日志</p>')
    res.type('html').send(
      rows
        .map(
          (l) =>
            `<div class="log-line lv-${l.level}"><span class="lg-ts">${escapeHtml(l.ts)}</span><span class="lg-lv">${l.level.toUpperCase()}</span><span class="lg-msg">${escapeHtml(l.msg)}</span></div>`,
        )
        .join(''),
    )
  })

  // ===== 通用设置 =====
  r.post('/config/general', (req, res) => {
    const b = req.body ?? {}
    // 这三个开关已从界面移除（前两个废弃/未接通；暂停所有同步不再提供入口）。
    // 值从表单缺席时保持原值，避免保存设置把它们悄悄重置。
    if (b.pauseAll !== undefined) cfg.general.pauseAll = bool(b.pauseAll)
    cfg.general.logRetentionDays = Math.min(365, Math.max(1, Number(b.logRetentionDays) || 30))
    saveConfig(cfg)
    logger.info(`[config] 通用设置：暂停全部=${cfg.general.pauseAll ? '开' : '关'} 日志保留=${cfg.general.logRetentionDays}天`)
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

  // ===== 监听同步配置(单监听器+模式互斥;新模型,见 docs/sync-redesign-spec.md)=====
  function parseStrArray(v: unknown): string[] {
    if (Array.isArray(v)) return v.map(String)
    if (typeof v === 'string') return v.split(/[,，\s]+/).filter(Boolean)
    return []
  }
  function applyListenParams(dst: ListenParams, src: Record<string, unknown>): void {
    dst.createSameNamePlaylist = boolV(src.createSameNamePlaylist)
    const ids = Array.isArray(src.embyTarget) ? src.embyTarget : src.embyTarget ? [src.embyTarget] : undefined
    if (ids !== undefined) dst.embyTargetPlaylistIds = ids.map(String)
    if (src.taskMode === 'mirror' || src.taskMode === 'incremental') dst.taskMode = src.taskMode
    if (['keep', 'delete', 'archive'].includes(String(src.delPolicy))) dst.delPolicy = src.delPolicy as ListenParams['delPolicy']
    if (src.archivePlaylist !== undefined) dst.archivePlaylist = String(src.archivePlaylist ?? '').trim() || DEFAULT_ARCHIVE_PLAYLIST
    if (src.taskCron !== undefined) dst.taskCron = String(src.taskCron ?? '').trim()
    dst.dedupCheck = boolV(src.dedupCheck)
    if (src.dedupMinQuality !== undefined) dst.dedupMinQuality = String(src.dedupMinQuality ?? '').trim() || null
  }
  r.post('/config/listen', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const L = cfg.general.listen
    L.enabled = boolV(b.enabled)
    if (b.activeMode === 'all' || b.activeMode === 'filtered') L.activeMode = b.activeMode
    if (b.checkCron !== undefined) L.checkCron = String(b.checkCron ?? '').trim()
    // 「包含现有歌单」开关：勾选=忽略基线(现有+今后全部纳入)，取消=把当前歌单重新快照成基线
    const wasInclude = L.includeExisting
    L.includeExisting = boolV(b.includeExisting)
    let note = ''
    if (!wasInclude && L.includeExisting) {
      L.baselineKeys = []
      note = '；已纳入现有歌单'
    } else if (wasInclude && !L.includeExisting) {
      try {
        L.baselineKeys = (await lx.listPlaylists()).map((p) => p.key)
        note = `；已重新记录基线（现有 ${L.baselineKeys.length} 个歌单不再自动纳入）`
      } catch {
        note = '；LX 未连接，基线未能重记（下次启用监听时会补记）'
      }
    }
    if (b.all) applyListenParams(L.all, b.all as Record<string, unknown>)
    const f = b.filtered as Record<string, unknown> | undefined
    if (f) {
      if (f.params) applyListenParams(L.filtered.params, f.params as Record<string, unknown>)
      const ru = f.rules as Record<string, unknown> | undefined
      if (ru) {
        for (const g of ['exclude', 'match'] as const) {
          const grp = ru[g] as Record<string, unknown> | undefined
          if (!grp) continue
          const dst = L.filtered.rules[g]
          dst.enabled = boolV(grp.enabled)
          if (grp.playlists !== undefined) dst.playlists = parseStrArray(grp.playlists)
          if (grp.keywords !== undefined) dst.keywords = parseStrArray(grp.keywords)
        }
      }
    }
    // 归档目标：配置期创建（统一目标；含 [歌单名] 占位符的按来源目标在任务创建时逐个建）
    for (const tn of new Set([L.all, L.filtered.params].filter((p) => p.delPolicy === 'archive').map((p) => p.archivePlaylist))) {
      if (isArchiveTemplate(tn)) continue
      const ar = await engine.ensureArchiveTarget(tn)
      if (ar.created) note += `；已创建归档歌单「${tn}」`
      else if (!ar.ok) note += `；归档歌单「${tn}」创建失败：${ar.error}`
    }
    saveConfig(cfg)
    scheduler.reload()
    // 刚勾上「包含现有歌单」且监听已启用 → 后台立即为这批歌单建任务并同步（不阻塞保存响应）
    if (!wasInclude && L.includeExisting && L.enabled) {
      note += '；正在后台为现有歌单创建任务并同步，进度见「任务进度」'
      void listenScan(cfg, lx, engine).catch((e) => logger.warn(`[listen] 纳入现有歌单失败: ${(e as Error).message}`))
    }
    res.send(ok('监听设置已保存' + note))
  })

  // ===== 监听同步(新模型)=====
  r.post('/listen/scan', async (_req, res) => {
    if (!cfg.general.listen.enabled) return res.send(err('请先启用监听(标签2)'))
    try {
      const rr = await listenScan(cfg, lx, engine)
      if (rr.created > 0) res.send(ok('监听检测完成:自动创建 ' + rr.created + ' 个任务并同步(' + rr.names.join('、') + ')' + (rr.skipped ? ';规则跳过 ' + rr.skipped + ' 个' : '')))
      else res.send(ok('监听检测完成:无新增歌单' + (rr.skipped ? '(规则跳过 ' + rr.skipped + ' 个)' : '')))
    } catch (e) {
      res.send(err('监听检测失败:' + (e as Error).message))
    }
  })

  r.get('/listen/status', (_req, res) => {
    res.json({ ok: true, enabled: cfg.general.listen.enabled, activeMode: cfg.general.listen.activeMode, groups: repo.taskOriginStats(), scan: listenStatus })
  })

  // 模式切换(A+C):默认保持旧模式任务运行;taskPolicy=pause 时一键暂停旧 origin 组
  r.post('/listen/switch', (req, res) => {
    const b = req.body ?? {}
    const mode = String(b.mode ?? '')
    if (mode !== 'all' && mode !== 'filtered') return res.status(400).send(err('mode 必须为 all|filtered'))
    const L = cfg.general.listen
    const oldMode = L.activeMode
    L.activeMode = mode
    let paused = 0
    if (String(b.taskPolicy ?? '') === 'pause') {
      paused = repo.setTasksEnabledByOrigin(originOfMode(oldMode), false)
    }
    saveConfig(cfg)
    scheduler.reload()
    const modeTxt = (m: string) => (m === 'all' ? '完全同步' : '条件增量')
    res.send(ok(`已切换为「${modeTxt(mode)}」` + (paused ? `,并暂停旧「${modeTxt(oldMode)}」自动创建的任务 ${paused} 个(可随时恢复)` : ',旧模式任务保持运行')))
  })

  // 恢复被暂停的 origin 组
  r.post('/listen/resume', (req, res) => {
    const b = req.body ?? {}
    const mode = String(b.mode ?? '')
    if (mode !== 'all' && mode !== 'filtered') return res.status(400).send(err('mode 必须为 all|filtered'))
    const n = repo.setTasksEnabledByOrigin(originOfMode(mode), true)
    saveConfig(cfg)
    scheduler.reload()
    res.send(ok(`已恢复 ${n} 个任务(origin=${originOfMode(mode)})`))
  })

  // 忽略列表（被删除过/手动忽略的歌单 → 不自动重建）
  r.get('/listen/ignored/panel', async (_req, res) => { res.send(await ignoredPanelHtml()) })

  r.post('/listen/unignore', async (req, res) => {
    const key = String((req.body ?? {}).key ?? '').trim()
    const L = cfg.general.listen
    if (key && L.ignoredKeys.includes(key)) {
      L.ignoredKeys = L.ignoredKeys.filter((k) => k !== key)
      cfg.general.autoadd.ignoredKeys = cfg.general.autoadd.ignoredKeys.filter((k) => k !== key)
      saveConfig(cfg)
    }
    res.send(await ignoredPanelHtml())
  })

  /** 忽略列表面板片段（空列表返回空 → 前端不显示） */
  async function ignoredPanelHtml(): Promise<string> {
    const keys = cfg.general.listen.ignoredKeys
    if (!keys.length) return ''
    const esc = (s: string) => escapeHtml(s).replace(/"/g, '&quot;')
    let nameOf: Record<string, string> = {}
    try {
      for (const p of await lx.listPlaylists()) nameOf[p.key] = p.name
    } catch { /* LX 未连接时只显示 key */ }
    let html =
      `<details class="rounded-lg border border-base-300 p-2">` +
      `<summary class="text-sm cursor-pointer">已忽略歌单（${keys.length}）<span class="text-xs c-sub"> — 删除后不再自动重建</span></summary>` +
      `<ul class="mt-2 space-y-1">`
    for (const k of keys) {
      html +=
        `<li class="flex flex-wrap items-center gap-2">` +
        `<span class="text-sm">${esc(nameOf[k] ?? k)}</span>` +
        `<code class="text-xs c-sub">${esc(k)}</code>` +
        `<form hx-post="/api/listen/unignore" hx-target="#listen-ignored" hx-swap="innerHTML">` +
        `<input type="hidden" name="key" value="${esc(k)}">` +
        `<button type="submit" class="btn btn-outline btn-xs px-2">取消忽略</button></form>` +
        `</li>`
    }
    html += `</ul><p class="text-xs c-sub mt-2">取消忽略后，下次监听扫描会重新为该歌单创建任务。</p></details>`
    return html
  }

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
    return `<button class="btn-sm secondary" hx-post="/api/dupe/delete" hx-vals='{"ids":"${escapeHtml(it.id)}"}' hx-target="closest td" hx-swap="innerHTML" hx-on::after-request="htmx.ajax('GET','/api/trash/partial',{target:'.trash-host'})" hx-confirm="将移入回收站（可恢复）。确认？\n${escapeHtml(it.path)}">移入回收站</button>`
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
    // 安全缓冲：删除 = 文件移入回收站（.songhamster-trash），可恢复；Emby 条目由后续扫描自然清理
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
          `<button class="btn-sm" hx-post="/api/trash/restore" hx-vals='{"rel":"${escapeHtml(f.rel)}"}' hx-target="closest div" hx-swap="outerHTML" hx-on::after-request="htmx.ajax('GET','/api/trash/partial',{target:'.trash-host'})">恢复</button>` +
          `<button class="btn-sm secondary" hx-post="/api/trash/purge" hx-vals='{"full":"${escapeHtml(f.full)}"}' hx-confirm="彻底删除该文件（不可恢复）？\n${escapeHtml(f.rel)}" hx-target="closest div" hx-swap="outerHTML" hx-on::after-request="htmx.ajax('GET','/api/trash/partial',{target:'.trash-host'})">彻底删除</button>` +
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
