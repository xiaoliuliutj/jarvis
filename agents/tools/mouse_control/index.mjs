/**
 * 鼠标模拟工具。
 *
 * 支持：position 读取当前位置 / move 移动 / click 点击（可双击）/
 *       scroll 滚轮 / drag 拖拽。
 * 坐标是物理屏幕像素（DPI 感知），与 screenshot 工具一致，可跨多显示器。
 *
 * 共享实现见 ../_shared/win32-input.mjs。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import path from 'path'
import { runInput } from '../_shared/win32-input.mjs'

function buildOpt({ action, x, y, button, double, direction, amount, toX, toY, window: winTitle }) {
  const opt = { kind: 'mouse', action }
  if (winTitle) opt.window = String(winTitle)
  if (x !== undefined) opt.x = Number(x)
  if (y !== undefined) opt.y = Number(y)
  if (button) opt.button = button
  if (double !== undefined) opt.double = !!double
  if (direction) opt.direction = direction
  if (amount !== undefined) opt.amount = Number(amount)
  if (toX !== undefined) opt.toX = Number(toX)
  if (toY !== undefined) opt.toY = Number(toY)

  if ((action === 'move' || action === 'click' || action === 'drag') && (opt.x === undefined || opt.y === undefined) && action !== 'click') {
    throw new Error(`${action} 操作需要提供 x / y 坐标`)
  }
  if (action === 'drag' && (opt.toX === undefined || opt.toY === undefined)) {
    throw new Error('drag 操作需要提供 toX / toY 目标坐标')
  }
  return opt
}

// ── CLI 自测：node index.mjs --cli '{"action":"position"}' ────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
if (isMain && process.argv[2] === '--cli') {
  try {
    const opts = JSON.parse(process.argv[3] || '{"action":"position"}')
    const res = runInput(buildOpt(opts))
    console.log(JSON.stringify(res, null, 2))
  } catch (err) {
    console.error('FAIL:', err.message)
    process.exitCode = 1
  }
  process.exit()
}

// ── MCP ─────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'mouse_control', version: '1.0.0' })

server.tool(
  'mouse_control',
  '模拟鼠标操作：position 读取当前位置、move 移动、click 点击（可双击）、scroll 滚轮、drag 拖拽。' +
  '坐标是物理屏幕像素（可为负，支持多显示器）。可选先聚焦指定窗口。',
  {
    action: z.enum(['position', 'move', 'click', 'scroll', 'drag']).describe('操作类型'),
    x: z.number().optional().describe('move/click/drag：X 坐标'),
    y: z.number().optional().describe('move/click/drag：Y 坐标'),
    button: z.enum(['left', 'right', 'middle']).optional().describe('click/drag：鼠标键，默认 left'),
    double: z.boolean().optional().describe('click：是否双击'),
    direction: z.enum(['up', 'down']).optional().describe('scroll：滚动方向，默认 up'),
    amount: z.number().int().min(1).max(50).optional().describe('scroll：滚动格数，默认 3'),
    toX: z.number().optional().describe('drag：终点 X'),
    toY: z.number().optional().describe('drag：终点 Y'),
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
