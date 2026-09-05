import { Router, type Request } from 'express'
import type { AppConfig } from '../config.js'
import { QUALITY_ORDER, QUALITY_LABELS } from '../config.js'
import { LxServerAdapter } from '../adapters/lxserver.js'
import type { MediaServerAdapter } from '../adapters/media-server.js'
import { renderPage, VERSION } from '../views/render.js'
import { currentUser } from '../auth.js'

export const NAV = [
  { id: 'connect', label: '连接容器' },
  { id: 'sync-setup', label: '同步设置' },
  { id: 'options', label: '下载选项' },
  { id: 'progress', label: '任务进度' },
  { id: 'history', label: '历史记录' },
  { id: 'library', label: '曲库管理' },
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
  })

  r.get('/', (_req, res) => res.redirect('/connect'))

  // 连接容器：LX 连接 + Emby 连接
  r.get('/connect', (_req, res) => {
    res.type('html').send(renderPage('connect', base('connect', _req)))
  })

  // 下载选项（全局）
  r.get('/options', (_req, res) => {
    res.type('html').send(renderPage('options', { ...base('options', _req), qOrder: QUALITY_ORDER, qLabels: QUALITY_LABELS }))
  })

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
    res.type('html').send(renderPage('sync-setup', { ...base('sync-setup', _req), lxPlaylists, embyPlaylists, lxError, qOrder: QUALITY_ORDER, qLabels: QUALITY_LABELS }))
  })

  r.get('/progress', (_req, res) => {
    res.type('html').send(renderPage('progress', base('progress', _req)))
  })

  r.get('/history', (_req, res) => {
    res.type('html').send(renderPage('history', base('history', _req)))
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
