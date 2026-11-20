/**
 * 修改定时任务。普通用户只能改自己的；main 可以改任意用户。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readCrons, writeCrons } from '../../../core/user-store.mjs'

const callerId = process.env.JARVIS_PRINCIPAL_ID
const role = process.env.JARVIS_ROLE

const server = new McpServer({ name: 'cron__update', version: '2.0.0' })

server.tool(
  'cron__update',
  '修改当前用户已有的定时任务；main 可以指定其他用户。',
  {
    id: z.string().describe('任务 ID'),
    principalId: z.string().optional().describe('仅 main 可用：目标用户'),
    enabled: z.boolean().optional(),
    hour: z.number().int().min(0).max(23).optional(),
    minute: z.number().int().min(0).max(59).optional(),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    idleHours: z.number().min(0.5).optional().describe('切换为空闲触发：用户多少小时无互动后触发'),
    refireHours: z.number().min(1).optional().describe('空闲触发的再次触发间隔（小时）'),
    prompt: z.string().optional(),
  },
  async ({ id, principalId, enabled, hour, minute, dayOfWeek, idleHours, refireHours, prompt }) => {
    const target = principalId || callerId
    if (role !== 'maintainer' && target !== callerId) {
      return { content: [{ type: 'text', text: '❌ 只能修改自己的定时任务。' }] }
    }

    const crons = readCrons(target)
    const cron = crons.find(c => c.id === id)
    if (!cron) return { content: [{ type: 'text', text: `❌ 找不到任务 "${id}"。` }] }

    if (enabled !== undefined) cron.enabled = enabled
    if (prompt !== undefined) cron.prompt = prompt
    if (idleHours !== undefined) {
      cron.schedule = { idleHours, ...(refireHours !== undefined ? { refireHours } : {}) }
    } else if (hour !== undefined || minute !== undefined || dayOfWeek !== undefined) {
      cron.schedule = cron.schedule || {}
      delete cron.schedule.idleHours
      delete cron.schedule.refireHours
      if (hour !== undefined) cron.schedule.hour = hour
      if (minute !== undefined) cron.schedule.minute = minute
      if (dayOfWeek !== undefined) cron.schedule.dayOfWeek = dayOfWeek
    }
    writeCrons(target, crons)

    return { content: [{ type: 'text', text: `✅ 已更新 ${target} 的任务 "${id}"。\n${JSON.stringify(cron, null, 2)}` }] }
  }
)

await server.connect(new StdioServerTransport())
