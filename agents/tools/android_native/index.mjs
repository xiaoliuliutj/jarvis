/**
 * Android 原生工具 provider server。
 *
 * 由 core/tool-providers/android-native.mjs 在 Bridge 环境里挂载。
 * 只注册当前用户已在 App 工具页启用的 Android 外接工具。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { isToolEnabled } from '../../../core/app-store.mjs'
import { listExternalToolDefinitions } from '../../../core/external-tools.mjs'

const principalId = process.env.JARVIS_PRINCIPAL_ID
const bridgeUrl = String(process.env.JARVIS_BRIDGE_INTERNAL_URL || '').replace(/\/+$/, '')
const internalToken = process.env.JARVIS_INTERNAL_TOKEN || ''

if (!principalId) throw new Error('缺少 JARVIS_PRINCIPAL_ID')

const server = new McpServer({ name: 'android_native', version: '1.0.0' })

const SCHEMAS = {
  android_notification: {
    title: z.string().max(80).optional().describe('通知标题，默认 Jarvis'),
    body: z.string().min(1).max(500).describe('通知内容'),
  },
}

async function callBridge(tool, args) {
  if (!bridgeUrl || !internalToken) throw new Error('Bridge 内部通道未配置')
  const res = await fetch(`${bridgeUrl}/internal/native-tool`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-jarvis-internal-token': internalToken,
    },
    body: JSON.stringify({ principalId, tool, args, timeoutMs: 15000 }),
    signal: AbortSignal.timeout(20000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) throw new Error(data.error || `手机执行失败（HTTP ${res.status}）`)
  return data
}

const definitions = listExternalToolDefinitions().filter(def => (
  def.provider === 'android-native'
  && def.kind === 'tool'
  && def.available
  && SCHEMAS[def.id]
  && isToolEnabled(principalId, def.id, false)
))

for (const def of definitions) {
  server.tool(
    def.id,
    `${def.description || def.summary || def.name}\n需要 Android App 0.2.4+ 在线；手机未连接时会直接报错。`,
    SCHEMAS[def.id],
    async (args) => {
      try {
        const data = await callBridge(def.id, args)
        return {
          content: [{
            type: 'text',
            text: data.text || `${def.name} 已执行`,
          }],
        }
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `❌ ${err.message}` }],
        }
      }
    }
  )
}

await server.connect(new StdioServerTransport())
