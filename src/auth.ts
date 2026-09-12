import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import type { AppConfig } from './config.js'
import { saveConfig } from './config.js'
import { getDb } from './store/db.js'
import { logger } from './core/logger.js'

const COOKIE = 'songhamster_session'
/** 改名前的旧 cookie 名：老会话继续认（用户不必重新登录一次） */
const LEGACY_COOKIES = ['songferry_session']
const SESSION_DAYS = 30

/** scrypt 哈希：salt:hash（不存明文） */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const calc = scryptSync(password, salt, 64)
  const expect = Buffer.from(hash, 'hex')
  return calc.length === expect.length && timingSafeEqual(calc, expect)
}

/** 环境变量注入初始账号（docker 部署用）：SONGHAMSTER_AUTH_USER / SONGHAMSTER_AUTH_PASSWORD */
/** 环境变量读取（新前缀优先，兼容改名前的 SONGFERRY_*） */
function authEnv(name: 'AUTH_USER' | 'AUTH_PASSWORD'): string | undefined {
  return process.env[`SONGHAMSTER_${name}`] ?? process.env[`SONGFERRY_${name}`]
}

export function initAuthFromEnv(cfg: AppConfig): void {
  const user = authEnv('AUTH_USER')
  const pass = authEnv('AUTH_PASSWORD')
  if (user && pass && (!cfg.auth.enabled || !cfg.auth.username || !cfg.auth.passwordHash)) {
    cfg.auth.enabled = true
    cfg.auth.username = user
    cfg.auth.passwordHash = hashPassword(pass)
    saveConfig(cfg)
    logger.info('[auth] 已从环境变量启用账号认证')
  }
}

// ===== 持久会话（SQLite 存储，重启不掉线） =====

export function createSession(user: string): string {
  const token = randomBytes(24).toString('hex')
  const exp = Date.now() + SESSION_DAYS * 86400_000
  getDb().prepare('INSERT OR REPLACE INTO auth_session (token, user, exp) VALUES (?, ?, ?)').run(token, user, exp)
  return token
}

export function destroySession(token: string): void {
  getDb().prepare('DELETE FROM auth_session WHERE token = ?').run(token)
}

export function isSessionValid(token: string | undefined): boolean {
  if (!token) return false
  const row = getDb().prepare('SELECT user, exp FROM auth_session WHERE token = ?').get(token) as
    | { user: string; exp: number }
    | undefined
  if (!row) return false
  if (row.exp < Date.now()) {
    getDb().prepare('DELETE FROM auth_session WHERE token = ?').run(token)
    return false
  }
  return true
}

/** 取请求里的会话 token：新 cookie 名优先，改名前的旧名也认（用户不必重新登录） */
function sessionToken(req: Request): string | undefined {
  const c = (req.cookies ?? {}) as Record<string, string>
  for (const name of [COOKIE, ...LEGACY_COOKIES]) {
    if (c[name]) return c[name]
  }
  return undefined
}

/** 认证中间件：auth 开启时保护所有路由（白名单之外）；关闭时放行 */
export function authRequired(cfg: () => AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!cfg().auth.enabled) return next()
    if (isSessionValid(sessionToken(req))) return next()
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ ok: false, error: '未登录' })
    } else {
      res.redirect('/login')
    }
  }
}

export function currentUser(req: Request): string | null {
  const token = sessionToken(req)
  if (!token) return null
  const row = getDb().prepare('SELECT user, exp FROM auth_session WHERE token = ?').get(token) as
    | { user: string; exp: number }
    | undefined
  return row && row.exp > Date.now() ? row.user : null
}

export const COOKIE_NAME = COOKIE
