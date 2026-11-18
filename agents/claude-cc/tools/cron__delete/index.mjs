import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readFileSync, writeFileSync } from 'fs'
import { z } from 'zod'
import path from 'path'

const CONFIG_PATH = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'config', 'bridge.json')

const server = new McpServer({ name: 'cron__delete', version: '1.0.0' })

server.tool(
  'cron__delete',
  '从 config/bridge.json 的 crons 数组中删除指定的 cron 任务（按 id 查找）',
  {
    id: z.string().describe('要删除的任务 ID'),
  },
  async ({ id }) => {
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    if (!config.crons) config.crons = []

    const idx = config.crons.findIndex(c => c.id === id)
    if (idx === -1) {
      return { content: [{ type: 'text', text: `❌ 找不到 id 为 "${id}" 的 cron 任务，无需删除。` }] }
    }

    const removed = config.crons.splice(idx, 1)[0]
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')

    return { content: [{ type: 'text', text: `✅ 已删除 cron 任务 "${id}"。\n被删除的配置：${JSON.stringify(removed, null, 2)}` }] }
  }
)

await server.connect(new StdioServerTransport())
