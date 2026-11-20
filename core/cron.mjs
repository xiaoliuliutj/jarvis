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
  if (schedule.idleHours !== undefined) return false   // 空闲触发任务不走固定时间匹配
  if (schedule.hour !== undefined && schedule.hour !== now.getHours()) return false
  if (schedule.minute !== undefined && schedule.minute !== now.getMinutes()) return false
  if (schedule.dayOfWeek !== undefined) {
    const days = Array.isArray(schedule.dayOfWeek) ? schedule.dayOfWeek : [schedule.dayOfWeek]
    if (!days.includes(now.getDay())) return false
  }
  return true
}

/**
 * 空闲触发判断：用户「空闲」超过 idleHours 后触发。
 * 触发一次后，需再等 refireHours（默认等于 idleHours）才允许下次触发；
 * 用户一有互动（lastActivity 更新），周期重新开始。
 *
 * @param {object} schedule { idleHours, refireHours? }
 * @param {{now: number, lastActivity: number|null|undefined, lastFired: number|undefined}} ctx
 */
export function isIdleDue(schedule, { now, lastActivity, lastFired }) {
  if (!schedule || !schedule.idleHours) return false
  if (!lastActivity) return false
  const idleMs = schedule.idleHours * 3600_000
  if (now - lastActivity < idleMs) return false
  if (!lastFired) return true   // 首次触发：够 idleHours 即可
  const refireMs = (schedule.refireHours ?? schedule.idleHours) * 3600_000
  const anchor = Math.max(lastActivity, lastFired)
  return now - anchor >= refireMs
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
  getLastActivity = () => null,
}) {
  const fired = new Set()
  const lastIdleFired = new Map()
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
        const key = `${principal.id}:${task.id}`

        let due = false
        if (task.schedule?.idleHours) {
          // 空闲触发：多久没见到主人（用户互动）才触发
          due = isIdleDue(task.schedule, {
            now: Date.now(),
            lastActivity: getLastActivity(principal.id),
            lastFired: lastIdleFired.get(key),
          })
          if (due) lastIdleFired.set(key, Date.now())
        } else {
          if (!matchesNow(task.schedule, now)) continue
          if (fired.has(key)) continue
          fired.add(key)
          due = true
        }
        if (!due) continue

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
