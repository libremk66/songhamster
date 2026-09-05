import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import type { AppConfig } from './config.js'
import { saveConfig } from './config.js'
import { getDb } from './store/db.js'
import { logger } from './core/logger.js'

const COOKIE = 'songferry_session'
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

/** 环境变量注入初始账号（docker 部署用）：SONGFERRY_AUTH_USER / SONGFERRY_AUTH_PASSWORD */
export function initAuthFromEnv(cfg: AppConfig): void {
  const user = process.env.SONGFERRY_AUTH_USER
  const pass = process.env.SONGFERRY_AUTH_PASSWORD
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

/** 认证中间件：auth 开启时保护所有路由（白名单之外）；关闭时放行 */
export function authRequired(cfg: () => AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!cfg().auth.enabled) return next()
    if (isSessionValid((req.cookies as Record<string, string>)?.[COOKIE])) return next()
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ ok: false, error: '未登录' })
    } else {
      res.redirect('/login')
    }
  }
}

export function currentUser(req: Request): string | null {
  const token = (req.cookies as Record<string, string>)?.[COOKIE]
  if (!token) return null
  const row = getDb().prepare('SELECT user, exp FROM auth_session WHERE token = ?').get(token) as
    | { user: string; exp: number }
    | undefined
  return row && row.exp > Date.now() ? row.user : null
}

export const COOKIE_NAME = COOKIE
