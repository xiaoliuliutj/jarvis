/**
 * adapters/app.mjs — Jarvis 手机 App（安卓 Demo）接入层。
 *
 * 设计目标：
 *   - 不依赖微信协议，直接给 App / 移动网页提供 HTTP + WebSocket 通道
 *   - 复用 Bridge 的 principal / ConversationService / 工具链
 *   - 独立端口 + Token 鉴权，不暴露主 Bridge 的 7779/7780
 *
 * 接口（默认 0.0.0.0:17779）：
 *   GET  /                   内置移动端聊天页（PWA，可直接加到桌面）
 *   GET  /health             健康检查（无需鉴权）
 *   POST /api/message        { text, attachments?: [{ fileName, kind, dataBase64 }] }
 *   GET  /api/file/:id       下载 Jarvis 发出的文件（token 走 query）
 *   WS   /ws?token=&device=  接收回复 / 文件 / 通知
 *
 * 鉴权：Authorization: Bearer <token> 或 ?token=<token>
 * Token 首次启动自动生成到 userdata/app-adapter/token.txt。
 *
 * 配置（config/bridge.json → adapters.app）：
 *   { "enabled": true, "accounts": ["default"], "port": 17779,
 *     "host": "0.0.0.0", "token": "可选，覆盖自动生成", "maxBodyMb": 25 }
 */

import fs from 'fs'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import express from 'express'
import { WebSocketServer } from 'ws'
import { ROOT } from '../../core/paths.mjs'
import { logInfo, logWarn, logError } from '../../core/logger.mjs'
import { resolvePrincipal } from '../../core/principals.mjs'
import { getCurrentSession, readMessages } from '../../core/user-store.mjs'

export const id = 'app'

const APP_WEB_DIR = path.join(ROOT, 'app', 'web')
const TOKEN_FILE = path.join(ROOT, 'userdata', 'app-adapter', 'token.txt')
const OWNER_TOKEN_FILE = path.join(ROOT, 'userdata', 'app-adapter', 'owner-token.txt')
const FILES_DIR = path.join(ROOT, 'userdata', 'app-adapter', 'files')
const DEFAULT_PORT = 17779
const MAX_TEXT_CHARS = 20000
const MAX_ATTACHMENTS = 3
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
const RATE_LIMIT_PER_MIN = 30
const QUEUE_LIMIT = 50

let server = null
let wss = null
let onMessageCb = null
let accessToken = ''
let cfg = {}
const clients = new Map()      // deviceId -> Set<WebSocket>
const pending = new Map()      // deviceId -> payload[]
const fileRegistry = new Map() // fileId -> { filePath, fileName }
const rateBuckets = new Map()  // deviceId -> number[]
let keepAliveTimer = null

function readBridgeConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'bridge.json'), 'utf-8'))
  } catch {
    return {}
  }
}

function loadOrCreateToken(config) {
  if (config.token) return String(config.token).trim()
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const saved = fs.readFileSync(TOKEN_FILE, 'utf-8').trim()
      if (saved) return saved
    }
  } catch {}
  const token = crypto.randomBytes(24).toString('hex')
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true })
  fs.writeFileSync(TOKEN_FILE, token + '\n', { encoding: 'utf-8', mode: 0o600 })
  return token
}

function tokenOk(input) {
  const provided = Buffer.from(String(input || ''))
  const expected = Buffer.from(accessToken)
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected)
}

/** owner-token.txt：管理员令牌，匹配时把当前用户按 owner 角色处理；明文不打印。 */
function readOwnerToken() {
  try {
    if (!fs.existsSync(OWNER_TOKEN_FILE)) return ''
    return fs.readFileSync(OWNER_TOKEN_FILE, 'utf-8').trim()
  } catch {
    return ''
  }
}

function ownerTokenFromRequest(req, url = null) {
  const header = typeof req.get === 'function'
    ? req.get('X-Owner-Token')
    : req.headers?.['x-owner-token']
  const query = url
    ? url.searchParams.get('ownerToken')
    : (req.query?.ownerToken || '')
  return String(header || query || '')
}

function ownerTokenOk(req, url = null) {
  const expected = readOwnerToken()
  if (!expected) return false
  const provided = ownerTokenFromRequest(req, url)
  if (!provided) return false
  const a = crypto.createHash('sha256').update(provided).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

function sanitizeDevice(value) {
  const cleaned = String(value || '').replace(/[^\w.-]/g, '').slice(0, 64)
  return cleaned || 'owner'
}

function sanitizeFileName(name) {
  const base = path.basename(String(name || 'file'))
  return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'file'
}

function getDevice(req) {
  return sanitizeDevice(req.get('X-Device-Id') || req.query.device || 'owner')
}

function auth(req, res, next) {
  const header = req.get('Authorization') || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  const provided = bearer || req.query.token || ''
  if (!tokenOk(provided)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' })
  }
  next()
}

function checkRate(deviceId) {
  const now = Date.now()
  const bucket = (rateBuckets.get(deviceId) || []).filter(t => now - t < 60_000)
  if (bucket.length >= RATE_LIMIT_PER_MIN) return false
  bucket.push(now)
  rateBuckets.set(deviceId, bucket)
  return true
}

function pushToDevice(deviceId, payload) {
  const set = clients.get(deviceId)
  let delivered = false
  if (set) {
    for (const ws of set) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(payload))
        delivered = true
      }
    }
  }
  if (!delivered) {
    const queue = pending.get(deviceId) || []
    queue.push(payload)
    while (queue.length > QUEUE_LIMIT) queue.shift()
    pending.set(deviceId, queue)
  }
}

/** 把 outbox 文件复制到 App 暂存区：Bridge 发送后会立刻把原文件移入 sent/ */
function stageFile(sourcePath, fileName) {
  fs.mkdirSync(FILES_DIR, { recursive: true })
  const id = crypto.randomBytes(10).toString('hex')
  const name = sanitizeFileName(fileName || path.basename(sourcePath))
  const target = path.join(FILES_DIR, `${id}_${name}`)
  fs.copyFileSync(sourcePath, target)
  pruneStagedFiles()
  fileRegistry.set(id, { filePath: target, fileName: name })
  return { id, name }
}

function pruneStagedFiles() {
  try {
    if (!fs.existsSync(FILES_DIR)) return
    const cutoff = Date.now() - 7 * 24 * 3600_000
    const maxCount = 100
    const entries = fs.readdirSync(FILES_DIR)
      .map(name => {
        const p = path.join(FILES_DIR, name)
        try {
          const st = fs.statSync(p)
          return st.isFile() ? { p, mtimeMs: st.mtimeMs } : null
        } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
    entries.forEach((entry, index) => {
      const tooOld = entry.mtimeMs < cutoff
      const tooMany = entries.length - index > maxCount
      if (tooOld || tooMany) {
        try { fs.unlinkSync(entry.p) } catch {}
      }
    })
    for (const [fileId, item] of fileRegistry) {
      if (!fs.existsSync(item.filePath)) fileRegistry.delete(fileId)
    }
  } catch {}
}

function buildServer() {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: `${cfg.maxBodyMb || 40}mb` }))

  app.get('/health', (_req, res) => res.json({ ok: true, adapter: 'app' }))

  // 历史消息：与微信共用同一个 principal / 当前会话
  app.get('/api/history', auth, (req, res) => {
    const deviceId = getDevice(req)
    const owner = ownerTokenOk(req)
    try {
      const principal = resolvePrincipal({
        sourceType: 'app',
        accountId: 'default',
        externalUserId: deviceId,
      })
      const session = getCurrentSession(principal.id)
      if (!session) return res.json({ ok: true, messages: [], owner })
      const messages = readMessages(principal.id, session.sessionId)
        .filter(r => (r.type === 'user' || r.type === 'assistant') && typeof r.text === 'string' && r.text.trim())
        .slice(-80)
        .map(r => ({
          role: r.type === 'user' ? 'user' : 'bot',
          text: r.text,
          ts: r.timestamp || '',
        }))
      res.json({ ok: true, messages, owner })
    } catch (err) {
      logError('app.history.fail', err.message, { deviceId })
      res.status(500).json({ ok: false, error: '读取历史消息失败' })
    }
  })

  app.post('/api/message', auth, (req, res) => {
    const deviceId = getDevice(req)
    const owner = ownerTokenOk(req)
    if (!checkRate(deviceId)) {
      return res.status(429).json({ ok: false, error: '消息太频繁，稍等一下喵' })
    }

    const text = String(req.body?.text || '').slice(0, MAX_TEXT_CHARS)
    const rawAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments.slice(0, MAX_ATTACHMENTS) : []
    const attachments = []
    for (const item of rawAttachments) {
      const buffer = Buffer.from(String(item?.dataBase64 || ''), 'base64')
      if (!buffer.length) continue
      if (buffer.length > MAX_ATTACHMENT_BYTES) {
        return res.status(413).json({ ok: false, error: '单个附件不能超过 8MB' })
      }
      attachments.push({
        kind: item?.kind === 'image' ? 'image' : 'file',
        fileName: sanitizeFileName(item?.fileName),
        buffer,
      })
    }

    if (!text && !attachments.length) {
      return res.status(400).json({ ok: false, error: '消息为空' })
    }

    try {
      onMessageCb?.({
        from: deviceId,
        text,
        attachments,
        timestamp: new Date().toISOString(),
        owner,
      })
      logInfo('app.message.in', '', { deviceId, textLen: text.length, attachments: attachments.length, owner })
      res.json({ ok: true })
    } catch (err) {
      logError('app.message.fail', err.message, { deviceId })
      res.status(500).json({ ok: false, error: '消息入队失败' })
    }
  })

  app.get('/api/file/:id', auth, (req, res) => {
    const item = fileRegistry.get(String(req.params.id || ''))
    if (!item) return res.status(404).json({ ok: false, error: '文件不存在或已过期' })
    try {
      if (!fs.existsSync(item.filePath)) return res.status(410).json({ ok: false, error: '文件已清理' })
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(item.fileName)}`)
      res.sendFile(item.filePath)
    } catch (err) {
      logError('app.file.fail', err.message, { fileId: req.params.id })
      res.status(500).json({ ok: false, error: '文件读取失败' })
    }
  })

  app.use(express.static(APP_WEB_DIR, { extensions: ['html'] }))
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'not found' }))

  return http.createServer(app)
}

function setupWs(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' })

  wss.on('connection', (ws, req) => {
    let url
    try { url = new URL(req.url, 'http://localhost') } catch { ws.close(4400, 'bad request'); return }
    if (!tokenOk(url.searchParams.get('token'))) {
      ws.close(4401, 'unauthorized')
      return
    }
    const deviceId = sanitizeDevice(url.searchParams.get('device') || 'owner')
    const owner = ownerTokenOk(req, url)
    let set = clients.get(deviceId)
    if (!set) { set = new Set(); clients.set(deviceId, set) }
    set.add(ws)
    ws.deviceId = deviceId

    ws.send(JSON.stringify({ type: 'hello', deviceId, owner }))
    if (owner) ws.send(JSON.stringify({ type: 'notice', text: 'Owner 权限已启用' }))
    const queue = pending.get(deviceId)
    if (queue?.length) {
      for (const payload of queue) {
        if (ws.readyState === 1) ws.send(JSON.stringify(payload))
      }
      pending.delete(deviceId)
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw))
        if (msg?.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }))
      } catch {}
    })

    ws.on('close', () => {
      const bucket = clients.get(deviceId)
      if (!bucket) return
      bucket.delete(ws)
      if (bucket.size === 0) clients.delete(deviceId)
    })

    logInfo('app.ws.connect', '', { deviceId, owner })
  })

  keepAliveTimer = setInterval(() => {
    for (const set of clients.values()) {
      for (const ws of set) if (ws.readyState === 1) ws.ping()
    }
  }, 25_000)
  keepAliveTimer.unref?.()
}

// ── Adapter 接口 ──────────────────────────────────────────────────────────────

export async function start(onMessage) {
  onMessageCb = onMessage
  if (server) return

  cfg = readBridgeConfig().adapters?.app || {}
  accessToken = loadOrCreateToken(cfg)
  const port = Number(process.env.JARVIS_APP_PORT || cfg.port || DEFAULT_PORT)
  const host = process.env.JARVIS_APP_HOST || cfg.host || '0.0.0.0'

  server = buildServer()
  setupWs(server)

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  console.log(`[app] adapter listening on ${host}:${port}`)
  console.log(`[app] 访问令牌文件: ${TOKEN_FILE}`)
  logInfo('app.adapter.start', '', { host, port })
}

/** 该设备是否有活跃的 WebSocket（用于提醒优先投递到 App） */
export function isOnline(externalUserId) {
  const set = clients.get(sanitizeDevice(externalUserId))
  return !!set && [...set].some(ws => ws.readyState === 1)
}

export async function send(externalUserId, text, opts = {}) {
  if (!text) return
  const deviceId = sanitizeDevice(externalUserId)
  pushToDevice(deviceId, {
    type: 'assistant',
    text: String(text),
    accountId: opts.accountId || 'default',
    timestamp: new Date().toISOString(),
  })
}

async function sendFileLike(externalUserId, filePath, opts = {}) {
  const deviceId = sanitizeDevice(externalUserId)
  const fileName = opts.fileName || path.basename(filePath)
  if (!fs.existsSync(filePath)) throw new Error('文件不存在')
  const staged = stageFile(filePath, fileName)
  const isImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(fileName)
  pushToDevice(deviceId, {
    type: 'file',
    id: staged.id,
    fileName: staged.name,
    isImage,
    url: `/api/file/${staged.id}?token=${encodeURIComponent(accessToken)}`,
    timestamp: new Date().toISOString(),
  })
  logInfo('app.file.sent', fileName, { deviceId, bytes: fs.statSync(filePath).size })
}

export async function sendFile(externalUserId, filePath, opts = {}) {
  return sendFileLike(externalUserId, filePath, opts)
}

export async function sendImage(externalUserId, filePath, opts = {}) {
  return sendFileLike(externalUserId, filePath, opts)
}

export function stop() {
  try { keepAliveTimer && clearInterval(keepAliveTimer) } catch {}
  keepAliveTimer = null
  for (const set of clients.values()) {
    for (const ws of set) { try { ws.close(1001, 'server stopping') } catch {} }
  }
  clients.clear()
  pending.clear()
  try { wss?.close() } catch {}
  wss = null
  try { server?.close() } catch {}
  server = null
  onMessageCb = null
}

// 供测试脚本直接读取当前 token（不对外暴露为 HTTP）
export function _getAccessToken() {
  return accessToken
}
