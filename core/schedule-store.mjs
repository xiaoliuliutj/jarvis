/**
 * 每个用户的日程存储。
 *
 * 文件：userdata/<principalId>/schedules.json
 * 结构：
 *   {
 *     id, title, notes,
 *     startAt,              ISO 时间
 *     remindBeforeMinutes,  提前多少分钟提醒（0-10080）
 *     reminderSentAt,       已提醒时间；null 表示待提醒
 *     status, doneAt, outcome, priority,
 *     createdAt, updatedAt
 *   }
 *
 * 这里只放「活着的日程」（提醒扫描只看这里）；已完成的日程在上下文压缩时
 * 由 core/schedule-memory.mjs 移进长期记忆「日程」区（超限再进日程历史）。
 * 日程只属于当前 principal；工具没有跨用户参数。
 */

import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { schedulesFile, ensureDir } from './paths.mjs'
import { ensureUser } from './user-store.mjs'

const MAX_REMIND_MINUTES = 7 * 24 * 60
const STATUSES = new Set(['pending', 'done', 'cancelled'])
const PRIORITIES = new Set(['low', 'normal', 'high'])

/** 兼容旧数据：缺 status 的按 pending；补齐常用标记。 */
function normalizeSchedule(item) {
  return {
    ...item,
    status: STATUSES.has(item.status) ? item.status : 'pending',
    doneAt: item.doneAt || null,
    outcome: typeof item.outcome === 'string' ? item.outcome : '',
    priority: PRIORITIES.has(item.priority) ? item.priority : 'normal',
    source: typeof item.source === 'string' ? item.source : 'manual',
  }
}

function normalizeStatus(value) {
  const status = String(value || '').trim()
  if (!STATUSES.has(status)) throw new Error('status 只能是 pending / done / cancelled')
  return status
}

function normalizePriority(value) {
  if (value === undefined || value === null || value === '') return 'normal'
  const priority = String(value).trim()
  if (!PRIORITIES.has(priority)) throw new Error('priority 只能是 low / normal / high')
  return priority
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

function writeJson(file, value) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8')
}

function parseStartAt(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error('startAt 不是有效时间；请使用 YYYY-MM-DD HH:mm 或 ISO 8601')
  }
  return date.toISOString()
}

function normalizeRemindBefore(value) {
  if (value === undefined || value === null || value === '') return 0
  const minutes = Number(value)
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_REMIND_MINUTES) {
    throw new Error(`提前提醒必须是 0-${MAX_REMIND_MINUTES} 的整数分钟`)
  }
  return minutes
}

function normalizeTitle(value) {
  const title = String(value ?? '').trim()
  if (!title) throw new Error('title 不能为空')
  return title
}

function normalizeNotes(value) {
  return String(value ?? '').trim()
}

export function readSchedules(principalId) {
  ensureUser(principalId)
  return readJson(schedulesFile(principalId), [])
    .map(normalizeSchedule)
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))
}

export function writeSchedules(principalId, schedules) {
  ensureUser(principalId)
  writeJson(schedulesFile(principalId), schedules)
}

export function listSchedules(principalId, {
  includePast = false,
  includeDone = false,
  includeCancelled = false,
} = {}) {
  const now = Date.now()
  return readSchedules(principalId).filter(item => {
    if (item.status === 'done' && !includeDone) return false
    if (item.status === 'cancelled' && !includeCancelled) return false
    if (includePast) return true
    return new Date(item.startAt).getTime() >= now
  })
}

export function addSchedule(principalId, input) {
  const now = new Date().toISOString()
  const schedule = {
    id: randomUUID(),
    title: normalizeTitle(input.title),
    notes: normalizeNotes(input.notes),
    startAt: parseStartAt(input.startAt),
    remindBeforeMinutes: normalizeRemindBefore(input.remindBeforeMinutes),
    reminderSentAt: null,
    // 完成状态先留在日程本身，压缩时再归档进长期记忆
    status: 'pending',
    doneAt: null,
    outcome: '',
    priority: normalizePriority(input.priority),
    source: String(input.source || 'manual').slice(0, 40),
    createdAt: now,
    updatedAt: now,
  }

  const schedules = readSchedules(principalId)
  schedules.push(schedule)
  writeSchedules(principalId, schedules)
  return schedule
}

export function updateSchedule(principalId, id, updates) {
  const schedules = readSchedules(principalId)
  const schedule = schedules.find(item => item.id === id)
  if (!schedule) throw new Error(`找不到日程：${id}`)

  if (updates.title !== undefined) schedule.title = normalizeTitle(updates.title)
  if (updates.notes !== undefined) schedule.notes = normalizeNotes(updates.notes)
  if (updates.startAt !== undefined) {
    schedule.startAt = parseStartAt(updates.startAt)
    schedule.reminderSentAt = null
  }
  if (updates.remindBeforeMinutes !== undefined) {
    schedule.remindBeforeMinutes = normalizeRemindBefore(updates.remindBeforeMinutes)
    schedule.reminderSentAt = null
  }
  if (updates.status !== undefined) {
    const status = normalizeStatus(updates.status)
    schedule.status = status
    schedule.doneAt = status === 'pending' ? null : new Date().toISOString()
  }
  if (updates.outcome !== undefined) schedule.outcome = String(updates.outcome || '').trim().slice(0, 500)
  if (updates.priority !== undefined) schedule.priority = normalizePriority(updates.priority)
  schedule.updatedAt = new Date().toISOString()

  writeSchedules(principalId, schedules)
  return schedule
}

export function deleteSchedule(principalId, id) {
  const schedules = readSchedules(principalId)
  const index = schedules.findIndex(item => item.id === id)
  if (index === -1) throw new Error(`找不到日程：${id}`)
  const [removed] = schedules.splice(index, 1)
  writeSchedules(principalId, schedules)
  return removed
}

export function markReminderSent(principalId, id) {
  const schedules = readSchedules(principalId)
  const schedule = schedules.find(item => item.id === id)
  if (!schedule) return
  schedule.reminderSentAt = new Date().toISOString()
  writeSchedules(principalId, schedules)
}

export function formatDateTime(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function formatAdvance(minutes = 0) {
  if (!minutes) return '准时'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  return [
    days ? `${days}天` : '',
    hours ? `${hours}小时` : '',
    mins ? `${mins}分钟` : '',
  ].filter(Boolean).join('') + '前'
}

export function formatScheduleLine(item, index = 0) {
  const status = item.status === 'done'
    ? `已完成${item.doneAt ? `（${formatDateTime(item.doneAt)}）` : ''}`
    : item.status === 'cancelled'
      ? '已取消'
      : (item.reminderSentAt ? '已提醒' : '待提醒')
  const priority = item.priority && item.priority !== 'normal'
    ? `｜优先级：${item.priority === 'high' ? '高' : '低'}`
    : ''
  const notes = item.notes ? `\n   ${item.notes}` : ''
  const outcome = item.outcome ? `\n   结果：${item.outcome}` : ''
  return `${index + 1}. ${item.title}\n   时间：${formatDateTime(item.startAt)}｜提前：${formatAdvance(item.remindBeforeMinutes)}｜${status}${priority}\n   id: ${item.id}${notes}${outcome}`
}

export function formatScheduleReminder(item) {
  return [
    `⏰ 日程提醒：${item.title}`,
    `时间：${formatDateTime(item.startAt)}`,
    item.notes ? `备注：${item.notes}` : '',
  ].filter(Boolean).join('\n')
}
