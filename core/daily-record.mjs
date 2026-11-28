/**
 * 日常记录：按天的可检索档案。
 *
 * 文件：userdata/<principalId>/workspace/日常记录/YYYY-MM-DD.md
 *
 * 日程完成/取消时立即落盘（不等上下文压缩），长期记忆的「日程」区只留待办。
 * 用户提到过去的事时，按日期读当天文件，或按关键词搜索整个目录。
 */

import fs from 'fs'
import path from 'path'
import { workspaceDir, ensureDir } from './paths.mjs'

function pad(n) {
  return String(n).padStart(2, '0')
}

function dateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function clock(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function resolveDoneAt(schedule) {
  const date = schedule?.doneAt ? new Date(schedule.doneAt) : new Date()
  return Number.isNaN(date.getTime()) ? new Date() : date
}

function formatRecordLine(schedule, at) {
  const title = String(schedule.title || '').trim()
  const verb = schedule.status === 'cancelled' ? '取消' : '完成'
  const outcome = String(schedule.outcome || '').trim()
  const tag = `<!-- schedule:${schedule.id} -->`
  return `- ${clock(at)} ${verb}「${title}」${outcome ? `｜结果：${outcome}` : ''} ${tag}`
}

/**
 * 把日程终态（done / cancelled）写进完成当天的日常记录。
 * 同一日程重复更新时原地替换那一行，不会堆重复条目。
 * @returns {string|null} 写入的文件路径；非终态返回 null
 */
export function recordScheduleEvent(principalId, schedule) {
  if (!schedule || (schedule.status !== 'done' && schedule.status !== 'cancelled')) return null
  const at = resolveDoneAt(schedule)
  const dir = path.join(workspaceDir(principalId), '日常记录')
  ensureDir(dir)
  const file = path.join(dir, `${dateKey(at)}.md`)
  const header = `# ${dateKey(at)} 日常记录`
  const tag = `<!-- schedule:${schedule.id} -->`
  const line = formatRecordLine(schedule, at)

  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
  const lines = current.trim() ? current.trimEnd().split(/\r?\n/) : [header]
  if (!lines[0]?.startsWith('#')) lines.unshift(header)
  const index = lines.findIndex(item => item.includes(tag))
  if (index >= 0) lines[index] = line
  else lines.push(line)

  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf-8')
  return file
}
