/**
 * 键鼠控制会话工具。
 *
 * start  → 启动常驻输入守护进程（本机 127.0.0.1:47460），屏幕右下角显示常驻提示浮标，
 *          之后 mouse_control / keyboard_control 的每次操作走快速通道（毫秒级）。
 * stop   → 结束会话，浮标消失。
 * status → 查询是否在会话中。
 *
 * 空闲 3 分钟或用户按 Esc 时自动结束。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import path from 'path'
import { ensureDaemon, stopDaemon, daemonStatus } from '../_shared/win32-input.mjs'

function ok(text) { return { content: [{ type: 'text', text }] } }

async function handleAction(action) {
  if (action === 'start') {
    const r = await ensureDaemon()
    return ok(`✅ 控制会话已开始${r.started ? '（守护进程已启动）' : '（复用已有会话）'}。` +
      '屏幕右下角已显示常驻提示，鼠标/键盘操作现在走快速通道；按 Esc 或调用 stop 结束会话。')
  }
  if (action === 'stop') {
    const r = await stopDaemon()
    return ok(r.stopped ? '✅ 控制会话已结束，提示浮标已隐藏。' : '当前没有运行中的控制会话。')
  }
  const s = await daemonStatus()
  return ok(s.running
    ? `✅ 控制会话运行中（端口 ${s.port}），键鼠操作走快速通道。`
    : '当前没有控制会话，键鼠操作走一次性模式（每次约 1-2 秒）。')
}

// ── CLI 自测：node index.mjs --cli start/stop/status ──────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
if (isMain && process.argv[2] === '--cli') {
  try {
    const r = await handleAction(process.argv[3] || 'status')
    console.log(r.content[0].text)
  } catch (err) {
    console.error('FAIL:', err.message)
    process.exitCode = 1
  }
  process.exit()
}

// ── MCP ─────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'input_session', version: '1.0.0' })

server.tool(
  'input_session',
  '键鼠控制会话：start 进入快速控制模式（屏幕常驻提示浮标，键鼠操作变为毫秒级）；stop 结束；status 查询。' +
  '连续多步操作前建议先 start、完成后 stop；空闲 3 分钟或按 Esc 会自动结束。',
  {
    action: z.enum(['start', 'stop', 'status']).describe('start / stop / status'),
  },
  async ({ action }) => {
    try {
      return await handleAction(action)
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ ${err.message}` }] }
    }
  }
)

await server.connect(new StdioServerTransport())
