import { createHmac } from 'node:crypto'
import { logger } from './logger.js'
import type { NotifyEvent } from './notify-events.js'
import { NOTIFY_EVENTS } from './notify-events.js'
import { PROCESS_LABELS } from './history-meta.js'

/** 通知里显示"移出方式"用的文案（与历史页共用一份映射） */
export const PROCESS_LABELS_FOR_NOTIFY = PROCESS_LABELS

/**
 * 通知：把同步结果推到外部（飞书 / Bark / Server酱 / 自定义 Webhook）。
 *
 * 设计取舍（参考 MoviePilot，但只取对家庭音乐库有用的部分）：
 *  · 渠道固定这 4 种，每个渠道自己选「订阅哪些事件」—— 想"失败发手机、成功只发群"就靠它
 *  · 只做**单向推送**：没有按钮/回调/登录态管理，全是一条 POST，零额外依赖
 *  · **绝不因为通知失败影响同步**：所有发送都是 try/catch + 超时，失败只记日志
 */

// 事件定义放在零依赖的 notify-events.ts（避免 config → notify → logger → config 成环）
export type { NotifyEvent } from './notify-events.js'
export { NOTIFY_EVENTS, EVENT_LABEL } from './notify-events.js'

export type NotifyChannelType = 'feishu' | 'bark' | 'serverchan' | 'webhook'

export interface NotifyChannelBase {
  enabled: boolean
  /** 订阅哪些事件（空数组 = 什么也不发） */
  events: NotifyEvent[]
}

export interface FeishuChannel extends NotifyChannelBase {
  /** 群机器人 Webhook 完整地址 */
  webhook: string
  /** 可选：签名校验密钥（机器人开了"签名校验"才需要） */
  secret: string
}
export interface BarkChannel extends NotifyChannelBase {
  /** Bark 服务器，默认官方 https://api.day.app */
  server: string
  key: string
}
export interface ServerChanChannel extends NotifyChannelBase {
  sendKey: string
}
export interface WebhookChannel extends NotifyChannelBase {
  url: string
  method: 'POST' | 'GET'
  /** 自定义请求头（JSON 文本，可留空） */
  headers: string
  /** POST 时的 body 模板，可用 {title} {text}；留空用默认 JSON */
  bodyTemplate: string
}

export interface NotifyConfig {
  /** 总开关 */
  enabled: boolean
  channels: {
    feishu: FeishuChannel
    bark: BarkChannel
    serverchan: ServerChanChannel
    webhook: WebhookChannel
  }
}

/** 一次同步要发的消息内容 */
export interface NotifyMessage {
  title: string
  text: string
  /** 这次命中的事件（渠道订阅里有任意一个就发） */
  events: NotifyEvent[]
}

export interface SendResult {
  channel: string
  ok: boolean
  error?: string
}

const TIMEOUT_MS = 8000

/** 带超时的 fetch；通知永远不该拖住同步流程 */
async function post(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ ok: boolean; error?: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? TIMEOUT_MS)
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal })
    const body = await r.text().catch(() => '')
    if (!r.ok) return { ok: false, error: `HTTP ${r.status} ${body.slice(0, 120)}` }
    // 有些服务（Bark/Server酱）用 200 + code 字段表达失败
    try {
      const j = JSON.parse(body) as { code?: number; message?: string; msg?: string }
      if (typeof j.code === 'number' && j.code !== 0 && j.code !== 200) {
        return { ok: false, error: `${j.message ?? j.msg ?? '返回 code=' + j.code}` }
      }
    } catch {
      /* 非 JSON 响应不当失败 */
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

/** 飞书自定义机器人加签：timestamp + "\n" + secret 做 HMAC-SHA256 再 base64 */
function feishuSign(secret: string, timestamp: number): string {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64')
}

function replaceVars(tpl: string, msg: { title: string; text: string }): string {
  return tpl.replace(/\{title\}/g, msg.title).replace(/\{text\}/g, msg.text)
}

/** 发到单个渠道；返回结果（不抛异常） */
export async function sendToChannel(type: NotifyChannelType, cfg: NotifyConfig['channels'], msg: NotifyMessage): Promise<SendResult> {
  const label = CHANNEL_LABEL[type]
  try {
    const ch = cfg[type] as NotifyChannelBase
    if (!ch?.enabled) return { channel: label, ok: false, error: '未启用' }
    if (!ch.events?.length) return { channel: label, ok: false, error: '未订阅任何事件' }
    if (!ch.events.some((e) => msg.events.includes(e))) return { channel: label, ok: false, error: '本次事件未订阅（跳过）' }

    if (type === 'feishu') {
      const c = cfg.feishu
      if (!c.webhook) return { channel: label, ok: false, error: '未填 Webhook 地址' }
      const body: Record<string, unknown> = { msg_type: 'text', content: { text: `${msg.title}\n${msg.text}` } }
      if (c.secret) {
        const ts = Math.floor(Date.now() / 1000)
        body.timestamp = String(ts)
        body.sign = feishuSign(c.secret, ts)
      }
      const r = await post(c.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return { channel: label, ...r }
    }

    if (type === 'bark') {
      const c = cfg.bark
      if (!c.key) return { channel: label, ok: false, error: '未填 Key' }
      const base = (c.server || 'https://api.day.app').replace(/\/+$/, '')
      const r = await post(`${base}/${encodeURIComponent(c.key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: msg.title, body: msg.text, group: '音乐仓鼠' }),
      })
      return { channel: label, ...r }
    }

    if (type === 'serverchan') {
      const c = cfg.serverchan
      if (!c.sendKey) return { channel: label, ok: false, error: '未填 SendKey' }
      const form = new URLSearchParams({ title: msg.title, desp: msg.text })
      const r = await post(`https://sctapi.ftqq.com/${encodeURIComponent(c.sendKey)}.send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      })
      return { channel: label, ...r }
    }

    // 自定义 webhook
    const c = cfg.webhook
    if (!c.url) return { channel: label, ok: false, error: '未填 URL' }
    let headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (c.headers?.trim()) {
      try {
        headers = { ...headers, ...(JSON.parse(c.headers) as Record<string, string>) }
      } catch {
        return { channel: label, ok: false, error: '自定义请求头不是合法 JSON' }
      }
    }
    if (c.method === 'GET') {
      const url = replaceVars(c.url, { title: encodeURIComponent(msg.title), text: encodeURIComponent(msg.text) })
      const r = await post(url, { method: 'GET', headers })
      return { channel: label, ...r }
    }
    const body = c.bodyTemplate?.trim()
      ? replaceVars(c.bodyTemplate, msg)
      : JSON.stringify({ title: msg.title, text: msg.text })
    const r = await post(replaceVars(c.url, { title: encodeURIComponent(msg.title), text: '' }), { method: 'POST', headers, body })
    return { channel: label, ...r }
  } catch (e) {
    return { channel: label, ok: false, error: (e as Error).message }
  }
}

export const CHANNEL_LABEL: Record<NotifyChannelType, string> = {
  feishu: '飞书',
  bark: 'Bark',
  serverchan: 'Server酱',
  webhook: '自定义 Webhook',
}

/** 发一条通知到所有渠道（逐个，失败不影响别的渠道，也绝不影响同步） */
export async function sendNotify(cfg: NotifyConfig | undefined, msg: NotifyMessage): Promise<SendResult[]> {
  if (!cfg?.enabled) return []
  const out: SendResult[] = []
  for (const type of Object.keys(CHANNEL_LABEL) as NotifyChannelType[]) {
    const r = await sendToChannel(type, cfg.channels, msg)
    // "未启用 / 未订阅" 不算错误，不打日志免得刷屏
    if (!r.ok && r.error && !r.error.includes('跳过') && r.error !== '未启用') {
      logger.warn(`[notify] ${r.channel} 发送失败：${r.error}`)
    } else if (r.ok) {
      logger.info(`[notify] 已发送到 ${r.channel}`)
    }
    out.push(r)
  }
  return out
}

/** 渠道配置自检（界面「发送测试」用） */
export async function testChannel(type: NotifyChannelType, cfg: NotifyConfig['channels']): Promise<SendResult> {
  const ch = cfg[type] as NotifyChannelBase
  const probe: NotifyChannelBase = { ...ch, enabled: true, events: NOTIFY_EVENTS.map((e) => e.key) }
  const patched = { ...cfg, [type]: probe } as NotifyConfig['channels']
  return sendToChannel(type, patched, {
    title: '【音乐仓鼠】通知测试',
    text: '如果你看到这条消息，说明这个渠道配置成功了 ✅',
    events: ['sync_ok'],
  })
}

// ===== 消息拼装：一次同步 → 一条通知 =====

export interface SyncNotifyInfo {
  taskName: string
  taskType: string
  trigger: string
  result: string            // success | partial | failed | error
  okCount: number           // 新下载入库
  dupCount: number          // 复用/查重
  dedupCount: number
  skippedCount: number      // diff 跳过
  removedCount: number
  elapsedSec: number
  /** 失败明细（入库失败 / 下载失败 / 未满足分开给，便于分组展示与事件判定） */
  ingestFailed: { name: string; singer?: string; reason?: string }[]
  downloadFailed: { name: string; singer?: string; reason?: string }[]
  unsatisfied: { name: string; singer?: string; reason?: string }[]
  removed: { name: string; singer?: string; note?: string }[]
  /** 任务异常时的错误信息 */
  errorText?: string
}

const TRIGGER_TXT: Record<string, string> = { manual: '手动', cron: '定时', retry: '重试' }
const TYPE_TXT: Record<string, string> = { chart: '榜单', adhoc: '手动下载', playlist: '歌单' }

function fmtDur(sec: number): string {
  if (sec < 60) return `${sec} 秒`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m} 分 ${sec % 60} 秒`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

function detailLines(list: { name: string; singer?: string; reason?: string; note?: string }[], cap = 5): string[] {
  const out = list.slice(0, cap).map((x) => `· ${x.name}${x.singer ? ' / ' + x.singer : ''}${x.reason || x.note ? ' —— ' + (x.reason || x.note) : ''}`)
  if (list.length > cap) out.push(`…另有 ${list.length - cap} 条（详见网页版进度历史）`)
  return out
}

/** 把一次运行的结果拼成通知内容；events 决定哪些渠道会收到 */
export function buildSyncMessage(i: SyncNotifyInfo): NotifyMessage {
  const events: NotifyEvent[] = []
  if (i.errorText) {
    events.push('task_error')
  } else if (i.result === 'failed') {
    events.push('sync_failed')
  } else {
    events.push('sync_ok')
  }
  if (i.ingestFailed.length) events.push('ingest_failed')
  if (i.unsatisfied.length || i.downloadFailed.length) events.push('unsatisfied')
  if (i.removed.length) events.push('removed')

  const resultTxt = i.errorText ? '异常' : i.result === 'success' ? '成功' : i.result === 'partial' ? '部分成功' : '失败'
  const title = `【音乐仓鼠】${i.taskName} · ${TRIGGER_TXT[i.trigger] ?? i.trigger} · ${resultTxt}`

  const lines: string[] = []
  lines.push(`${TYPE_TXT[i.taskType] ?? i.taskType}任务：${i.taskName}（${TRIGGER_TXT[i.trigger] ?? i.trigger}触发）`)
  if (i.errorText) {
    lines.push(`❌ 运行出错：${i.errorText}`)
    return { title, text: lines.join('\n'), events }
  }
  const parts = [`下载 ${i.okCount}`, `复用 ${i.dupCount + i.dedupCount}`, `跳过 ${i.skippedCount}`, `移除 ${i.removedCount}`]
  lines.push(`${parts.join(' · ')} · 耗时 ${fmtDur(i.elapsedSec)}`)

  if (i.ingestFailed.length) {
    lines.push('')
    lines.push(`❌ 入库失败（${i.ingestFailed.length}）—— 下了但媒体库没收录，建议手动处理`)
    lines.push(...detailLines(i.ingestFailed))
  }
  if (i.downloadFailed.length) {
    lines.push('')
    lines.push(`❌ 下载失败（${i.downloadFailed.length}）`)
    lines.push(...detailLines(i.downloadFailed))
  }
  if (i.unsatisfied.length) {
    lines.push('')
    lines.push(`⏭ 未满足（${i.unsatisfied.length}）—— 勾选的音质都拿不到`)
    lines.push(...detailLines(i.unsatisfied))
  }
  if (i.removed.length) {
    lines.push('')
    lines.push(`🗑 移出（${i.removed.length}）`)
    lines.push(...detailLines(i.removed))
  }
  return { title, text: lines.join('\n'), events }
}
