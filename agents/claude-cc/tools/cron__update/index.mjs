import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readFileSync, writeFileSync } from 'fs'
import { z } from 'zod'
import path from 'path'

const CONFIG_PATH = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'config', 'bridge.json')

const server = new McpServer({ name: 'cron__update', version: '1.0.0' })

server.tool(
  'cron__update',
  '修改 config/bridge.json 中已有的 cron 任务（按 id 查找，只更新传入的字段）',
  {
    id: z.string().describe('要修改的任务 ID'),
    enabled: z.boolean().optional().describe('是否启用'),
    hour: z.number().int().min(0).max(23).optional().describe('触发小时（0-23）'),
    minute: z.number().int().min(0).max(59).optional().describe('触发分钟（0-59）'),
    adapterId: z.string().optional().describe('适配器 ID'),
    prompt: z.string().optional().describe('触发时执行的 prompt 内容'),
  },
  async ({ id, enabled, hour, minute, adapterId, prompt }) => {
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    if (!config.crons) config.crons = []

    const idx = config.crons.findIndex(c => c.id === id)
    if (idx === -1) {
      return { content: [{ type: 'text', text: `❌ 找不到 id 为 "${id}" 的 cron 任务。` }] }
    }

    const cron = config.crons[idx]
    if (enabled !== undefined) cron.enabled = enabled
    if (adapterId !== undefined) cron.adapterId = adapterId
    if (prompt !== undefined) cron.prompt = prompt
    if (hour !== undefined || minute !== undefined) {
      if (!cron.schedule) cron.schedule = {}
      if (hour !== undefined) cron.schedule.hour = hour
      if (minute !== undefined) cron.schedule.minute = minute
    }

    config.crons[idx] = cron
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')

    return { content: [{ type: 'text', text: `✅ 已更新 cron 任务 "${id}"。\n当前配置：${JSON.stringify(cron, null, 2)}` }] }
  }
)

await server.connect(new StdioServerTransport())
