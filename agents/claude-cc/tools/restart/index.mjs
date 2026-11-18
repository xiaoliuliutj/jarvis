import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import http from 'http'

const BRIDGE_HTTP = 'http://localhost:7779'

function bridgePost(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(BRIDGE_HTTP + path, { method: 'POST' }, res => {
      let d = ''; res.on('data', c => d += c)
      res.on('end', () => resolve(JSON.parse(d || '{}')))
    })
    req.on('error', reject)
    req.end()
  })
}

const server = new McpServer({ name: 'restart', version: '1.0.0' })

server.tool(
  'restart__renderer',
  '刷新 Electron React 渲染层。适用于修改了 src/ 下的前端文件之后。不影响 agent 会话和 Bridge Server。',
  {},
  async () => {
    try {
      await bridgePost('/reload-renderer')
      return { content: [{ type: 'text', text: '✅ 渲染层刷新指令已发送，Electron 界面正在重新加载。' }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ 失败：${err.message}（Bridge Server 是否在运行？）` }] }
    }
  }
)

server.tool(
  'restart__bridge',
  '重启 Bridge Server（bridge/server.mjs）。适用于修改了 bridge/ 或 core/ 之后。不影响 Electron 主进程。',
  {},
  async () => {
    try {
      await bridgePost('/restart-bridge')
      return { content: [{ type: 'text', text: '✅ Bridge Server 重启指令已发送，将在 500ms 后重启。' }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ 失败：${err.message}（Bridge Server 是否在运行？）` }] }
    }
  }
)

server.tool(
  'restart__electron',
  '请求完整重启 Electron 应用。适用于修改了 electron/、core/ 或 agents/claude-cc/agent.mjs 之后。重启会延迟到当前主会话回合结束、消息落盘后执行；开发模式下由 dev supervisor 保持 Vite 存活。调用后不要再安排长任务。',
  {},
  async () => {
    try {
      await bridgePost('/relaunch-electron')
      return { content: [{ type: 'text', text: '✅ Electron 重启指令已发送，应用正在重启。' }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ 失败：${err.message}（Bridge Server 是否在运行？）` }] }
    }
  }
)

await server.connect(new StdioServerTransport())
