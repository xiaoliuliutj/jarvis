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
  android_location: {
    fresh: z.boolean().optional().describe('是否尝试实时刷新（最多等待约 8 秒），默认 false 只读系统缓存'),
  },
  android_sms: {
    action: z.enum(['list', 'search', 'read']).optional().describe('list=列出最近短信（默认）；search=按号码/关键词搜索；read=读取单条详情'),
    limit: z.number().int().min(1).max(50).optional().describe('数量，默认 10'),
    folder: z.string().optional().describe('list 专用：inbox（默认）/ sent / all'),
    keyword: z.string().optional().describe('search 专用：号码或正文关键词'),
    id: z.number().optional().describe('read 专用：短信 id（从 list/search 结果获取）'),
  },
  android_alarm: {
    action: z.enum([
      'set', 'probe', 'try_component', 'dump_ui', 'inspect_manifest',
      'query_action', 'send_broadcast', 'inspect_permissions', 'resolve_provider',
      'inspect_components', 'permission_info',
    ]).optional()
      .describe('set=新建闹钟（默认）；probe=列出系统时钟入口/包内组件；try_component=用指定组件尝试新建；dump_ui=读取当前时钟窗口视图树；inspect_manifest=解析时钟 APK manifest 字符串池找私有通道；query_action=查询某 action 的注册组件；send_broadcast=向系统时钟发送自定义广播；inspect_permissions=查看时钟自定义权限保护级别；resolve_provider=查询时钟 provider 访问限制；inspect_components=列出所有组件及权限要求；permission_info=查询任意权限保护级别'),
    hour: z.number().int().min(0).max(23).optional().describe('小时（24 小时制，0-23），set/try_component/send_broadcast 必填'),
    minute: z.number().int().min(0).max(59).optional().describe('分钟（0-59），set/try_component/send_broadcast 必填'),
    label: z.string().max(80).optional().describe('闹钟备注，默认「Jarvis 闹钟」'),
    vibrate: z.boolean().optional().describe('是否震动，默认 true'),
    component: z.string().max(200).optional().describe('try_component 专用：包名/Activity 全名，例如 com.coloros.alarmclock/com.coloros.alarmclock.AlarmClock'),
    skipUi: z.boolean().optional().describe('try_component 专用：EXTRA_SKIP_UI 的值，默认 true'),
    skipUiMode: z.enum(['boolean', 'string', 'int']).optional().describe('try_component 专用：SKIP_UI 传值类型，用于排查厂商实现，默认 boolean'),
    intentAction: z.string().max(200).optional().describe('query_action/send_broadcast/try_component 专用：action 字符串'),
    authority: z.string().max(200).optional().describe('resolve_provider 专用：provider authority'),
    permission: z.string().max(200).optional().describe('permission_info 专用：权限名，例如 com.oplus.permission.safe.ASSISTANT'),
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
  && isToolEnabled(principalId, def.id, def.enabledByDefault === true)
))

for (const def of definitions) {
  server.tool(
    def.id,
    `${def.description || def.summary || def.name}\n需要 Android App 0.2.5+ 在线；手机未连接时会直接报错。`,
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
