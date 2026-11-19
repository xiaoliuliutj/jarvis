/**
 * 键盘模拟工具。
 *
 * 支持：
 *   - type：输入文本（Unicode 注入，中文可用）
 *   - press：按组合键，如 ctrl+c / ctrl+shift+s / enter / f5 / alt+tab，可重复
 * 可选先聚焦指定窗口，避免输错地方。
 *
 * 共享实现见 ../_shared/win32-input.mjs。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import path from 'path'
import { runInput, parseCombo } from '../_shared/win32-input.mjs'

const MAX_TYPE_LENGTH = 4000

function buildOpt({ action, text, keys, repeat, intervalMs, window: winTitle }) {
  const opt = { kind: 'keyboard', action }
  if (winTitle) opt.window = String(winTitle)

  if (action === 'type') {
    const t = String(text ?? '')
    if (!t) throw new Error('type 操作需要提供 text')
    if (t.length > MAX_TYPE_LENGTH) throw new Error(`单次输入不能超过 ${MAX_TYPE_LENGTH} 字`)
    opt.text = t
    opt.overlayText = 'Jarvis 正在输入文字…'
    return opt
  }

  if (action === 'press') {
    if (!keys) throw new Error('press 操作需要提供 keys，例如 ctrl+c 或 enter')
    opt.vks = parseCombo(keys)
    opt.overlayText = 'Jarvis 正在按键…'
    if (repeat !== undefined) opt.repeat = Number(repeat)
    if (intervalMs !== undefined) opt.intervalMs = Number(intervalMs)
    return opt
  }

  throw new Error('未知的 keyboard 操作')
}

// ── CLI 自测：node index.mjs --cli '{"action":"press","keys":"esc"}' ─────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
if (isMain && process.argv[2] === '--cli') {
  try {
    const opts = JSON.parse(process.argv[3] || '{}')
    const res = await runInput(buildOpt(opts))
    console.log(JSON.stringify(res, null, 2))
  } catch (err) {
    console.error('FAIL:', err.message)
    process.exitCode = 1
  }
  process.exit()
}

// ── MCP ─────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'keyboard_control', version: '1.0.0' })

server.tool(
  'keyboard_control',
  '模拟键盘：type 输入文本（支持中文）；press 按组合键（如 ctrl+c、ctrl+shift+s、enter、f5、alt+tab），支持重复。' +
  '可选先聚焦指定窗口，避免输入到错误位置。' +
  '一次性调用时屏幕右下角会显示提示浮标、按 Esc 中止；连续操作建议先用 input_session start 进入快速会话模式。',
  {
    action: z.enum(['type', 'press']).describe('操作类型'),
    text: z.string().optional().describe('type：要输入的文本（最多 4000 字）'),
    keys: z.string().optional().describe('press：组合键，例如 ctrl+c、ctrl+shift+s、enter、alt+tab、f5'),
    repeat: z.number().int().min(1).max(100).optional().describe('press：重复次数，默认 1'),
    intervalMs: z.number().int().min(0).max(10000).optional().describe('press：每次重复的间隔毫秒数'),
    window: z.string().optional().describe('可选：操作前先把标题匹配的窗口切到前台'),
  },
  async (args) => {
    try {
      const res = runInput(buildOpt(args))
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ ${err.message}` }] }
    }
  }
)

await server.connect(new StdioServerTransport())
