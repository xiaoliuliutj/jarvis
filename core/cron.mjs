/**
 * 每用户 cron。
 *
 * - 任务存储在 userdata/<principalId>/crons.json
 * - 任务使用 owner 的 persona/记忆/工作区/权限执行（由 runTask 决定）
 * - 结果由 deliver 发回 owner 自己的账号
 * - main cron 在 Electron 启动；用户 cron 在 Bridge 启动
 */

import { listPrincipals } from './principals.mjs'
import { readCrons } from './user-store.mjs'

export function matchesNow(schedule, now = new Date()) {
  if (!schedule) return false
  if (schedule.hour !== undefined && schedule.hour !== now.getHours()) return false
  if (schedule.minute !== undefined && schedule.minute !== now.getMinutes()) return false
  if (schedule.dayOfWeek !== undefined) {
    const days = Array.isArray(schedule.dayOfWeek) ? schedule.dayOfWeek : [schedule.dayOfWeek]
    if (!days.includes(now.getDay())) return false
  }
  return true
}

/**
 * @param {object} opts
 * @param {string[]|null} opts.principalIds  只处理这些 principal；null = 全部
 * @param {(principal, task) => Promise<object>} opts.runTask
 * @param {(principal, task, result) => Promise<void>} opts.deliver
 * @param {(principalId, fn) => Promise<any>} opts.enqueue
 * @param {(event) => void} opts.onEvent
 */
export function startCronManager({
  principalIds = null,
  principalFilter = null,
  runTask,
  deliver,
  enqueue = (_id, fn) => fn(),
  onEvent = () => {},
}) {
  const fired = new Set()
  let lastMinuteKey = ''

  async function tick() {
    const now = new Date()
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`
    if (minuteKey !== lastMinuteKey) {
      fired.clear()
      lastMinuteKey = minuteKey
    }

    const principals = listPrincipals()
      .filter(p => !principalIds || principalIds.includes(p.id))
      .filter(p => !principalFilter || principalFilter(p))
    for (const principal of principals) {
      for (const task of readCrons(principal.id)) {
        if (!task.enabled) continue
        if (!matchesNow(task.schedule, now)) continue
        const key = `${principal.id}:${task.id}`
        if (fired.has(key)) continue
        fired.add(key)

        onEvent({ type: 'cron_start', principalId: principal.id, taskId: task.id })
        enqueue(principal.id, async () => {
          try {
            const result = await runTask(principal, task)
            await deliver(principal, task, result)
            onEvent({ type: 'cron_done', principalId: principal.id, taskId: task.id })
          } catch (err) {
            console.error(`[cron] ${principal.id}/${task.id} 失败:`, err.message)
            onEvent({ type: 'cron_error', principalId: principal.id, taskId: task.id, error: err.message })
          }
        })
      }
    }
  }

  const timer = setInterval(tick, 10_000)
  console.log('[cron] 每用户定时任务已启动')
  return { stop: () => clearInterval(timer) }
}
