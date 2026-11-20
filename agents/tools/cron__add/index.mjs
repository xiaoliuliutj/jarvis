/**
 * 新增定时任务。普通用户只能给自己加；main 可以给任意用户加。
 * 任务在 owner 的 persona/记忆/工作区/权限下执行，结果发回 owner。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { getPrincipal } from '../../../core/principals.mjs'
import { readCrons, writeCrons } from '../../../core/user-store.mjs'

const callerId = process.env.JARVIS_PRINCIPAL_ID
const role = process.env.JARVIS_ROLE

const server = new McpServer({ name: 'cron__add', version: '2.0.0' })

server.tool(
  'cron__add',
  '为当前用户创建一个定时任务。任务会使用该用户的人设和记忆，结果发回该用户。',
  {
    id: z.string().describe('任务唯一 ID，如 "daily-greeting"'),
    enabled: z.boolean().optional().describe('是否启用，默认 true'),
    hour: z.number().int().min(0).max(23).optional().describe('触发小时'),
    minute: z.number().int().min(0).max(59).optional().describe('触发分钟'),
    dayOfWeek: z.number().int().min(0).max(6).optional().describe('0=周日 … 6=周六'),
    idleHours: z.number().min(0.5).optional().describe('空闲触发：用户多少小时没有互动后触发（与 hour/minute 互斥）'),
    refireHours: z.number().min(1).optional().describe('空闲触发后，每隔多少小时允许再次触发（默认同 idleHours）'),
    prompt: z.string().describe('触发时执行的 prompt'),
    principalId: z.string().optional().describe('仅 main 可用：给指定用户创建'),
  },
  async ({ id, enabled = true, hour, minute, dayOfWeek, idleHours, refireHours, prompt, principalId }) => {
    const target = principalId || callerId
    if (role !== 'maintainer' && target !== callerId) {
      return { content: [{ type: 'text', text: '❌ 只能给自己创建定时任务。' }] }
    }
    getPrincipal(target) // 不存在直接报错，暴露问题

    const crons = readCrons(target)
    if (crons.some(c => c.id === id)) {
      return { content: [{ type: 'text', text: `❌ 用户 ${target} 已有 id 为 "${id}" 的任务。` }] }
    }

    const schedule = {}
    if (idleHours !== undefined) {
      schedule.idleHours = idleHours
      if (refireHours !== undefined) schedule.refireHours = refireHours
    } else {
      if (hour !== undefined) schedule.hour = hour
      if (minute !== undefined) schedule.minute = minute
      if (dayOfWeek !== undefined) schedule.dayOfWeek = dayOfWeek
    }

    crons.push({
      id,
      enabled,
      schedule,
      prompt,
      createdAt: new Date().toISOString(),
    })
    writeCrons(target, crons)

    return {
      content: [{
        type: 'text',
        text: `✅ 已为 ${target} 创建任务 "${id}"，${enabled ? '启用' : '禁用'}。`,
      }],
    }
  }
)

await server.connect(new StdioServerTransport())
