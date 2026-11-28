/**
 * 日程历史：长期记忆「日程」区超限后的完整记录档案。
 *
 * 文件：userdata/<principalId>/workspace/日程历史.md（Markdown 表格，方便查看/搜索）
 * 每一行由日程 id 标记，重复同步不会写重。
 */

import fs from 'fs'
import path from 'path'
import { workspaceDir, ensureDir } from './paths.mjs'

const HISTORY_NAME = '日程历史.md'
const HEADER = [
  '# 日程历史',
  '',
  '| 日程时间 | 标题 | 状态 | 结束时间 | 结果/备注 |',
  '| --- | --- | --- | --- | --- |',
]

function pad(n) {
  return String(n).padStart(2, '0')
}

function formatWhen(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso || '')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function cleanCell(text) {
  return String(text || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
}

function formatRow(schedule) {
  const title = cleanCell(schedule.title)
  const outcome = cleanCell(schedule.outcome)
  const notes = cleanCell(schedule.notes)
  const cancelled = schedule.status === 'cancelled'
  const detail = [
    !cancelled && outcome ? `结果：${outcome}` : '',
    notes ? `备注：${notes}` : '',
  ].filter(Boolean).join('；')
  const tag = schedule.id ? ` <!-- schedule:${schedule.id} -->` : ''
  const status = cancelled ? '已取消' : '已完成'
  return `| ${formatWhen(schedule.startAt)} | ${title}${tag} | ${status} | ${formatWhen(schedule.doneAt)} | ${detail} |`
}

/**
 * 把超限的已完成日程追加进日程历史（完整记录）。
 * 已存在（按日程 id）的行会跳过，重复调用安全。
 * @returns {number} 实际追加的行数
 */
export function appendScheduleHistory(principalId, schedules = []) {
  const items = (Array.isArray(schedules) ? schedules : [])
    .filter(item => item && item.id && formatWhen(item.startAt))
  if (!items.length) return 0

  const dir = workspaceDir(principalId)
  ensureDir(dir)
  const file = path.join(dir, HISTORY_NAME)
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
  const rows = []
  for (const item of items) {
    const tag = `<!-- schedule:${item.id} -->`
    if (current.includes(tag) || rows.some(row => row.includes(tag))) continue
    rows.push(formatRow(item))
  }
  if (!rows.length) return 0

  const base = current.trim() ? current.replace(/\s+$/, '') : HEADER.join('\n')
  fs.writeFileSync(file, `${base}\n${rows.join('\n')}\n`, 'utf-8')
  return rows.length
}
