/**
 * 列出当前用户（或 main 视角下所有用户）的定时任务。
 * 任务存储在 userdata/<principalId>/crons.json。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { listPrincipals } from '../../../core/principals.mjs'
import { readCrons } from '../../../core/user-store.mjs'

const callerId = process.env.JARVIS_PRINCIPAL_ID
const role = process.env.JARVIS_ROLE

const server = new McpServer({ name: 'cron__list', version: '2.0.0' })

function scheduleText(s = {}) {
  const h = s.hour === undefined ? '*' : String(s.hour).padStart(2, '0')
  const m = s.minute === undefined ? '*' : String(s.minute).padStart(2, '0')
  const d = s.dayOfWeek === undefined ? '' : ` 周${s.dayOfWeek}`
  return `${h}:${m}${d}`
}

server.tool(
  'cron__list',
  '列出当前用户自己的定时任务；main 可以列出所有用户的任务。',
  {
    principalId: z.string().optional().describe('仅 main 可用：查看指定用户的任务'),
  },
  async ({ principalId }) => {
    let targets
    if (role === 'maintainer') {
      targets = principalId ? [principalId] : listPrincipals().map(p => p.id)
    } else {
      if (principalId && principalId !== callerId) {
        return { content: [{ type: 'text', text: '❌ 只能查看自己的定时任务。' }] }
      }
      targets = [callerId]
    }

    const blocks = []
    for (const id of targets) {
      const crons = readCrons(id)
      if (!crons.length) continue
      const lines = crons.map(c =>
        `- id: ${c.id} | ${c.enabled ? '启用' : '禁用'} | ${scheduleText(c.schedule)} | ${c.prompt}`
      )
      blocks.push(`### ${id}\n${lines.join('\n')}`)
    }
    if (!blocks.length) return { content: [{ type: 'text', text: '当前没有定时任务。' }] }
    return { content: [{ type: 'text', text: blocks.join('\n\n') }] }
  }
)

await server.connect(new StdioServerTransport())
