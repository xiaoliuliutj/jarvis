/**
 * 日程工具。
 *
 * 作用和 cron 不同：
 *   - cron 是周期性执行任务
 *   - schedule 是用户的具体日程，到点前按用户选择的提前量提醒
 *
 * 所有操作都只作用于 JARVIS_PRINCIPAL_ID 自己的 schedules.json。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  addSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
  formatScheduleLine,
  formatDateTime,
  formatAdvance,
} from '../../../core/schedule-store.mjs'
import { syncScheduleMemory } from '../../../core/schedule-memory.mjs'

function syncScheduleMemorySafe() {
  try {
    syncScheduleMemory(principalId)
  } catch {}
}

const principalId = process.env.JARVIS_PRINCIPAL_ID
if (!principalId) throw new Error('缺少 JARVIS_PRINCIPAL_ID')

const server = new McpServer({ name: 'schedule', version: '1.0.0' })

function fail(err) {
  return { isError: true, content: [{ type: 'text', text: `❌ ${err.message}` }] }
}

server.tool(
  'schedule__add',
  '为当前用户添加日程，并设置提前提醒。startAt 用本地时间，例如 2026-11-20 15:00；remindBeforeMinutes 是提前多少分钟，0 表示准时。',
  {
    title: z.string().min(1).describe('日程标题'),
    startAt: z.string().describe('日程时间，本地时间字符串或 ISO 8601，例如 2026-11-20 15:00'),
    remindBeforeMinutes: z.number().int().min(0).max(10080).optional().describe('提前多少分钟提醒，默认 0；1 天 = 1440'),
    notes: z.string().optional().describe('备注'),
    priority: z.enum(['low', 'normal', 'high']).optional().describe('优先级，默认 normal'),
  },
  async ({ title, startAt, remindBeforeMinutes = 0, notes, priority = 'normal' }) => {
    try {
      const item = addSchedule(principalId, { title, startAt, remindBeforeMinutes, notes, priority })
      syncScheduleMemorySafe()
      return {
        content: [{
          type: 'text',
          text: `✅ 已添加日程：${item.title}\n时间：${formatDateTime(item.startAt)}\n提醒：${formatAdvance(item.remindBeforeMinutes)}\nid: ${item.id}`,
        }],
      }
    } catch (err) {
      return fail(err)
    }
  }
)

server.tool(
  'schedule__list',
  '列出当前用户自己的日程。默认只看未完成的未来日程；includePast=true 看历史，includeDone=true 包含已完成，includeCancelled=true 包含已取消。完成状态以日程的 status 字段为准，不要依赖长期记忆。',
  {
    includePast: z.boolean().optional().describe('是否包含已经开始的日程，默认 false'),
    includeDone: z.boolean().optional().describe('是否包含已完成（status=done）的日程，默认 false'),
    includeCancelled: z.boolean().optional().describe('是否包含已取消（status=cancelled）的日程，默认 false'),
  },
  async ({ includePast = false, includeDone = false, includeCancelled = false } = {}) => {
    try {
      const items = listSchedules(principalId, { includePast, includeDone, includeCancelled })
      if (!items.length) return { content: [{ type: 'text', text: '📅 暂无日程' }] }
      return {
        content: [{
          type: 'text',
          text: `📅 你的日程（${items.length}）\n\n${items.map(formatScheduleLine).join('\n\n')}`,
        }],
      }
    } catch (err) {
      return fail(err)
    }
  }
)

server.tool(
  'schedule__update',
  '修改当前用户自己的日程。修改时间或提前提醒后会重新等待提醒。用户说“做完了/完成了”时把 status 设为 done，并可在 outcome 里记一句结果；不要为此写长期记忆。',
  {
    id: z.string().describe('日程 id，先用 schedule__list 查看'),
    title: z.string().optional(),
    startAt: z.string().optional().describe('本地时间字符串或 ISO 8601'),
    remindBeforeMinutes: z.number().int().min(0).max(10080).optional(),
    notes: z.string().optional(),
    status: z.enum(['pending', 'done', 'cancelled']).optional().describe('日程状态；done=已完成，cancelled=已取消，pending=恢复待办'),
    outcome: z.string().max(500).optional().describe('完成结果/简短备注（可选）'),
    priority: z.enum(['low', 'normal', 'high']).optional().describe('优先级，默认 normal'),
  },
  async ({ id, ...updates } = {}) => {
    try {
      const item = updateSchedule(principalId, id, updates)
      syncScheduleMemorySafe()
      return { content: [{ type: 'text', text: `✅ 已更新日程：${item.title}\n${formatScheduleLine(item)}` }] }
    } catch (err) {
      return fail(err)
    }
  }
)

server.tool(
  'schedule__delete',
  '删除当前用户自己的日程。',
  {
    id: z.string().describe('日程 id，先用 schedule__list 查看'),
  },
  async ({ id }) => {
    try {
      const item = deleteSchedule(principalId, id)
      syncScheduleMemorySafe()
      return { content: [{ type: 'text', text: `✅ 已删除日程：${item.title}` }] }
    } catch (err) {
      return fail(err)
    }
  }
)

await server.connect(new StdioServerTransport())
