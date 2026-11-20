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
 * 是否处于安静时段（不打扰）。支持跨午夜，如 { start: 22, end: 8 }。
 */
export function inQuietHours(quiet, date = new Date()) {
  if (!quiet || quiet.start === undefined || quiet.end === undefined) return false
  const h = date.getHours()
  if (quiet.start === quiet.end) return false
  if (quiet.start < quiet.end) return h >= quiet.start && h < quiet.end
  return h >= quiet.start || h < quiet.end
}

/**
 * 空闲触发判断：用户「空闲」超过 idleHours 后触发。
 * - quietHours 安静时段内一律不触发
 * - 触发后需等到 nextFireAt（随机间隔，见 nextIdleFireAt）才允许再次触发
 * - 用户一有互动（lastActivity 更新），判定的空闲时长自动归零
 *
 * @param {object} schedule { idleHours, quietHours? }
 * @param {{now: number, lastActivity: number|null|undefined, nextFireAt?: number}} ctx
 */
export function isIdleDue(schedule, { now, lastActivity, nextFireAt }) {
  if (!schedule || !schedule.idleHours) return false
  if (!lastActivity) return false
  const idleMs = schedule.idleHours * 3600_000
  if (now - lastActivity < idleMs) return false
  if (schedule.quietHours && inQuietHours(schedule.quietHours, new Date(now))) return false
  if (nextFireAt && now < nextFireAt) return false
  return true
}

/**
 * 计算下一次允许触发的时间：在 refireHoursMin ~ refireHoursMax 之间随机。
 * 未配置随机区间时回退 refireHours / idleHours（固定间隔）。
 */
export function nextIdleFireAt(schedule, now = Date.now()) {
  const min = schedule.refireHoursMin ?? schedule.refireHours ?? schedule.idleHours
  const max = schedule.refireHoursMax ?? min
  const hours = min + Math.random() * Math.max(0, max - min)
  return now + hours * 3600_000
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
  const idleNextFire = new Map()
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
            nextFireAt: idleNextFire.get(key),
          })
          if (due) idleNextFire.set(key, nextIdleFireAt(task.schedule, Date.now()))
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
