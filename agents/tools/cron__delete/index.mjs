/**
 * 删除定时任务。普通用户只能删自己的；main 可以删任意用户。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readCrons, writeCrons } from '../../../core/user-store.mjs'

const callerId = process.env.JARVIS_PRINCIPAL_ID
const role = process.env.JARVIS_ROLE

const server = new McpServer({ name: 'cron__delete', version: '2.0.0' })

server.tool(
  'cron__delete',
  '删除当前用户自己的定时任务；main 可以指定其他用户。',
  {
    id: z.string().describe('任务 ID'),
    principalId: z.string().optional().describe('仅 main 可用：目标用户'),
  },
  async ({ id, principalId }) => {
    const target = principalId || callerId
    if (role !== 'maintainer' && target !== callerId) {
      return { content: [{ type: 'text', text: '❌ 只能删除自己的定时任务。' }] }
    }

    const crons = readCrons(target)
    const idx = crons.findIndex(c => c.id === id)
    if (idx === -1) return { content: [{ type: 'text', text: `❌ 找不到任务 "${id}"。` }] }

    const [removed] = crons.splice(idx, 1)
    writeCrons(target, crons)
    return { content: [{ type: 'text', text: `✅ 已删除 ${target} 的任务 "${id}"。\n${JSON.stringify(removed, null, 2)}` }] }
  }
)

await server.connect(new StdioServerTransport())
