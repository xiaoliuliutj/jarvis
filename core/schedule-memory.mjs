/**
 * 日程三区同步（只在上下文压缩时触发）。
 *
 * 三区（同一条日程任一时刻只在一个区）：
 *   1. 活着的日程：userdata/<id>/schedules.json
 *      - 还没归档的日程都在这，跟完成状态无关；定时任务/提醒扫描只读这里
 *   2. 长期记忆「日程」区
 *      - 只放终态日程（已完成 / 已取消，之后不会再变化），最多保留最近 30 条
 *      - 内容随压缩更新，不在日程增删改时即时写入
 *   3. 日程历史：workspace/日程历史.md
 *      - 长期记忆超限后挤出来的完整记录（标题/状态/备注/结果都在）
 *
 * 走法：完成/取消 → 留在日程表 → 压缩时进入长期记忆（并从日程表移出）
 *       → 长期记忆超限 → 最老的移进日程历史（并从长期记忆移出）
 */

import { randomUUID } from 'crypto'
import { readSchedules, writeSchedules } from './schedule-store.mjs'
import { readMemoryEntries, writeMemoryEntries } from './user-store.mjs'
import { appendScheduleHistory } from './schedule-history.mjs'

// 长期记忆「日程」区上限：默认保留最近 30 条终态日程
const MAX_ENTRIES = 30

/** 终态：完成/取消后不会再变化，可以归档进长期记忆 */
function isSettled(item) {
  return item?.status === 'done' || item?.status === 'cancelled'
}

function formatWhen(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso || '')
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
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
  return `${when} ${title}（待办）`
}

function doneTime(schedule) {
  return Date.parse(schedule.doneAt || schedule.startAt) || 0
}

/** 归档到记忆/历史时保留的完整记录（历史表要用） */
function pickData(schedule) {
  return {
    id: schedule.id,
    title: schedule.title,
    notes: schedule.notes || '',
    startAt: schedule.startAt,
    doneAt: schedule.doneAt || null,
    outcome: schedule.outcome || '',
    priority: schedule.priority || 'normal',
    status: schedule.status === 'cancelled' ? 'cancelled' : 'done',
  }
}

/** 本次压缩会归档的终态日程行（供压缩摘要去重，避免摘要里重复罗列）。 */
export function listArchivedScheduleLines(principalId) {
  try {
    return readSchedules(principalId)
      .filter(isSettled)
      .sort((a, b) => doneTime(b) - doneTime(a))
      .map(scheduleMemoryContent)
  } catch {
    return []
  }
}

function hasScheduleRef(entry) {
  return entry.type === 'schedule'
    || (Array.isArray(entry.refs) && entry.refs.some(ref => String(ref).startsWith('schedule:')))
}

/**
 * 压缩时同步日程三区；返回长期记忆里保留的日程条数。
 * 重复执行安全（内容没变不写盘，历史按 id 去重）。
 */
export function syncScheduleMemory(principalId, { now = Date.now() } = {}) {
  let schedules
  try {
    schedules = readSchedules(principalId)
  } catch {
    return 0
  }
  const entries = readMemoryEntries(principalId)
  const scheduleEntries = entries.filter(hasScheduleRef)
  const otherEntries = entries.filter(entry => !hasScheduleRef(entry))

  // 之前已归档进记忆的（对应日程已从日程表移出）
  const archived = scheduleEntries.filter(entry => entry.data && entry.data.id)
  const archivedIds = new Set(archived.map(entry => entry.data.id))

  // 日程表里已终态（完成/取消）、本次要归档的
  const doneFromTable = schedules.filter(item => isSettled(item) && !archivedIds.has(item.id))

  // 合并成归档池，按结束时间从新到旧排
  const pool = [
    ...doneFromTable.map(schedule => ({
      schedule,
      entry: scheduleEntries.find(entry => (entry.refs || []).includes(`schedule:${schedule.id}`)),
    })),
    ...archived.map(entry => ({ schedule: entry.data, entry })),
  ].sort((a, b) => doneTime(b.schedule) - doneTime(a.schedule))

  const keep = pool.slice(0, MAX_ENTRIES)
  const overflow = pool.slice(MAX_ENTRIES)

  // 超出上限的完整记录落进日程历史
  appendScheduleHistory(principalId, overflow.map(item => item.schedule))

  const iso = new Date(now).toISOString()
  const nextScheduleEntries = keep.map(({ schedule, entry }) => ({
    id: entry?.id || randomUUID(),
    type: 'schedule',
    refs: [`schedule:${schedule.id}`],
    content: scheduleMemoryContent(schedule),
    data: pickData(schedule),
    mentions: entry?.mentions || 1,
    lastMentioned: entry?.lastMentioned || iso,
    createdAt: entry?.createdAt || iso,
  }))

  const next = [...otherEntries, ...nextScheduleEntries]
  if (JSON.stringify(next) !== JSON.stringify(entries)) {
    writeMemoryEntries(principalId, next)
  }

  // 终态的（完成/取消）都从日程表移出（已在长期记忆或日程历史），保证三区不重复
  if (schedules.some(isSettled)) {
    writeSchedules(principalId, schedules.filter(item => !isSettled(item)))
  }

  return nextScheduleEntries.length
}
