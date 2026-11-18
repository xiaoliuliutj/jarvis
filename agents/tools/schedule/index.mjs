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
  },
  async ({ title, startAt, remindBeforeMinutes = 0, notes }) => {
    try {
      const item = addSchedule(principalId, { title, startAt, remindBeforeMinutes, notes })
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
  '列出当前用户自己的日程。默认只看未开始的；includePast=true 可以看到历史日程。',
  {
    includePast: z.boolean().optional().describe('是否包含已经开始的日程，默认 false'),
  },
  async ({ includePast = false } = {}) => {
    try {
      const items = listSchedules(principalId, { includePast })
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
  '修改当前用户自己的日程。修改时间或提前提醒后会重新等待提醒。',
  {
    id: z.string().describe('日程 id，先用 schedule__list 查看'),
    title: z.string().optional(),
    startAt: z.string().optional().describe('本地时间字符串或 ISO 8601'),
    remindBeforeMinutes: z.number().int().min(0).max(10080).optional(),
    notes: z.string().optional(),
  },
  async ({ id, ...updates } = {}) => {
    try {
      const item = updateSchedule(principalId, id, updates)
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
      return { content: [{ type: 'text', text: `✅ 已删除日程：${item.title}` }] }
    } catch (err) {
      return fail(err)
    }
  }
)

await server.connect(new StdioServerTransport())
