/**
 * 通知事件的"词汇表"：**零依赖**，供 config.ts / notify.ts / 页面共用。
 *
 * ⚠️ 单独成文件是为了**断开循环依赖**：config → notify → logger → config 会形成环，
 * 导致 logger 里读 DATA_DIR 时 config 还没初始化完（ReferenceError，实测踩到）。
 * 所以这个文件不许 import 任何项目内的东西。
 */

export type NotifyEvent =
  | 'sync_ok'        // 任务跑完且成功/部分成功
  | 'sync_failed'    // 任务结果为失败
  | 'ingest_failed'  // 下了但媒体库没收录（最需要人工干预）
  | 'unsatisfied'    // 音质链全试过都拿不到
  | 'removed'        // 镜像模式移出（含删文件/归档）
  | 'task_error'     // 程序异常

export const NOTIFY_EVENTS: { key: NotifyEvent; label: string; hint: string; defaultOn: boolean }[] = [
  { key: 'sync_ok', label: '同步完成', hint: '每次任务跑完都发一条（成功/部分成功）', defaultOn: false },
  { key: 'sync_failed', label: '同步失败', hint: '任务整体失败时发', defaultOn: true },
  { key: 'ingest_failed', label: '入库失败', hint: '下载成功但媒体库没收录（要人工处理）', defaultOn: true },
  { key: 'unsatisfied', label: '未满足', hint: '选的音质链全试过都拿不到', defaultOn: true },
  { key: 'removed', label: '移出记录', hint: '镜像模式把歌从歌单/库里移除', defaultOn: false },
  { key: 'task_error', label: '任务异常', hint: '同步过程报错中断', defaultOn: true },
]

export const EVENT_LABEL: Record<NotifyEvent, string> = Object.fromEntries(
  NOTIFY_EVENTS.map((e) => [e.key, e.label]),
) as Record<NotifyEvent, string>
