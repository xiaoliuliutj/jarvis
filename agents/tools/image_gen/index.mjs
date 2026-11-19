/**
 * 图像生成工具（当前 provider：智谱 GLM-Image，纯文生图）。
 *
 * 生成结果保存为图片文件；sendToUser=true（默认）时放入发件箱，
 * 回合结束后自动以图片消息发回给用户。
 *
 * 配置：config/credentials.json
 *   { "imagegen": { "default": "zhipu", "zhipu": { "apiKey": "...", "model": "glm-image" } } }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadCredentials } from '../../../core/config.mjs'
import { generateImage, listProviders } from '../../../core/image-providers/index.mjs'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const principalId = process.env.JARVIS_PRINCIPAL_ID || ''

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

function timestamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function sanitizeFileName(name) {
  const base = path.basename(String(name || 'image'))
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return cleaned.slice(0, 80) || 'image'
}

function defaultOutDir(sendToUser) {
  const pid = principalId || 'pc-main'
  return sendToUser
    ? path.join(ROOT, 'userdata', pid, 'files', 'outbox')
    : path.join(ROOT, 'userdata', pid, 'workspace')
}

function validateSize(size) {
  if (!size) return
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(String(size).trim())
  if (!m) throw new Error('size 格式应为 宽x高，例如 1280x1280')
  const w = Number(m[1])
  const h = Number(m[2])
  if (w < 512 || h < 512 || w > 2048 || h > 2048) throw new Error('宽高需在 512-2048 之间')
  if (w % 32 !== 0 || h % 32 !== 0) throw new Error('宽高需为 32 的整数倍（如 1280、1536）')
  if (w * h > 2 ** 22) throw new Error('总像素不能超过 2^22（约 419 万像素）')
}

async function handleGenerate(args) {
  const prompt = String(args.prompt || '').trim()
  if (!prompt) throw new Error('prompt 不能为空')
  if ([...prompt].length > 1000) throw new Error('prompt 最长 1000 字符')

  const creds = loadCredentials()
  const imgCfg = creds.imagegen || {}
  const providerId = args.provider || imgCfg.default || 'zhipu'
  const providerConf = imgCfg[providerId] || {}

  validateSize(args.size)

  const result = await generateImage({
    prompt,
    size: args.size,
    model: args.model,
    providerId,
    config: providerConf,
  })

  const ext = EXT_BY_MIME[result.mimeType] || '.png'
  const dir = args.outDir ? path.resolve(args.outDir) : defaultOutDir(args.sendToUser !== false)
  fs.mkdirSync(dir, { recursive: true })

  const base = sanitizeFileName(args.fileName || `画作_${timestamp()}`)
  const fileName = base.toLowerCase().endsWith(ext) ? base : base + ext
  const outPath = path.join(dir, fileName)
  fs.writeFileSync(outPath, result.buffer)

  return {
    path: outPath,
    sizeBytes: result.buffer.length,
    ...result.meta,
    note: args.sendToUser !== false
      ? '图片已放入发件箱，回合结束后会自动以图片消息发回给用户。'
      : '图片已生成，可用 Read 查看。',
  }
}

// ── CLI 自测：node index.mjs --cli '{"prompt":"..."}' ─────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
if (isMain && process.argv[2] === '--cli') {
  try {
    const args = JSON.parse(process.argv[3] || '{}')
    if (!args.outDir && args.sendToUser === undefined) args.sendToUser = false
    const r = await handleGenerate(args)
    console.log(JSON.stringify(r, null, 2))
  } catch (err) {
    console.error('FAIL:', err.message)
    process.exitCode = 1
  }
  process.exit()
}

// ── MCP ─────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'image_gen', version: '1.0.0' })

server.tool(
  'image_gen',
  'AI 图像生成（文生图）：根据文字描述生成图片，默认生成后自动发回给用户。' +
  '当前 provider：智谱 GLM-Image（约 0.1 元/次，约 20 秒），支持 1:1 / 3:4 / 4:3 / 16:9 等尺寸。' +
  '提示词要具体：主体、动作、场景、风格、配色、构图；需要在图里写文字时，把文字内容放进提示词并说明排版。',
  {
    prompt: z.string().min(1).max(1000).describe('图片描述（越具体越好，可包含画面内的文字内容）'),
    size: z.string().optional().describe('尺寸，如 1280x1280 | 1024x1024 | 1568x1056 | 1056x1568 | 1728x960；自定义需 512-2048 且为 32 的倍数'),
    provider: z.string().optional().describe('可选：provider id（默认按配置；zhipu=智谱 GLM-Image，necodex=NeCodeX 中转）'),
    model: z.string().optional().describe('可选：模型名（zhipu 默认 glm-image；necodex 默认 gpt-image-2.5-flare，可选 gpt-image-2.5-sunburst）'),
    sendToUser: z.boolean().optional().describe('是否自动发回给用户（默认 true）'),
    fileName: z.string().optional().describe('可选：输出文件名'),
    outDir: z.string().optional().describe('可选：输出目录（默认发件箱或工作区）'),
  },
  async (args) => {
    try {
      const result = await handleGenerate(args)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ ${err.message}` }] }
    }
  }
)

server.tool(
  'image_providers',
  '列出可用的图像生成 provider 及其能力（是否支持图生图、可用模型）。',
  {},
  async () => {
    try {
      const creds = loadCredentials()
      const imgCfg = creds.imagegen || {}
      const list = listProviders().map(p => ({
        ...p,
        configured: !!imgCfg[p.id]?.apiKey,
        ...(p.id === imgCfg.default ? { isDefault: true } : {}),
      }))
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ ${err.message}` }] }
    }
  }
)

await server.connect(new StdioServerTransport())
