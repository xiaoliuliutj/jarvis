/**
 * 把日程状态同步进长期记忆（作为「日程」概念区）。
 *
 * 设计：
 *   - 一条日程对应一条记忆，ref = `schedule:<id>`，按 ref 更新，绝不重复追加
 *   - 只保留近期/未来的日程：待办保留过去 7 天到未来 45 天；已完成/已取消保留 7 天
 *   - 日程被删除或超出窗口时，对应记忆条目一并移除；更久远的记录只留在 schedules.json
 *   - 只在上下文压缩时同步（日程增删改不即时写入）；内容不变时不写盘
 */

import { randomUUID } from 'crypto'
import { readSchedules } from './schedule-store.mjs'
import { readMemoryEntries, writeMemoryEntries } from './user-store.mjs'

const KEEP_PAST_DAYS = 7
const KEEP_FUTURE_DAYS = 45
const MAX_ENTRIES = 30
const DAY_MS = 24 * 3600 * 1000

function formatWhen(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso || '')
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatAdvance(minutes = 0) {
  const n = Number(minutes) || 0
  if (!n) return ''
  if (n % 1440 === 0) return `${n / 1440}天`
  if (n % 60 === 0) return `${n / 60}小时`
  return `${n}分钟`
}

export function scheduleMemoryContent(schedule) {
  const title = String(schedule.title || '').trim().slice(0, 80)
  const when = formatWhen(schedule.startAt)
  if (schedule.status === 'done') {
    const outcome = String(schedule.outcome || '').trim().slice(0, 120)
    const doneAt = schedule.doneAt ? `，完成于 ${formatWhen(schedule.doneAt)}` : ''
    return `${when} ${title}（已完成${doneAt}${outcome ? `：${outcome}` : ''}）`
  }
  if (schedule.status === 'cancelled') {
    return `${when} ${title}（已取消）`
  }
  const advance = formatAdvance(schedule.remindBeforeMinutes)
  const priority = schedule.priority === 'high' ? '，高优先级' : ''
  return `${when} ${title}（待办${advance ? `，提前${advance}提醒` : ''}${priority}）`
}

function selectRelevant(schedules, now) {
  return schedules
    .filter(item => {
      const start = Date.parse(item.startAt) || 0
      if (item.status === 'pending') {
        return start >= now - KEEP_PAST_DAYS * DAY_MS && start <= now + KEEP_FUTURE_DAYS * DAY_MS
      }
      const ref = Date.parse(item.doneAt || item.startAt) || 0
      return now - ref <= KEEP_PAST_DAYS * DAY_MS
    })
    .sort((a, b) => (Date.parse(a.startAt) || 0) - (Date.parse(b.startAt) || 0))
    .slice(0, MAX_ENTRIES)
}

/** 当前会出现在长期记忆「日程」区的行（不含列表前缀），供压缩摘要去重使用。 */
export function listScheduleMemoryLines(principalId, { now = Date.now() } = {}) {
  try {
    return selectRelevant(readSchedules(principalId), now).map(scheduleMemoryContent)
  } catch {
    return []
  }
}

/** 同步当前用户的日程记忆；返回保留的日程条数。 */
export function syncScheduleMemory(principalId, { now = Date.now() } = {}) {
  let schedules = []
  try {
    schedules = readSchedules(principalId)
  } catch {
    return 0
  }
  const relevant = selectRelevant(schedules, now)
  const wanted = new Map(relevant.map(item => [`schedule:${item.id}`, item]))
  const entries = readMemoryEntries(principalId)
  const next = []
  const seen = new Set()
  let changed = false

  for (const entry of entries) {
    const refs = Array.isArray(entry.refs) ? entry.refs : []
    const ref = refs.find(item => String(item).startsWith('schedule:'))
    if (entry.type === 'schedule' || ref) {
      const schedule = ref ? wanted.get(ref) : null
      if (!schedule || seen.has(ref)) {
        changed = true
        continue
      }
      seen.add(ref)
      const content = scheduleMemoryContent(schedule)
      if (entry.content !== content || entry.type !== 'schedule') {
        next.push({ ...entry, type: 'schedule', refs: [ref], content, lastMentioned: new Date(now).toISOString() })
        changed = true
      } else {
        next.push(entry)
      }
      continue
    }
    next.push(entry)
  }

  for (const [ref, schedule] of wanted) {
    if (seen.has(ref)) continue
    const iso = new Date(now).toISOString()
    next.push({
      id: randomUUID(),
      type: 'schedule',
      refs: [ref],
      content: scheduleMemoryContent(schedule),
      mentions: 1,
      lastMentioned: iso,
      createdAt: iso,
    })
    changed = true
  }

  if (changed) writeMemoryEntries(principalId, next)
  return relevant.length
}
