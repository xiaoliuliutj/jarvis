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
import * as appStore from '../../core/app-store.mjs'
import { listCatalog, getTool as getCatalogTool } from '../../core/tool-catalog.mjs'
import { resolveAnthropicCredentials } from '../../core/config.mjs'

export const id = 'app'

const APP_WEB_DIR = path.join(ROOT, 'app', 'web')
const TOKEN_FILE = path.join(ROOT, 'userdata', 'app-adapter', 'token.txt')
const OWNER_TOKEN_FILE = path.join(ROOT, 'userdata', 'app-adapter', 'owner-token.txt')
const FILES_DIR = path.join(ROOT, 'userdata', 'app-adapter', 'files')
const DEFAULT_PORT = 17779
const MAX_TEXT_CHARS = 20000
const MAX_ATTACHMENTS = 3
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const RATE_LIMIT_PER_MIN = 30
const QUEUE_LIMIT = 50

let server = null
let wss = null
let onMessageCb = null
let accessToken = ''
let cfg = {}
const clients = new Map()      // clientId -> Set<WebSocket>
const deviceClients = new Map() // deviceId -> clientId
const clientDevices = new Map() // clientId -> deviceId
const pending = new Map()      // target key (clientId/device) -> payload[]
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

function sendToClient(clientId, payload) {
  const set = clients.get(clientId)
  if (!set) return false
  let delivered = false
  for (const ws of set) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(payload))
      delivered = true
    }
  }
  return delivered
}

function pushToTarget(target, payload) {
  const key = String(target || '')
  if (!key) return
  if (sendToClient(key, payload)) return

  // target 可能是 clientId（有 device 映射）或 device；优先找该 device 的最新连接
  const deviceId = clientDevices.get(key) || key
  const latestClient = deviceClients.get(deviceId)
  if (latestClient && sendToClient(latestClient, payload)) return

  const queueKey = deviceId || key
  const queue = pending.get(queueKey) || []
  queue.push(payload)
  while (queue.length > QUEUE_LIMIT) queue.shift()
  pending.set(queueKey, queue)
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

function appPrincipalFor(req) {
  const deviceId = getDevice(req)
  const principal = resolvePrincipal({
    sourceType: 'app',
    accountId: 'default',
    externalUserId: deviceId,
  })
  return { deviceId, principal }
}

function effectiveAppPrincipal(principal, owner) {
  if (!owner) return principal
  return {
    ...principal,
    role: 'owner',
    capabilities: { ...principal.capabilities, editJarvisCode: true },
  }
}

async function handleIncomingMessage(req, res) {
  const { deviceId, principal } = appPrincipalFor(req)
  const owner = ownerTokenOk(req)
  if (!checkRate(deviceId)) {
    return res.status(429).json({ ok: false, error: '消息太频繁，稍等一下喵' })
  }

  const text = String(req.body?.text || '').slice(0, MAX_TEXT_CHARS)
  const attachments = []
  const rawAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments.slice(0, MAX_ATTACHMENTS) : []
  for (const item of rawAttachments) {
    const buffer = Buffer.from(String(item?.dataBase64 || ''), 'base64')
    if (!buffer.length) continue
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      return res.status(413).json({ ok: false, error: '单个附件不能超过 20MB' })
    }
    attachments.push({
      kind: item?.kind === 'image' ? 'image' : 'file',
      fileName: sanitizeFileName(item?.fileName),
      buffer,
    })
  }

  const attachmentIds = Array.isArray(req.body?.attachmentIds) ? req.body.attachmentIds.slice(0, MAX_ATTACHMENTS) : []
  for (const id of attachmentIds) {
    const item = appStore.getMedia(principal.id, String(id))
    if (!item || !fs.existsSync(item.filePath)) continue
    const buffer = fs.readFileSync(item.filePath)
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      return res.status(413).json({ ok: false, error: '单个附件不能超过 20MB' })
    }
    attachments.push({
      kind: String(item.mime || '').startsWith('image/') ? 'image' : 'file',
      fileName: sanitizeFileName(item.fileName),
      buffer,
    })
  }

  if (!text && !attachments.length) {
    return res.status(400).json({ ok: false, error: '消息为空' })
  }

  try {
    const replyTo = req.get('X-Client-Id') || null
    onMessageCb?.({
      from: deviceId,
      text,
      attachments,
      replyTo,
      timestamp: new Date().toISOString(),
      owner,
    })
    logInfo('app.message.in', '', { deviceId, textLen: text.length, attachments: attachments.length, owner, replyTo })
    res.json({ ok: true })
  } catch (err) {
    logError('app.message.fail', err.message, { deviceId })
    res.status(500).json({ ok: false, error: '消息入队失败' })
  }
}

function modelTestUrl(baseUrl, provider) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!base) return ''
  if (/anthropic/i.test(provider) || /anthropic/i.test(base)) {
    return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
  }
  return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
}

async function testModelConnection(principalId, model) {
  let apiKey = ''
  let baseUrl = ''
  let provider = model.provider || 'anthropic'
  let authMode = model.authMode || 'both'
  if (model.raw) {
    const raw = appStore.getRawModelConfig(principalId, model.id)
    if (!raw) return { ok: false, error: '原始配置不存在' }
    const creds = resolveAnthropicCredentials(raw, {})
    apiKey = creds.apiKey
    baseUrl = creds.baseUrl
    provider = 'anthropic'
    authMode = creds.authMode
  } else {
    apiKey = appStore.getSecret(principalId, `model:${model.id}`) || ''
    baseUrl = model.baseUrl || ''
    provider = model.provider || 'anthropic'
  }
  if (!apiKey) return { ok: false, error: '还没有配置 API Key' }
  const url = modelTestUrl(baseUrl, provider)
  if (!url) return { ok: false, error: '缺少 baseUrl' }
  const isAnthropic = /anthropic/i.test(provider) || /anthropic/i.test(baseUrl)
  const headers = authMode === 'auth_token'
    ? { 'Authorization': `Bearer ${apiKey}` }
    : authMode === 'api_key'
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : (isAnthropic
        ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Authorization': `Bearer ${apiKey}` }
        : { 'Authorization': `Bearer ${apiKey}` })
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(8000),
    })
    if (resp.ok) return { ok: true, status: resp.status, message: '连接成功' }
    const body = await resp.text().catch(() => '')
    return { ok: false, status: resp.status, error: `连接失败（HTTP ${resp.status}）`, detail: body.slice(0, 200) }
  } catch (err) {
    return { ok: false, error: `连接失败：${err.message}` }
  }
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

  app.post('/api/message', auth, handleIncomingMessage)

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

  // ── v1：App 管理台 ────────────────────────────────────────────────────────

  app.get('/api/v1/me', auth, (req, res) => {
    const { deviceId, principal } = appPrincipalFor(req)
    const owner = ownerTokenOk(req)
    const settings = appStore.readSettings(principal.id)
    res.json({
      ok: true,
      principalId: principal.id,
      displayName: principal.displayName,
      role: owner ? 'owner' : principal.role,
      owner,
      testMode: settings.testMode !== false,
      device: deviceId,
    })
  })

  app.get('/api/v1/session/current', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    const owner = ownerTokenOk(req)
    const session = getCurrentSession(principal.id)
    if (!session) return res.json({ ok: true, session: null, messages: [], owner })
    const messages = readMessages(principal.id, session.sessionId)
      .filter(r => (r.type === 'user' || r.type === 'assistant') && typeof r.text === 'string' && r.text.trim())
      .slice(-120)
      .map(r => ({
        role: r.type === 'user' ? 'user' : 'bot',
        text: r.text,
        ts: r.timestamp || '',
      }))
    res.json({ ok: true, session, messages, owner })
  })

  app.post('/api/v1/session/message', auth, handleIncomingMessage)

  app.post('/api/v1/upload', auth, express.raw({ type: () => true, limit: '60mb' }), (req, res) => {
    const { deviceId, principal } = appPrincipalFor(req)
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ ok: false, error: '文件为空' })
    }
    if (req.body.length > 60 * 1024 * 1024) {
      return res.status(413).json({ ok: false, error: '文件不能超过 60MB' })
    }
    let fileName = 'file'
    try { fileName = decodeURIComponent(req.get('X-File-Name') || 'file') } catch {}
    const mime = req.get('Content-Type') || 'application/octet-stream'
    try {
      const item = appStore.saveMedia(principal.id, { fileName, mime, buffer: req.body })
      res.json({
        ok: true,
        id: item.id,
        fileName: item.fileName,
        mime: item.mime,
        size: item.size,
        url: `/api/v1/media/${item.id}?token=${encodeURIComponent(accessToken)}&device=${encodeURIComponent(deviceId)}`,
      })
    } catch (err) {
      logError('app.upload.fail', err.message, { principalId: principal.id })
      res.status(500).json({ ok: false, error: '上传失败' })
    }
  })

  app.get('/api/v1/media/:id', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    const item = appStore.getMedia(principal.id, String(req.params.id || ''))
    if (!item || !fs.existsSync(item.filePath)) {
      return res.status(404).json({ ok: false, error: '文件不存在' })
    }
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(item.fileName)}`)
    res.type(item.mime)
    res.sendFile(item.filePath)
  })

  app.get('/api/v1/settings', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    res.json({
      ok: true,
      settings: appStore.readSettings(principal.id),
      models: appStore.listModels(principal.id),
      tools: appStore.getAllToolConfigs(principal.id),
    })
  })

  app.put('/api/v1/settings', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    const body = req.body || {}
    const patch = {}
    for (const key of ['displayName', 'testMode', 'notifications', 'appearance']) {
      if (body[key] !== undefined) patch[key] = body[key]
    }
    const settings = appStore.updateSettings(principal.id, patch)
    res.json({ ok: true, settings })
  })

  app.get('/api/v1/settings/models', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    res.json({ ok: true, models: appStore.listModels(principal.id) })
  })

  app.post('/api/v1/settings/models', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    try {
      const model = appStore.upsertModel(principal.id, req.body || {})
      res.json({ ok: true, model })
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message })
    }
  })

  app.put('/api/v1/settings/models/:id', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    try {
      const model = appStore.upsertModel(principal.id, { ...(req.body || {}), id: req.params.id })
      res.json({ ok: true, model })
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message })
    }
  })

  app.delete('/api/v1/settings/models/:id', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    const removed = appStore.deleteModel(principal.id, req.params.id)
    res.json({ ok: removed })
  })

  app.post('/api/v1/settings/models/:id/test', auth, async (req, res) => {
    const { principal } = appPrincipalFor(req)
    const model = appStore.getModel(principal.id, req.params.id)
    if (!model) return res.status(404).json({ ok: false, error: '模型不存在' })
    const result = await testModelConnection(principal.id, model)
    res.json({ ok: result.ok, ...result })
  })

  app.get('/api/v1/tools', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    const owner = ownerTokenOk(req)
    const tools = listCatalog(principal.id, effectiveAppPrincipal(principal, owner), String(req.query.q || ''))
    res.json({ ok: true, tools })
  })

  app.get('/api/v1/tools/:id', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    const owner = ownerTokenOk(req)
    const tool = getCatalogTool(principal.id, effectiveAppPrincipal(principal, owner), req.params.id)
    if (!tool) return res.status(404).json({ ok: false, error: '工具不存在' })
    res.json({ ok: true, tool })
  })

  app.put('/api/v1/tools/:id', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    const owner = ownerTokenOk(req)
    const tool = getCatalogTool(principal.id, effectiveAppPrincipal(principal, owner), req.params.id)
    if (!tool) return res.status(404).json({ ok: false, error: '工具不存在' })
    const body = req.body || {}
    if (body.enabled !== undefined) appStore.setToolEnabled(principal.id, req.params.id, !!body.enabled)
    if (body.config && typeof body.config === 'object') appStore.setToolConfig(principal.id, req.params.id, body.config)
    if (body.secrets && typeof body.secrets === 'object') {
      for (const [key, value] of Object.entries(body.secrets)) {
        if (value) appStore.setToolSecret(principal.id, req.params.id, key, String(value))
      }
    }
    res.json({
      ok: true,
      tool: getCatalogTool(principal.id, effectiveAppPrincipal(principal, owner), req.params.id),
    })
  })

  app.get('/api/v1/usage/summary', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    res.json({ ok: true, summary: appStore.usageSummary(principal.id, { month: req.query.month }) })
  })

  app.get('/api/v1/usage/records', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50))
    res.json({ ok: true, records: appStore.listUsage(principal.id, { month: req.query.month, limit }) })
  })

  app.get('/api/v1/devices', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    res.json({ ok: true, devices: appStore.listDevices(principal.id) })
  })

  app.delete('/api/v1/devices/:clientId', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    res.json({ ok: appStore.removeDevice(principal.id, req.params.clientId) })
  })

  app.use(express.static(APP_WEB_DIR, {
    extensions: ['html'],
    setHeaders: (res, filePath) => {
      if (/\.(html|js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-store')
    },
  }))
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
    const clientId = crypto.randomUUID()
    let set = clients.get(clientId)
    if (!set) { set = new Set(); clients.set(clientId, set) }
    set.add(ws)
    ws.deviceId = deviceId
    ws.clientId = clientId
    deviceClients.set(deviceId, clientId)
    clientDevices.set(clientId, deviceId)

    try {
      const principal = resolvePrincipal({ sourceType: 'app', accountId: 'default', externalUserId: deviceId })
      appStore.recordDevice(principal.id, { clientId, deviceId })
    } catch {}

    ws.send(JSON.stringify({ type: 'hello', clientId, deviceId, owner }))
    for (const key of [clientId, deviceId]) {
      const queue = pending.get(key)
      if (!queue?.length) continue
      for (const payload of queue) {
        if (ws.readyState === 1) ws.send(JSON.stringify(payload))
      }
      pending.delete(key)
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw))
        if (msg?.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }))
      } catch {}
    })

    ws.on('close', () => {
      const bucket = clients.get(clientId)
      if (bucket) {
        bucket.delete(ws)
        if (bucket.size === 0) clients.delete(clientId)
      }
      if (deviceClients.get(deviceId) === clientId) deviceClients.delete(deviceId)
      clientDevices.delete(clientId)
    })

    logInfo('app.ws.connect', '', { deviceId, clientId, owner })
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

/** 该设备/客户端是否有活跃的 WebSocket（用于提醒优先投递到 App） */
export function isOnline(externalUserId) {
  const key = String(externalUserId || '')
  if (!key) return false
  const deviceId = clientDevices.get(key) || key
  const clientId = deviceClients.get(deviceId) || key
  const set = clients.get(clientId)
  return !!set && [...set].some(ws => ws.readyState === 1)
}

export async function send(externalUserId, text, opts = {}) {
  if (!text) return
  pushToTarget(externalUserId, {
    type: 'assistant',
    text: String(text),
    accountId: opts.accountId || 'default',
    timestamp: new Date().toISOString(),
  })
}

async function sendFileLike(externalUserId, filePath, opts = {}) {
  const target = String(externalUserId || '')
  const fileName = opts.fileName || path.basename(filePath)
  if (!fs.existsSync(filePath)) throw new Error('文件不存在')
  const staged = stageFile(filePath, fileName)
  const isImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(fileName)
  const kind = isImage
    ? 'image'
    : (/\.(mp4|webm|mov|m4v)$/i.test(fileName) ? 'video'
      : (/\.(mp3|wav|m4a|ogg|aac)$/i.test(fileName) ? 'audio' : 'file'))
  pushToTarget(target, {
    type: 'file',
    id: staged.id,
    fileName: staged.name,
    kind,
    isImage,
    url: `/api/file/${staged.id}?token=${encodeURIComponent(accessToken)}`,
    timestamp: new Date().toISOString(),
  })
  logInfo('app.file.sent', fileName, { target, bytes: fs.statSync(filePath).size })
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
  deviceClients.clear()
  clientDevices.clear()
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
