/**
 * 抽象图生成工具（沙雕表情包风格）+ 表情库（个人 / 家庭共享）。
 *
 * action：
 *   - generate（默认）：根据聊天语境生成一张抽象图，自动存入个人表情库，默认直接发回给用户。
 *     visibility='public' 时额外写入家庭共享库（会做个人信息过滤，疑似个人信息强制私有）。
 *     生成能力仅主人/主会话可用；家人用户可以用 list / send / unshare。
 *   - list：搜索表情库（scope: mine 默认 / shared / all）
 *   - send：从表情库挑一张发送（scope 同上）
 *   - unshare：从共享库撤回一张（主人/主会话/上传者本人）
 *
 * 家庭共享库位置：userdata/shared-stickers/（所有用户可读）。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import { loadCredentials } from '../../../core/config.mjs'
import { generateImage } from '../../../core/image-providers/index.mjs'
import {
  saveSticker,
  listStickers,
  getSticker,
  saveSharedSticker,
  listSharedStickers,
  getSharedSticker,
  removeSharedSticker,
} from '../../../core/sticker-library.mjs'
import { logInfo, logError } from '../../../core/logger.mjs'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const principalId = process.env.JARVIS_PRINCIPAL_ID || ''
const role = process.env.JARVIS_ROLE || ''

const STYLE_PREFIX = '一张抽象的、沙雕的、适合微信聊天当表情包用的图片。风格要求：夸张滑稽、表情到位、构图简单、背景干净或纯色，像随手做的网络梗图；不需要精致写实。画面内容：'

function timestamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function buildPrompt({ scene, caption, style }) {
  const parts = []
  parts.push((style || STYLE_PREFIX) + (scene || '一只猫在发呆'))
  if (caption) parts.push(`图片中可以叠加醒目的粗体文字：「${caption}」，排版要清晰、字要大。`)
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

function canGenerate() {
  if (principalId === 'pc-main' && !role) return true      // CLI 自测
  return role === 'owner' || role === 'maintainer'
}

async function doGenerate(args) {
  if (!canGenerate()) throw new Error('生成图片仅限主人和主会话使用；你可以用 list / send 复用共享表情库')
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

  // 个人库
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

  // 家庭共享库（仅显式 visibility=public 时）
  let shared = { ok: false, reason: '未要求共享' }
  if (args.visibility === 'public') {
    shared = saveSharedSticker(result.buffer, {
      caption,
      scene,
      tags: args.tags,
      uploadedBy: principalId,
      ext: '.png',
    })
  }

  // 默认直接发回
  let sentPath = null
  if (args.sendToUser !== false) {
    sentPath = saveToOutbox(result.buffer, '.png')
  }

  logInfo('sticker.gen', '', {
    shared: shared.ok,
    visibility: args.visibility || 'private',
    bytes: result.buffer.length,
  })

  return {
    libraryId: sticker ? sticker.id : null,
    shared: shared.ok,
    ...(shared.ok ? { sharedId: shared.entry.id } : {}),
    ...(args.visibility === 'public' && !shared.ok ? { shareBlocked: shared.reason } : {}),
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

function collectEntries(scope, query, limit) {
  const out = []
  if (scope === 'mine' || scope === 'all') {
    for (const e of listStickers(principalId, { query, limit })) out.push({ ...e, scope: 'mine' })
  }
  if (scope === 'shared' || scope === 'all') {
    for (const e of listSharedStickers({ query, limit })) out.push({ ...e, scope: 'shared' })
  }
  return out.slice(0, limit)
}

function doList(args) {
  const scope = args.scope || 'mine'
  const items = collectEntries(scope, args.query, args.limit || 20)
  return {
    count: items.length,
    items: items.map(e => ({
      id: e.id,
      scope: e.scope,
      caption: e.caption,
      scene: e.scene,
      tags: e.tags,
      ...(e.uploadedBy ? { uploadedBy: e.uploadedBy } : {}),
      createdAt: e.createdAt,
    })),
  }
}

function findEntry(scope, { id, query }) {
  const scopes = scope === 'all' ? ['mine', 'shared'] : [scope]
  for (const sc of scopes) {
    if (id) {
      const hit = sc === 'shared' ? getSharedSticker(id) : getSticker(principalId, id)
      if (hit) return { entry: hit, scope: sc }
    } else {
      const list = sc === 'shared' ? listSharedStickers({ query, limit: 1 }) : listStickers(principalId, { query, limit: 1 })
      if (list.length) {
        const hit = sc === 'shared' ? getSharedSticker(list[0].id) : getSticker(principalId, list[0].id)
        if (hit) return { entry: hit, scope: sc }
      }
    }
  }
  return null
}

function doSend(args) {
  const scope = args.scope || 'all'
  const found = findEntry(scope, args)
  if (!found) throw new Error('表情库里没有匹配的图片')
  const buffer = fs.readFileSync(found.entry.path)
  const sentPath = saveToOutbox(buffer, path.extname(found.entry.file) || '.png')
  return {
    id: found.entry.id,
    scope: found.scope,
    caption: found.entry.caption,
    scene: found.entry.scene,
    sentPath,
    note: '已放入发件箱，回合结束后自动发回给用户。',
  }
}

function doUnshare(args) {
  if (!args.id && !args.query) throw new Error('unshare 需要提供 id 或 query')
  let entry = null
  if (args.id) {
    entry = getSharedSticker(args.id)
  } else {
    const list = listSharedStickers({ query: args.query, limit: 1 })
    if (list.length) entry = getSharedSticker(list[0].id)
  }
  if (!entry) throw new Error('共享库中找不到匹配的图片')
  const r = removeSharedSticker(entry.id, principalId, role)
  if (!r.ok) throw new Error(r.reason)
  return { ok: true, id: entry.id, caption: entry.caption, note: '已从家庭共享库撤回' }
}

async function handleAction(args) {
  const action = args.action || 'generate'
  if (action === 'generate') return doGenerate(args)
  if (action === 'list') return doList(args)
  if (action === 'send') return doSend(args)
  if (action === 'unshare') return doUnshare(args)
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

const server = new McpServer({ name: 'abstract_image', version: '1.1.0' })

server.tool(
  'abstract_image',
  '抽象沙雕图（表情包）+ 表情库。' +
  'generate：按聊天语境生成抽象图并默认直接发送（仅主人/主会话）；visibility=public 时额外存入家庭共享库（疑似个人信息的强制私有）。' +
  'list：搜索表情库（scope: mine/shared/all）；send：从库里挑一张发送；unshare：撤回共享库图片。',
  {
    action: z.enum(['generate', 'list', 'send', 'unshare']).optional().describe('操作：generate（默认）/ list / send / unshare'),
    scene: z.string().optional().describe('generate：语境/画面描述'),
    caption: z.string().optional().describe('generate：可选，图片中的叠字（梗文案）'),
    style: z.string().optional().describe('generate：可选，覆盖默认抽象风格描述'),
    tags: z.array(z.string()).optional().describe('generate：可选，标签（便于检索）'),
    visibility: z.enum(['private', 'public']).optional().describe('generate：private（默认，仅自己）或 public（加入家庭共享库）'),
    size: z.string().optional().describe('generate：尺寸，默认 1024x1024'),
    provider: z.string().optional().describe('generate：可选 provider（默认按配置）'),
    model: z.string().optional().describe('generate：可选模型'),
    saveToLibrary: z.boolean().optional().describe('generate：是否存入个人表情库（默认 true）'),
    sendToUser: z.boolean().optional().describe('generate：是否直接发给用户（默认 true）'),
    scope: z.enum(['mine', 'shared', 'all']).optional().describe('list/send：搜索范围，默认 mine（send 默认 all）'),
    id: z.string().optional().describe('send/unshare：表情库条目 id'),
    query: z.string().optional().describe('send/list/unshare：关键词（匹配文案/语境/标签）'),
    limit: z.number().int().min(1).max(100).optional().describe('list：返回条数，默认 20'),
  },
  async (args) => {
    try {
      const result = await handleAction(args)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      logError('sticker.fail', err.message, { action: args.action || 'generate' })
      return { content: [{ type: 'text', text: `❌ ${err.message}` }] }
    }
  }
)

await server.connect(new StdioServerTransport())
