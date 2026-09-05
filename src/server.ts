import express from 'express'
import cookieParser from 'cookie-parser'
import path from 'node:path'
import { loadConfig } from './config.js'
import { getDb } from './store/db.js'
import { LxServerAdapter } from './adapters/lxserver.js'
import { EmbyAdapter } from './adapters/emby.js'
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

const lx = new LxServerAdapter(() => config)
const emby = new EmbyAdapter(() => config)
const engine = new SyncEngine(() => config, lx, emby)
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

app.use('/api', apiRouter(config, lx, emby, engine, scheduler))
app.use('/', pagesRouter(() => config, lx, emby))

logger.info(`[auth] 账号认证: ${config.auth.enabled ? `已启用（${config.auth.username}）` : '未启用（设置页可开启）'}`)

app.listen(config.server.port, () => {
  console.log(`[songferry] listening on http://127.0.0.1:${config.server.port}`)
  console.log(`[songferry] config: ${process.env.SONGFERRY_CONFIG || 'data/config.yaml'}`)
})
