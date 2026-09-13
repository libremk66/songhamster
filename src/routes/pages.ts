import { Router, type Request } from 'express'
import type { AppConfig } from '../config.js'
import { QUALITY_ORDER, QUALITY_LABELS, TARGET_LABEL, supportsFileDelete } from '../config.js'
import { LxServerAdapter } from '../adapters/lxserver.js'
import type { MediaServerAdapter } from '../adapters/media-server.js'
import { renderPage, VERSION } from '../views/render.js'
import { delTaskDialog } from '../views/partials/del-dialog.js'
import * as repo from '../store/repo.js'
import { currentUser } from '../auth.js'

export const NAV = [
  { id: 'connect', label: '连接容器' },
  { id: 'sync-setup', label: '歌单同步' },
  { id: 'charts', label: '榜单订阅' },
  { id: 'options', label: '下载选项' },
  // 任务进度已并入「进度历史」（实时进度在页顶，历史按歌单/榜单分标签）
  { id: 'history', label: '进度历史' },
  // 曲库管理：暂时隐藏（路由/页面保留，需要时取消注释即可恢复）
  // { id: 'library', label: '曲库管理' },
  { id: 'logs', label: '日志' },
  { id: 'settings', label: '设置' },
] as const

export function pagesRouter(getCfg: () => AppConfig, lx: LxServerAdapter, emby: MediaServerAdapter): Router {
  const r = Router()
  const base = (page: string, req: Request) => ({
    nav: NAV,
    active: page,
    cfg: getCfg(),
    version: VERSION,
    githubUrl: getCfg().general.githubUrl || '',
    authEnabled: getCfg().auth.enabled,
    authUser: currentUser(req),
    targetName: TARGET_LABEL[getCfg().target] ?? 'Emby',
  })

  r.get('/', (_req, res) => res.redirect('/connect'))

  // 连接容器：LX 连接 + Emby 连接
  r.get('/connect', (_req, res) => {
    res.type('html').send(renderPage('connect', base('connect', _req)))
  })

  // 下载选项（全局）
  // 榜单订阅（浏览 + 我的订阅；订阅列表由 /api/charts/subs 片段加载）
  r.get('/charts', async (_req, res) => {
    let embyPlaylists: { id: string; name: string }[] = []
    if (getCfg().emby.apiKey) {
      try {
        embyPlaylists = await emby.listPlaylists()
      } catch { /* 未连接 */ }
    }
    res.type('html').send(
      renderPage('charts', {
        ...base('charts', _req),
        embyPlaylists,
        fileDeleteOK: supportsFileDelete(getCfg().target),
        delDialog: delTaskDialog('chart'),
        scopeUI: getCfg().target === 'emby' || getCfg().target === 'jellyfin',
        targetKey: getCfg().target,
      }),
    )
  })

  r.get('/options', (_req, res) => {
    res.type('html').send(renderPage('options', { ...base('options', _req), qOrder: QUALITY_ORDER, qLabels: QUALITY_LABELS }))
  })

  // 同步任务设计器原型页 /sync-designer 已移除（设计已并入正式页，见 docs/sync-redesign-spec.md）

  r.get('/sync-setup', async (_req, res) => {
    let lxPlaylists: { key: string; name: string; songCount: number }[] = []
    let embyPlaylists: { id: string; name: string; itemCount?: number }[] = []
    let lxError = ''
    if (getCfg().lxserver.apiKey) {
      try {
        lxPlaylists = await lx.listPlaylists()
      } catch (e) {
        lxError = (e as Error).message
      }
    }
    if (getCfg().emby.apiKey) {
      try {
        embyPlaylists = await emby.listPlaylists()
      } catch { /* 忽略 */ }
    }
    // 「包含现有歌单（N 个）」的 N：还没建任务、也没被忽略的现有歌单
    const lis = getCfg().general.listen
    const skip = new Set([...repo.listTasks().map((t) => t.lxPlaylistKey), ...lis.ignoredKeys])
    const existingCount = lxPlaylists.filter((p) => p.key.startsWith('user:') && !skip.has(p.key)).length
    res.type('html').send(renderPage('sync-setup', { ...base('sync-setup', _req), lxPlaylists, embyPlaylists, lxError, qOrder: QUALITY_ORDER, qLabels: QUALITY_LABELS, listen: lis, existingCount, fileDeleteOK: supportsFileDelete(getCfg().target), delDialog: delTaskDialog('playlist'), scopeUI: getCfg().target === 'emby' || getCfg().target === 'jellyfin', targetKey: getCfg().target }))
  })

  // 进度历史：实时进度（页顶，原「任务进度」）+ 按类型分标签的历史
  r.get('/history', (req, res) => {
    // 支持 ?tab=rows|status|trash（默认 rows）：初始标签由服务端决定，
    // 避免"脚本先切、页面自带的 load 又切回来"的竞态（实测踩到）
    const tab = ['rows', 'status', 'trash'].includes(String(req.query.tab)) ? String(req.query.tab) : 'rows'
    res.type('html').send(renderPage('history', { ...base('history', req), initialTab: tab }))
  })

  // 曲库管理（安全洗版 / 查重清理）
  r.get('/library', async (_req, res) => {
    let musicLibs: { id: string; name: string; locations: string[]; isProject: boolean }[] = []
    try {
      const libs = await emby.listLibraries()
      const libRoot = getCfg().emby.libraryRoot?.replace(/\/+$/, '')
      musicLibs = libs.map((l) => ({
        ...l,
        isProject: !!libRoot && l.locations.some((p) => {
          const x = p.replace(/\/+$/, '')
          return x === libRoot || x.startsWith(libRoot + '/') || libRoot.startsWith(x + '/')
        }),
      }))
    } catch { /* 未连接 */ }
    res.type('html').send(renderPage('library', { ...base('library', _req), qOrder: QUALITY_ORDER, qLabels: QUALITY_LABELS, musicLibs }))
  })

  r.get('/logs', (_req, res) => {
    res.type('html').send(renderPage('logs', { ...base('logs', _req), logs: '' }))
  })

  r.get('/settings', (_req, res) => {
    res.type('html').send(renderPage('settings', { ...base('settings', _req), qOrder: QUALITY_ORDER, qLabels: QUALITY_LABELS }))
  })

  return r
}
