/**
 * 抽象图生成工具（沙雕表情包风格）。
 *
 * action：
 *   - generate（默认）：根据聊天语境生成一张抽象图，自动存入表情库，默认直接发回给用户
 *   - list：搜索表情库（按语境/文案/标签）
 *   - send：从表情库挑一张发送（按 id 或关键词）
 *
 * 生成的图永久保存在 userdata/<principal>/stickers/，可复用。
 * 图像 provider 走 core/image-providers（默认 NeCodeX gpt-image-2.5-flare）。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import { loadCredentials } from '../../../core/config.mjs'
import { generateImage } from '../../../core/image-providers/index.mjs'
import { saveSticker, listStickers, getSticker } from '../../../core/sticker-library.mjs'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const principalId = process.env.JARVIS_PRINCIPAL_ID || ''

const STYLE_PREFIX = '一张抽象的、沙雕的、适合微信聊天当表情包用的图片。风格要求：夸张滑稽、表情到位、构图简单、背景干净或纯色，像随手做的网络梗图；不需要精致写实。画面内容：'

function timestamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function buildPrompt({ scene, caption, style }) {
  const parts = []
  parts.push((style || STYLE_PREFIX) + (scene || '一只猫在发呆'))
  if (caption) parts.push(`图片中可以叠加醒目的粗体文字：「${caption}」，排版清晰、字要大。`)
  return parts.join(' ')
}

function saveToOutbox(buffer, ext) {
  const pid = principalId || 'pc-main'
  const dir = path.join(ROOT, 'userdata', pid, 'files', 'outbox')
  fs.mkdirSync(dir, { recursive: true })
  const outPath = path.join(dir, `表情_${timestamp()}${ext}`)
  fs.writeFileSync(outPath, buffer)
  return outPath
}

async function doGenerate(args) {
  const scene = String(args.scene || '').trim()
  const caption = String(args.caption || '').trim()
  if (!scene) throw new Error('generate 需要提供 scene（语境/画面描述）')

  const creds = loadCredentials()
  const imgCfg = creds.imagegen || {}
  const providerId = args.provider || imgCfg.default || 'necodex'
  const providerConf = imgCfg[providerId] || {}

  const prompt = buildPrompt({ scene, caption, style: args.style })
  const result = await generateImage({
    prompt,
    size: args.size || '1024x1024',
    model: args.model,
    providerId,
    config: providerConf,
  })

  // 存表情库
  let sticker = null
  if (args.saveToLibrary !== false) {
    sticker = saveSticker(principalId, result.buffer, {
      caption,
      scene,
      prompt,
      tags: args.tags,
      source: 'abstract',
      ext: '.png',
    })
  }

  // 默认直接发回
  let sentPath = null
  if (args.sendToUser !== false) {
    sentPath = saveToOutbox(result.buffer, '.png')
  }

  return {
    libraryId: sticker ? sticker.id : null,
    sent: !!sentPath,
    sentPath,
    provider: result.meta.provider,
    model: result.meta.model,
    prompt,
    note: sentPath
      ? '图片已生成并放入发件箱，回合结束后自动发回给用户。'
      : '图片已生成并入库，可用 send 发送。',
  }
}

function doList(args) {
  const items = listStickers(principalId, { query: args.query, limit: args.limit || 20 })
  return {
    count: items.length,
    items: items.map(e => ({
      id: e.id,
      caption: e.caption,
      scene: e.scene,
      tags: e.tags,
      createdAt: e.createdAt,
    })),
  }
}

function doSend(args) {
  let entry = null
  if (args.id) {
    entry = getSticker(principalId, args.id)
    if (!entry) throw new Error(`表情库中找不到 id=${args.id}`)
  } else {
    const items = listStickers(principalId, { query: args.query, limit: 1 })
    if (!items.length) throw new Error('表情库里没有匹配的图片')
    entry = getSticker(principalId, items[0].id)
  }
  const buffer = fs.readFileSync(entry.path)
  const sentPath = saveToOutbox(buffer, path.extname(entry.file) || '.png')
  return {
    id: entry.id,
    caption: entry.caption,
    scene: entry.scene,
    sentPath,
    note: '已放入发件箱，回合结束后自动发回给用户。',
  }
}

async function handleAction(args) {
  const action = args.action || 'generate'
  if (action === 'generate') return doGenerate(args)
  if (action === 'list') return doList(args)
  if (action === 'send') return doSend(args)
  throw new Error(`未知 action：${action}`)
}

// ── CLI 自测 ────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
if (isMain && process.argv[2] === '--cli') {
  try {
    if (!process.env.JARVIS_PRINCIPAL_ID) process.env.JARVIS_PRINCIPAL_ID = 'pc-main'
    const args = JSON.parse(process.argv[3] || '{}')
    const r = await handleAction(args)
    console.log(JSON.stringify(r, null, 2))
  } catch (err) {
    console.error('FAIL:', err.message)
    process.exitCode = 1
  }
  process.exit()
}

// ── MCP ─────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'abstract_image', version: '1.0.0' })

server.tool(
  'abstract_image',
  '抽象沙雕图（表情包）：generate 按聊天语境生成一张抽象图并默认直接发给用户；list 搜索表情库；send 从表情库挑一张发送。生成过的图会永久入库，闲聊时优先复用。',
  {
    action: z.enum(['generate', 'list', 'send']).optional().describe('操作：generate（默认）/ list / send'),
    scene: z.string().optional().describe('generate：语境/画面描述，例如「打工人瘫在椅子上双眼空洞」'),
    caption: z.string().optional().describe('generate：可选，图片中的叠字（梗文案）'),
    style: z.string().optional().describe('generate：可选，覆盖默认抽象风格描述'),
    tags: z.array(z.string()).optional().describe('generate：可选，标签（便于检索）'),
    size: z.string().optional().describe('generate：尺寸，默认 1024x1024'),
    provider: z.string().optional().describe('generate：可选 provider（默认按配置）'),
    model: z.string().optional().describe('generate：可选模型'),
    saveToLibrary: z.boolean().optional().describe('generate：是否存入表情库（默认 true）'),
    sendToUser: z.boolean().optional().describe('generate：是否直接发给用户（默认 true）'),
    id: z.string().optional().describe('send：表情库条目 id'),
    query: z.string().optional().describe('send/list：关键词（匹配文案/语境/标签）'),
    limit: z.number().int().min(1).max(100).optional().describe('list：返回条数，默认 20'),
  },
  async (args) => {
    try {
      const result = await handleAction(args)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ ${err.message}` }] }
    }
  }
)

await server.connect(new StdioServerTransport())
