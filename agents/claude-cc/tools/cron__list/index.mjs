import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readFileSync } from 'fs'
import path from 'path'

const CONFIG_PATH = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'config', 'bridge.json')

const server = new McpServer({ name: 'cron__list', version: '1.0.0' })

server.tool(
  'cron__list',
  '列出 config/bridge.json 中的所有 cron 任务',
  {},
  async () => {
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    const crons = config.crons || []
    if (crons.length === 0) {
      return { content: [{ type: 'text', text: '当前没有任何 cron 任务。' }] }
    }
    const text = crons.map((c, i) => {
      const schedule = c.schedule
        ? `${String(c.schedule.hour ?? '*').padStart(2,'0')}:${String(c.schedule.minute ?? '*').padStart(2,'0')}`
        : '未设置'
      return `[${i+1}] id: ${c.id}\n    enabled: ${c.enabled}\n    schedule: ${schedule}\n    adapterId: ${c.adapterId}\n    prompt: ${c.prompt}`
    }).join('\n\n')
    return { content: [{ type: 'text', text: `共 ${crons.length} 个 cron 任务：\n\n${text}` }] }
  }
)

await server.connect(new StdioServerTransport())
