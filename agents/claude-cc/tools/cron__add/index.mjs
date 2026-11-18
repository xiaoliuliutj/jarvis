import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readFileSync, writeFileSync } from 'fs'
import { z } from 'zod'
import path from 'path'

const CONFIG_PATH = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'config', 'bridge.json')

const server = new McpServer({ name: 'cron__add', version: '1.0.0' })

server.tool(
  'cron__add',
  '向 config/bridge.json 的 crons 数组中添加一个新的 cron 任务',
  {
    id: z.string().describe('任务唯一 ID，如 "daily-greeting"'),
    enabled: z.boolean().optional().describe('是否启用，默认 true'),
    hour: z.number().int().min(0).max(23).optional().describe('触发小时（0-23），不填为通配'),
    minute: z.number().int().min(0).max(59).optional().describe('触发分钟（0-59），不填为通配'),
    adapterId: z.string().describe('适配器 ID，如 "weixin"'),
    prompt: z.string().describe('触发时执行的 prompt 内容'),
  },
  async ({ id, enabled = true, hour, minute, adapterId, prompt }) => {
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    if (!config.crons) config.crons = []

    if (config.crons.find(c => c.id === id)) {
      return { content: [{ type: 'text', text: `❌ 已存在 id 为 "${id}" 的 cron 任务，请换一个 id 或使用 cron__update 修改。` }] }
    }

    const schedule = {}
    if (hour !== undefined) schedule.hour = hour
    if (minute !== undefined) schedule.minute = minute

    const newCron = { id, enabled, adapterId, prompt }
    if (Object.keys(schedule).length > 0) newCron.schedule = schedule

    config.crons.push(newCron)
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')

    return { content: [{ type: 'text', text: `✅ 已添加 cron 任务 "${id}"。\nschedule: ${hour ?? '*'}:${String(minute ?? '*').padStart(2,'0')}\nadapterId: ${adapterId}\nprompt: ${prompt}` }] }
  }
)

await server.connect(new StdioServerTransport())
