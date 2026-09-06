import express from 'express'
import cookieParser from 'cookie-parser'
import path from 'node:path'
import { loadConfig, saveConfig } from './config.js'
import { getDb } from './store/db.js'
import { LxServerAdapter } from './adapters/lxserver.js'
import { EmbyAdapter } from './adapters/emby.js'
import { NavidromeAdapter } from './adapters/navidrome.js'
import { DaoliyuAdapter } from './adapters/daoliyu.js'
import { SubsonicAdapter } from './adapters/subsonic.js'
import type { MediaServerAdapter } from './adapters/media-server.js'
import { SyncEngine } from './core/sync-engine.js'
import { Scheduler } from './scheduler/index.js'
import { pagesRouter } from './routes/pages.js'
import { apiRouter } from './routes/api.js'
import { renderBody } from './views/render.js'
import { authRequired, createSession, destroySession, initAuthFromEnv, isSessionValid, verifyPassword, COOKIE_NAME } from './auth.js'
import { logger } from './core/logger.js'

const config = loadConfig()
getDb() // 初始化 SQLite（含迁移）
initAuthFromEnv(config) // docker env 注入初始账号（SONGFERRY_AUTH_USER/PASSWORD）

/** 按 cfg.target 实例化媒体服务器适配器 */
function makeServer(): MediaServerAdapter {
  if (config.target === 'navidrome') return new NavidromeAdapter(() => config)
  if (config.target === 'daoliyu') return new DaoliyuAdapter(() => config)
  if (config.target === 'subsonic') return new SubsonicAdapter(() => config)
  if (config.target === 'jellyfin') return new EmbyAdapter(() => config, 'jellyfin')
  return new EmbyAdapter(() => config)
}

// 可变服务器适配器：target 切换（POST /api/config/target）即换实例，引擎/路由经由 proxy 透明跟随
let serverImpl: MediaServerAdapter = makeServer()
const server: MediaServerAdapter = new Proxy({} as MediaServerAdapter, {
  get: (_t, p) => {
    const v = (serverImpl as any)[p]
    return typeof v === 'function' ? v.bind(serverImpl) : v
  },
})

const lx = new LxServerAdapter(() => config)
const engine = new SyncEngine(() => config, lx, server)
const scheduler = new Scheduler(() => config, engine, lx)
scheduler.init() // 任务 cron + 自动新增检测 cron

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())
app.use('/static', express.static(path.join(process.cwd(), 'static')))

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, version: '0.1.0', time: new Date().toISOString() })
})

// ===== 登录页（认证白名单） =====
app.get('/login', (_req, res) => {
  res.type('html').send(renderBody('login', { authEnabled: config.auth.enabled }))
})

app.post('/api/auth/login', (req, res) => {
  const b = req.body ?? {}
  const u = String(b.username ?? '')
  const p = String(b.password ?? '')
  if (!config.auth.enabled) return res.status(400).json({ ok: false, error: '认证未启用' })
  if (u === config.auth.username && verifyPassword(p, config.auth.passwordHash)) {
    const token = createSession(u)
    res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400_000, path: '/' })
    res.json({ ok: true })
  } else {
    res.status(401).json({ ok: false, error: '用户名或密码错误' })
  }
})

app.post('/api/auth/logout', (req, res) => {
  const token = (req.cookies as Record<string, string>)?.[COOKIE_NAME]
  if (token) destroySession(token)
  res.clearCookie(COOKIE_NAME, { path: '/' })
  res.redirect('/login')
})

app.get('/api/auth/status', (req, res) => {
  res.json({ enabled: config.auth.enabled, username: config.auth.username, authed: isSessionValid((req.cookies as Record<string, string>)?.[COOKIE_NAME]) })
})

// ===== 其余页面与 API 均需认证（开启时） =====
app.use(authRequired(() => config))

// 媒体服务器目标切换（emby | navidrome）：保存并即时重建适配器（引擎/路由经 proxy 自动跟随）
app.post('/api/config/target', (req, res) => {
  const t = String((req.body ?? {}).target ?? '')
  if (t !== 'emby' && t !== 'navidrome' && t !== 'daoliyu' && t !== 'subsonic' && t !== 'jellyfin') {
    return res.status(400).send('<span class="bad">❌ 未知目标</span>')
  }
  config.target = t
  saveConfig(config)
  serverImpl = makeServer()
  logger.info(`[server] 媒体服务器目标切换为 ${t}`)
  res.send(`<span class="ok">✅ 已切换目标：${t === 'navidrome' ? 'Navidrome' : t === 'daoliyu' ? '道理鱼' : t === 'subsonic' ? 'Subsonic' : t === 'jellyfin' ? 'Jellyfin' : 'Emby'}（同步任务将操作该服务器）</span>`)
})

app.use('/api', apiRouter(config, lx, server, engine, scheduler))
app.use('/', pagesRouter(() => config, lx, server))

logger.info(`[auth] 账号认证: ${config.auth.enabled ? `已启用（${config.auth.username}）` : '未启用（设置页可开启）'}`)

app.listen(config.server.port, () => {
  console.log(`[songferry] listening on http://127.0.0.1:${config.server.port}`)
  console.log(`[songferry] config: ${process.env.SONGFERRY_CONFIG || 'data/config.yaml'}`)
})
