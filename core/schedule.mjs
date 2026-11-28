/**
 * 每用户日程提醒。
 *
 * 和 cron 一样：
 *   - 用户日程在 Bridge 进程里轮询
 *   - main 日程在 Electron 进程里轮询
 *   - 只读取自己的 schedules.json，只往自己的账号/窗口投递
 *
 * 提醒窗口：[startAt - remindBefore, startAt + 15 分钟]
 * 超过窗口的错过提醒不再补发，避免重启后刷屏。
 */

import { listPrincipals } from './principals.mjs'
import { readSchedules, markReminderSent } from './schedule-store.mjs'

const TICK_MS = 10_000
const GRACE_MS = 15 * 60 * 1000

/** 提醒窗口：[startAt - remindBefore, startAt + 15 分钟] */
export function isScheduleDue(item, now = Date.now()) {
  if (!item || item.status !== 'pending' || item.reminderSentAt) return false
  const start = new Date(item.startAt).getTime()
  if (Number.isNaN(start)) return false
  const remindAt = start - (item.remindBeforeMinutes || 0) * 60_000
  return now >= remindAt && now <= start + GRACE_MS
}

export function startScheduleManager({
  principalIds = null,
  principalFilter = null,
  deliver,
  enqueue = (_id, fn) => fn(),
  onEvent = () => {},
}) {
  const inFlight = new Set()

  async function tick() {
    const now = Date.now()
    const principals = listPrincipals()
      .filter(p => !principalIds || principalIds.includes(p.id))
      .filter(p => !principalFilter || principalFilter(p))

    for (const principal of principals) {
      let schedules
      try {
        schedules = readSchedules(principal.id)
      } catch (err) {
        console.error(`[schedule] 读取 ${principal.id} 日程失败:`, err.message)
        continue
      }

      for (const item of schedules) {
        if (!isScheduleDue(item, now)) continue

        const key = `${principal.id}:${item.id}`
        if (inFlight.has(key)) continue
        inFlight.add(key)

        onEvent({ type: 'schedule_due', principalId: principal.id, scheduleId: item.id })
        enqueue(principal.id, async () => {
          try {
            await deliver(principal, item)
            markReminderSent(principal.id, item.id)
            onEvent({ type: 'schedule_reminder', principalId: principal.id, schedule: item })
          } catch (err) {
            console.error(`[schedule] ${principal.id}/${item.id} 提醒失败:`, err.message)
            onEvent({ type: 'schedule_error', principalId: principal.id, scheduleId: item.id, error: err.message })
          } finally {
            inFlight.delete(key)
          }
        })
      }
    }
  }

  const timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  console.log('[schedule] 日程提醒已启动')
  return { stop: () => clearInterval(timer) }
}
