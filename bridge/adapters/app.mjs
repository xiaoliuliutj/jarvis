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
 *   POST /api/v1/session/compact  手动压缩当前会话上下文（下一回合换新 Agent 会话）
 *   GET  /api/file/:id       下载 Jarvis 发出的文件（token 走 query）
 *   WS   /ws?token=&device=  接收回复 / 文件 / 通知
 *
 * 鉴权：
 *   - 身份：账号登录后的 user token（Authorization: Bearer 或 ?token=）
 *   - owner 权限：额外的 owner token（X-Owner-Token 或 ?ownerToken=）
 *   - device 只用于消息路由，不参与身份/权限
 *
 * 配置（config/bridge.json → adapters.app）：
 *   { "enabled": true, "accounts": ["default"], "port": 17779,
 *     "host": "0.0.0.0", "maxBodyMb": 25 }
 */

import fs from 'fs'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import express from 'express'
import { WebSocketServer } from 'ws'
import { ROOT } from '../../core/paths.mjs'
import { logInfo, logWarn, logError } from '../../core/logger.mjs'
import { getPrincipal } from '../../core/principals.mjs'
import { getCurrentSession, appendMessage, touchSession, listSessions, readPersona, writePersona } from '../../core/user-store.mjs'
import { PERSONA_PRESETS } from '../../core/persona-presets.mjs'
import * as appStore from '../../core/app-store.mjs'
import * as authStore from '../../core/auth-store.mjs'
import { listCatalog, getTool as getCatalogTool } from '../../core/tool-catalog.mjs'
import { compactSessionNow } from '../../core/conversation.mjs'
import { resolveAnthropicCredentials } from '../../core/config.mjs'
import { verifyOwnerToken } from '../../core/owner-token.mjs'
import { queryOr } from '../../core/query-client.mjs'
import { tailUiMessages, beforeUiMessages, afterUiMessages, uiReadInfo, historyTexts } from '../../core/read-model.mjs'
import { listPendingApprovals, decideApproval } from '../../core/admin-approvals.mjs'

export const id = 'app'

const APP_WEB_DIR = path.join(ROOT, 'app', 'web')
const FILES_DIR = path.join(ROOT, 'userdata', 'app-adapter', 'files')
const DEFAULT_PORT = 17779
const MAX_TEXT_CHARS = 20000
const MAX_PERSONA_CHARS = 20000
const PERSONA_STATUS_STYLES = new Set(['auto', 'cat', 'plain', 'custom'])
const MAX_ATTACHMENTS = 3
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const RATE_LIMIT_PER_MIN = 30
const QUEUE_LIMIT = 50

let server = null
let wss = null
let onMessageCb = null
let cfg = {}
const clients = new Map()      // clientId -> Set<WebSocket>
const deviceClients = new Map() // deviceId -> 最近一个 clientId
const deviceClientSets = new Map() // deviceId -> Set<clientId>（同一设备的多个连接，例如网页 + 后台通知）
const clientDevices = new Map() // clientId -> deviceId
const clientDeviceHistory = new Map() // clientId -> { deviceId, at }（连接关闭后短暂保留，保证迟到的回复能转到后台服务）
const pending = new Map()      // target key (clientId/device) -> payload[]
const fileRegistry = new Map() // fileId -> { filePath, fileName }
const rateBuckets = new Map()  // deviceId -> number[]
const principalClients = new Map() // principalId -> Set<WebSocket>
const runningTurns = new Map()     // principalId -> { state, tool, text, since, pending }
const nativeRequests = new Map()   // requestId -> { principalId, clientId, resolve, timer }
const CLIENT_HISTORY_TTL = 24 * 3600_000
let keepAliveTimer = null

function readBridgeConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'bridge.json'), 'utf-8'))
  } catch {
    return {}
  }
}

/** owner-token.txt：owner 权限的唯一凭证；明文不打印、不写日志。 */
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
  return verifyOwnerToken(ownerTokenFromRequest(req, url))
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

function authenticate(req) {
  const header = req.get('Authorization') || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  const provided = bearer || req.query.token || ''
  const user = authStore.findByToken(provided)
  return user ? { user } : null
}

function auth(req, res, next) {
  const result = authenticate(req)
  if (!result) {
    return res.status(401).json({ ok: false, error: '请先登录' })
  }
  const principal = getPrincipal(result.user.principalId)
  if (!principal) {
    return res.status(403).json({ ok: false, error: '账号未绑定用户主体' })
  }
  req.auth = { ...result, principal }
  next()
}

/** 异步路由兜底：Express 4 不会接管 Promise 拒绝，这里统一转成 500，避免进程崩溃。 */
function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(err => {
      logError('app.route.fail', err.message, { path: req.path })
      if (!res.headersSent) res.status(500).json({ ok: false, error: '服务器错误' })
    })
  }
}

function checkRate(deviceId) {
  const now = Date.now()
  const bucket = (rateBuckets.get(deviceId) || []).filter(t => now - t < 60_000)
  if (bucket.length >= RATE_LIMIT_PER_MIN) return false
  bucket.push(now)
  rateBuckets.set(deviceId, bucket)
  return true
}

function sendToClient(clientId, payload, principalId = '') {
  const set = clients.get(clientId)
  if (!set) return false
  let delivered = false
  for (const ws of set) {
    if (ws.readyState !== 1) continue
    if (principalId && ws.principalId !== principalId) continue
    try { ws.send(JSON.stringify(payload)); delivered = true } catch {}
  }
  return delivered
}

function sendToDevice(deviceId, payload, principalId = '') {
  const set = deviceClientSets.get(deviceId)
  if (!set || !set.size) return false
  const interactive = !!(payload && ['assistant', 'file', 'notice', 'error'].includes(payload.type))
  let delivered = false
  let latestWeb = null
  let latestNative = null

  for (const clientId of [...set]) {
    const bucket = clients.get(clientId)
    if (!bucket) continue
    for (const ws of bucket) {
      if (ws.readyState !== 1) continue
      // 设备 ID 只用于路由；跨账号即使伪造了同一个 deviceId 也收不到别人的消息。
      if (principalId && ws.principalId !== principalId) continue
      if (!interactive) {
        // 非消息类事件保持广播（例如状态/调试事件）。
        try { ws.send(JSON.stringify(payload)); delivered = true } catch {}
        continue
      }
      // 聊天消息只发一份给「最新的网页连接」和「最新的原生服务连接」，
      // 避免同一设备的历史残留连接各收一份，导致同一条回复显示多次。
      const target = ws.isNative ? latestNative : latestWeb
      if (!target || (ws.connectedAt || 0) > (target.connectedAt || 0)) {
        if (ws.isNative) latestNative = ws
        else latestWeb = ws
      }
    }
  }

  for (const ws of [latestWeb, latestNative]) {
    if (!ws) continue
    try { ws.send(JSON.stringify(payload)); delivered = true } catch {}
  }

  if (delivered && interactive) {
    logInfo('app.ws.deliver', '', {
      deviceId,
      principalId: principalId || null,
      connections: set.size,
      web: !!latestWeb,
      native: !!latestNative,
      type: payload.type,
    })
  }
  return delivered
}

function pruneClientHistory() {
  if (clientDeviceHistory.size < 500) return
  const cutoff = Date.now() - CLIENT_HISTORY_TTL
  for (const [clientId, item] of clientDeviceHistory) {
    if (!item || item.at < cutoff) clientDeviceHistory.delete(clientId)
  }
}

function pushToTarget(target, payload, principalId = '') {
  const key = String(target || '')
  if (!key) return
  const pid = String(principalId || payload?.principalId || '')
  const history = clientDeviceHistory.get(key)
  const deviceId = clientDevices.get(key)
    || (history && history.deviceId)
    || (deviceClientSets.has(key) ? key : '')

  // 同一个设备可能有多个连接：网页前台 + 原生后台通知服务。
  // 回复只发一份给该设备的所有连接，网页负责展示，后台服务按前后台状态决定是否通知。
  if (deviceId && sendToDevice(deviceId, payload, pid)) return
  if (!deviceId && sendToClient(key, payload, pid)) return

  // 队列按 principal 隔离，避免不同账号共用/伪造设备 ID 时串消息。
  const queueKey = pid ? `${pid}:${deviceId || key}` : (deviceId || key)
  const queue = pending.get(queueKey) || []
  queue.push(payload)
  while (queue.length > QUEUE_LIMIT) queue.shift()
  pending.set(queueKey, queue)
}

/**
 * 向某用户的手机推送「管理员授权请求」。
 * 广播到该用户所有在线连接（多连接无妨，客户端按 approval.id 去重）；
 * 同时发一条 notice，让手机通知服务弹出系统通知。返回是否有连接收到。
 */
export function pushApprovalRequest(principalId, approval) {
  const pset = principalClients.get(String(principalId || ''))
  if (!pset || !pset.size) return false
  const summary = String(approval?.summary || '').slice(0, 120)
  const payloads = [
    { type: 'approval_request', approval },
    { type: 'notice', text: `🔐 Jarvis 请求管理员权限：${summary}` },
  ]
  let delivered = false
  for (const ws of pset) {
    if (ws.readyState !== 1) continue
    for (const payload of payloads) {
      try { ws.send(JSON.stringify(payload)); delivered = true } catch {}
    }
  }
  if (delivered) {
    logInfo('app.approval.request', '', { principalId: principalId || null, approvalId: approval?.id })
  }
  return delivered
}

/** 找到该 principal 最新的指定类型连接：优先原生服务，再网页。 */
function latestClientFor(principalId, native) {
  const pid = String(principalId || '')
  let best = null
  for (const [clientId, bucket] of clients) {
    for (const ws of bucket) {
      if (ws.readyState !== 1) continue
      if (ws.principalId !== pid) continue
      if (!!ws.isNative !== !!native) continue
      const connectedAt = ws.connectedAt || 0
      if (!best || connectedAt > best.connectedAt) {
        best = {
          clientId,
          deviceId: ws.deviceId,
          connectedAt,
          native: !!ws.isNative,
          userAgent: ws.userAgent || '',
        }
      }
    }
  }
  return best
}

function nativeClientSupportsTools(userAgent) {
  const match = /JarvisAndroid\/(\d+(?:\.\d+)*)/i.exec(String(userAgent || ''))
  if (!match) return false
  const parts = match[1].split('.').map(Number)
  const score = (parts[0] || 0) * 10_000 + (parts[1] || 0) * 100 + (parts[2] || 0)
  return score >= 204 // 0.2.4+
}

/**
 * 向手机发起一个原生工具调用，并等待 native_tool_result。
 * 优先 NotifyService 后台连接（0.2.4+），其次网页连接。
 */
export function callNativeTool(principalId, tool, args = {}, opts = {}) {
  const pid = String(principalId || '')
  const name = String(tool || '')
  if (!pid || !name) return Promise.resolve({ ok: false, error: '缺少原生工具参数' })

  const native = latestClientFor(pid, true)
  const web = latestClientFor(pid, false)
  const nativeTarget = (native && nativeClientSupportsTools(native.userAgent)) ? native : null
  // 闹钟需要拉起系统时钟界面，优先用前台网页连接；后台通知服务在系统限制下不一定能启动 Activity。
  const preferWeb = name === 'android_alarm'
  const target = preferWeb ? (web || nativeTarget) : (nativeTarget || web)
  if (!target) {
    if (native) return Promise.resolve({ ok: false, error: '请更新 Android App 到 0.2.5 后再使用手机原生工具' })
    return Promise.resolve({ ok: false, error: '手机未连接，请打开 App 或通知服务' })
  }

  const requestId = crypto.randomUUID()
  const timeoutMs = Math.min(30_000, Math.max(1_000, Number(opts.timeoutMs) || 15_000))
  const payload = { type: 'native_tool_call', requestId, tool: name, args }
  if (!sendToClient(target.clientId, payload, pid)) {
    return Promise.resolve({ ok: false, error: '手机连接已断开' })
  }

  logInfo('app.native_tool.call', '', {
    principalId: pid,
    tool: name,
    requestId,
    deviceId: target.deviceId,
    via: target.native ? 'service' : 'web',
  })

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      nativeRequests.delete(requestId)
      logWarn('app.native_tool.timeout', '', { principalId: pid, tool: name, requestId })
      resolve({ ok: false, error: '手机执行超时' })
    }, timeoutMs)
    nativeRequests.set(requestId, {
      principalId: pid,
      clientId: target.clientId,
      resolve,
      timer,
    })
  })
}

function handleNativeToolResult(ws, msg = {}) {
  const requestId = String(msg.requestId || '')
  if (!requestId) return
  const pending = nativeRequests.get(requestId)
  if (!pending) return
  if (pending.principalId !== ws.principalId || pending.clientId !== ws.clientId) return
  nativeRequests.delete(requestId)
  clearTimeout(pending.timer)
  const ok = !!msg.ok
  logInfo('app.native_tool.result', '', {
    principalId: pending.principalId,
    requestId,
    ok,
    clientId: ws.clientId,
  })
  pending.resolve({
    ok,
    result: msg.result ?? null,
    error: msg.error ? String(msg.error) : null,
  })
}

/** 把 outbox 文件复制到 App 暂存区：Bridge 发送后会立刻把原文件移入 sent/ */
function stageFile(sourcePath, fileName) {
  fs.mkdirSync(FILES_DIR, { recursive: true })
  const id = crypto.randomBytes(10).toString('hex')
  const name = sanitizeFileName(fileName || path.basename(sourcePath))
  const target = path.join(FILES_DIR, `${id}_${name}`)
  fs.copyFileSync(sourcePath, target)
  // 文件默认长期保留；只在主人明确要求时手动清理，不再按 7 天/100 个自动删除。
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

/** 文件路由在 Bridge 重启后仍能靠磁盘上的 <id>_<name> 找回文件。 */
function getStagedFile(fileId) {
  const id = String(fileId || '')
  if (!id) return null
  const cached = fileRegistry.get(id)
  if (cached && fs.existsSync(cached.filePath)) return cached
  try {
    if (!fs.existsSync(FILES_DIR)) return null
    const prefix = `${id}_`
    const name = fs.readdirSync(FILES_DIR).find(entry => entry.startsWith(prefix))
    if (!name) return null
    const filePath = path.join(FILES_DIR, name)
    if (!fs.existsSync(filePath)) return null
    const item = { filePath, fileName: name.slice(prefix.length) }
    fileRegistry.set(id, item)
    return item
  } catch {
    return null
  }
}

function persistFileMessage(principalId, info) {
  if (!principalId) return
  try {
    const session = getCurrentSession(principalId)
    if (!session) return
    appendMessage(principalId, session.sessionId, {
      type: 'file',
      fileId: info.fileId,
      fileName: info.fileName,
      kind: info.kind,
      isImage: !!info.isImage,
      size: info.size,
      timestamp: info.timestamp,
    })
    touchSession(principalId, session.sessionId)
  } catch {}
}

function appPrincipalFor(req) {
  // 身份只来自登录用户；device 只用于消息路由，不参与 principal 解析。
  return { deviceId: getDevice(req), principal: req.auth?.principal || null, user: req.auth?.user || null }
}

function effectiveAppPrincipal(principal, owner) {
  if (!principal) return principal
  if (owner) {
    return {
      ...principal,
      role: 'owner',
      capabilities: {
        ...(principal.capabilities || {}),
        editJarvisCode: true,
        useGlobalModel: true,
      },
    }
  }
  // 没有 owner token：即使是 owner 账号也按普通用户处理。
  return {
    ...principal,
    role: 'user',
    capabilities: {
      ...(principal.capabilities || {}),
      editJarvisCode: false,
      useGlobalModel: false,
    },
  }
}

async function handleIncomingMessage(req, res) {
  const { deviceId, principal } = appPrincipalFor(req)
  const owner = ownerTokenOk(req)
  const clientMessageId = String(req.body?.clientMessageId || '').trim().slice(0, 100)
  if (clientMessageId && appStore.hasInboundId(principal.id, clientMessageId)) {
    return res.json({ ok: true, duplicate: true })
  }
  if (!checkRate(deviceId)) {
    return res.status(429).json({ ok: false, error: '消息太频繁，稍等一下喵' })
  }

  const text = String(req.body?.text || '').slice(0, MAX_TEXT_CHARS)
  const attachments = []
  const media = []
  const rawAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments.slice(0, MAX_ATTACHMENTS) : []
  for (const item of rawAttachments) {
    const buffer = Buffer.from(String(item?.dataBase64 || ''), 'base64')
    if (!buffer.length) continue
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      return res.status(413).json({ ok: false, error: '单个附件不能超过 20MB' })
    }
    const fileName = sanitizeFileName(item?.fileName)
    const mime = String(item?.mime || 'application/octet-stream')
    const kind = item?.kind === 'image' ? 'image'
      : (mime.startsWith('video/') ? 'video' : (mime.startsWith('audio/') ? 'audio' : 'file'))
    attachments.push({ kind, fileName, buffer })
    const saved = appStore.saveMedia(principal.id, { fileName, mime, buffer })
    media.push({ id: saved.id, fileName: saved.fileName, kind, mime: saved.mime, size: saved.size })
  }

  const attachmentIds = Array.isArray(req.body?.attachmentIds) ? req.body.attachmentIds.slice(0, MAX_ATTACHMENTS) : []
  for (const id of attachmentIds) {
    const item = appStore.getMedia(principal.id, String(id))
    if (!item || !fs.existsSync(item.filePath)) continue
    const buffer = fs.readFileSync(item.filePath)
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      return res.status(413).json({ ok: false, error: '单个附件不能超过 20MB' })
    }
    const mime = String(item.mime || '')
    const kind = mime.startsWith('image/') ? 'image'
      : (mime.startsWith('video/') ? 'video' : (mime.startsWith('audio/') ? 'audio' : 'file'))
    attachments.push({ kind, fileName: sanitizeFileName(item.fileName), buffer })
    media.push({ id: item.id, fileName: item.fileName, kind, mime: item.mime, size: item.size })
  }

  if (!text && !attachments.length) {
    return res.status(400).json({ ok: false, error: '消息为空' })
  }

  try {
    const replyTo = req.get('X-Client-Id') || null
    onMessageCb?.({
      from: deviceId,
      principalId: principal.id,
      text,
      attachments,
      media,
      replyTo,
      timestamp: new Date().toISOString(),
      owner,
    })
    if (clientMessageId) appStore.rememberInboundId(principal.id, clientMessageId)
    logInfo('app.message.in', '', { deviceId, textLen: text.length, attachments: attachments.length, owner, replyTo, clientMessageId: clientMessageId || null })
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

  // ── 简单账号：用户名 + 密码，新用户自动分配 tokenId ─────────────────────
  app.post('/api/v1/auth/register', (req, res) => {
    if (!checkRate(`auth:${req.ip || 'local'}`)) {
      return res.status(429).json({ ok: false, error: '操作太频繁，稍后再试' })
    }
    try {
      const user = authStore.register({
        nickname: req.body?.nickname,
        account: req.body?.account || req.body?.username,
        password: req.body?.password,
      })
      res.json({
        ok: true,
        tokenId: user.tokenId,
        user: {
          account: user.account,
          nickname: user.nickname,
          accountId: user.accountId,
          ownerId: user.ownerId,
          principalId: user.principalId,
          role: user.role,
        },
      })
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message })
    }
  })

  /** 忘记密码时的恢复入口：只认 owner token，不需要登录。 */
  app.post('/api/v1/auth/owner-reset', (req, res) => {
    if (!checkRate(`auth:${req.ip || 'local'}`)) {
      return res.status(429).json({ ok: false, error: '操作太频繁，稍后再试' })
    }
    if (!ownerTokenOk(req)) {
      return res.status(403).json({ ok: false, error: '需要 owner token' })
    }
    try {
      const user = authStore.setPassword(req.body?.account || req.body?.accountId, req.body?.password)
      res.json({ ok: true, user })
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message })
    }
  })

  app.post('/api/v1/auth/login', (req, res) => {
    if (!checkRate(`auth:${req.ip || 'local'}`)) {
      return res.status(429).json({ ok: false, error: '操作太频繁，稍后再试' })
    }
    try {
      const user = authStore.login(req.body?.account || req.body?.username, req.body?.password)
      res.json({
        ok: true,
        tokenId: user.tokenId,
        user: {
          account: user.account,
          nickname: user.nickname,
          accountId: user.accountId,
          ownerId: user.ownerId,
          principalId: user.principalId,
          role: user.role,
        },
      })
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message })
    }
  })

  /**
   * 单独配置账号的 ownerId（默认空）。
   * 只由 owner token 授权；ownerId 不参与 owner 权限判定，只决定数据归属。
   */
  app.post('/api/v1/admin/owner-id', auth, (req, res) => {
    if (!ownerTokenOk(req)) {
      return res.status(403).json({ ok: false, error: '需要 owner token' })
    }
    try {
      const user = authStore.setOwnerId(
        req.body?.account || req.body?.accountId,
        req.body?.ownerId || '',
      )
      res.json({ ok: true, user })
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message })
    }
  })

  // 历史消息：与微信共用同一个 principal / 当前会话
  app.get('/api/history', auth, async (req, res) => {
    const { deviceId, principal } = appPrincipalFor(req)
    const owner = ownerTokenOk(req)
    try {
      const session = getCurrentSession(principal.id)
      if (!session) return res.json({ ok: true, messages: [], owner })
      const messages = await queryOr('history', {
        principalId: principal.id,
        sessionId: session.sessionId,
        limit: 80,
      }, () => historyTexts(principal.id, session.sessionId, 80))
      res.json({ ok: true, messages, owner })
    } catch (err) {
      logError('app.history.fail', err.message, { deviceId })
      res.status(500).json({ ok: false, error: '读取历史消息失败' })
    }
  })

  app.post('/api/message', auth, handleIncomingMessage)

  app.get('/api/file/:id', auth, (req, res) => {
    const item = getStagedFile(String(req.params.id || ''))
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
    const { deviceId, principal, user } = appPrincipalFor(req)
    const owner = ownerTokenOk(req)
    const settings = appStore.readSettings(principal.id)
    res.json({
      ok: true,
      principalId: principal.id,
      account: user?.account || null,
      nickname: user?.nickname || principal.displayName,
      accountId: user?.accountId || null,
      ownerId: user?.ownerId || '',
      username: user?.account || null,
      displayName: user?.nickname || principal.displayName,
      role: owner ? 'owner' : 'user',
      owner,
      testMode: settings.testMode !== false,
      device: deviceId,
    })
  })

  app.put('/api/v1/me', auth, (req, res) => {
    const { user } = appPrincipalFor(req)
    try {
      const updated = authStore.updateNickname(user.accountId, req.body?.nickname)
      res.json({ ok: true, nickname: updated.nickname, user: updated })
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message })
    }
  })

  // ── AI 人设：每个用户只读写自己的 persona.md ─────────────────────────────
  app.get('/api/v1/persona', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    try {
      const settings = appStore.readSettings(principal.id)
      res.json({
        ok: true,
        persona: readPersona(principal.id),
        status: {
          style: settings.aiStatusStyle || 'auto',
          suffix: settings.aiStatusSuffix || '',
        },
        presets: Object.entries(PERSONA_PRESETS).map(([id, preset]) => ({
          id,
          label: preset.label,
          summary: preset.summary,
          content: preset.content,
        })),
      })
    } catch (err) {
      logError('app.persona.read.fail', err.message, { principalId: principal.id })
      res.status(500).json({ ok: false, error: '读取人设失败' })
    }
  })

  app.put('/api/v1/persona', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    const content = String(req.body?.persona || '').trim()
    if (!content) return res.status(400).json({ ok: false, error: '人设内容不能为空' })
    if (content.length > MAX_PERSONA_CHARS) {
      return res.status(400).json({ ok: false, error: `人设内容不能超过 ${MAX_PERSONA_CHARS} 字` })
    }
    const style = String(req.body?.statusStyle || 'auto')
    if (!PERSONA_STATUS_STYLES.has(style)) {
      return res.status(400).json({ ok: false, error: '运行状态语气无效' })
    }
    const suffix = String(req.body?.statusSuffix || '').trim().slice(0, 16)
    try {
      writePersona(principal.id, content.endsWith('\n') ? content : `${content}\n`)
      const settings = appStore.updateSettings(principal.id, {
        aiStatusStyle: style,
        aiStatusSuffix: suffix,
      })
      res.json({
        ok: true,
        persona: readPersona(principal.id),
        status: { style: settings.aiStatusStyle, suffix: settings.aiStatusSuffix },
      })
    } catch (err) {
      logError('app.persona.write.fail', err.message, { principalId: principal.id })
      res.status(500).json({ ok: false, error: `保存人设失败：${err.message}` })
    }
  })

  app.get('/api/v1/app/version', auth, (_req, res) => {
    try {
      const latest = JSON.parse(fs.readFileSync(path.join(APP_WEB_DIR, 'dl', 'latest.json'), 'utf-8'))
      res.json({ ok: true, ...latest })
    } catch {
      res.status(404).json({ ok: false, error: '还没有发布版本信息' })
    }
  })

  app.get('/api/v1/session/current', auth, asyncRoute(async (req, res) => {
    const { principal } = appPrincipalFor(req)
    const owner = ownerTokenOk(req)
    const session = getCurrentSession(principal.id)
    if (!session) {
      return res.json({
        ok: true,
        session: null,
        messages: [],
        owner,
        unread: 0,
        readCursor: 0,
        context: null,
        running: getTurnStatus(principal.id),
      })
    }
    const readCursor = appStore.getReadCursor(principal.id, session.sessionId)
    const data = await queryOr('uiTail', {
      principalId: principal.id,
      sessionId: session.sessionId,
      limit: 120,
      readCursor,
    }, () => tailUiMessages(principal.id, session.sessionId, 120, readCursor))
    const messages = data.messages
    res.json({
      ok: true,
      session,
      messages,
      owner,
      cursor: messages.length ? messages[messages.length - 1].seq + 1 : 0,
      oldestSeq: data.oldestSeq,
      hasMore: data.hasMore,
      readCursor,
      unread: data.unread,
      context: appStore.getSessionContext(principal.id, session.sessionId),
      running: getTurnStatus(principal.id),
    })
  }))

  /** 向上翻历史：before 是当前最老消息的 seq，返回更早的一页。 */
  app.get('/api/v1/session/history', auth, asyncRoute(async (req, res) => {
    const { principal } = appPrincipalFor(req)
    const session = getCurrentSession(principal.id)
    if (!session) return res.json({ ok: true, session: null, messages: [], hasMore: false, oldestSeq: 0 })
    const before = req.query.before === undefined || req.query.before === ''
      ? null
      : Math.max(0, Number(req.query.before) || 0)
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 120))
    const data = await queryOr('uiBefore', {
      principalId: principal.id,
      sessionId: session.sessionId,
      before,
      limit,
    }, () => beforeUiMessages(principal.id, session.sessionId, before, limit))
    res.json({
      ok: true,
      session,
      sessionId: session.sessionId,
      messages: data.messages,
      hasMore: data.hasMore,
      oldestSeq: data.oldestSeq,
    })
  }))

  /**
   * App 增量同步：WebSocket 只负责实时提醒，断线/重连后以这里为准。
   * after 是上一次看到的 seq+1；返回 sessionId、消息和新的 cursor。
   */
  app.get('/api/v1/sync', auth, asyncRoute(async (req, res) => {
    const { principal } = appPrincipalFor(req)
    const session = getCurrentSession(principal.id)
    if (!session) return res.json({ ok: true, session: null, sessionId: null, messages: [], cursor: 0, readCursor: 0, unread: 0 })
    const readCursor = appStore.getReadCursor(principal.id, session.sessionId)
    const after = Math.max(0, Number(req.query.after) || 0)
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100))
    const data = await queryOr('uiAfter', {
      principalId: principal.id,
      sessionId: session.sessionId,
      after,
      limit,
      readCursor,
    }, () => afterUiMessages(principal.id, session.sessionId, after, limit, readCursor))
    res.json({
      ok: true,
      session,
      sessionId: session.sessionId,
      messages: data.messages,
      cursor: data.cursor,
      readCursor,
      unread: data.unread,
      lastSeq: data.lastSeq,
      serverTime: new Date().toISOString(),
    })
  }))

  app.post('/api/v1/read', auth, asyncRoute(async (req, res) => {
    const { principal } = appPrincipalFor(req)
    const session = getCurrentSession(principal.id)
    if (!session) return res.json({ ok: true, readCursor: 0, unread: 0 })
    // 游标必须是消息 seq，而不是消息条数：UI 消息的 seq 来自全局消息序号，
    // 用条数会导致 unread 永远算不平（表现为 99+）。
    const requested = req.body?.cursor === undefined ? null : Number(req.body.cursor)
    const info = await queryOr('readInfo', {
      principalId: principal.id,
      sessionId: session.sessionId,
      cursor: requested,
    }, () => uiReadInfo(principal.id, session.sessionId, requested))
    const readCursor = appStore.markRead(principal.id, session.sessionId, info.readCursor)
    res.json({
      ok: true,
      readCursor,
      unread: info.unread,
    })
  }))

  app.post('/api/v1/session/message', auth, handleIncomingMessage)

  /**
   * 手动压缩上下文：立即把较早对话压成长期记忆摘要，下一回合换新 Agent 会话。
   * 聊天历史不受影响；压缩本身可能耗时几十秒，前端需要显示进行中状态。
   */
  app.post('/api/v1/session/compact', auth, asyncRoute(async (req, res) => {
    const { principal } = appPrincipalFor(req)
    const owner = ownerTokenOk(req)
    const result = await compactSessionNow({
      principalId: principal.id,
      roleOverride: owner ? 'owner' : 'user',
    })
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error || '压缩失败' })
    }
    res.json(result)
  }))

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
        url: `/api/v1/media/${item.id}`,
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
    for (const key of ['displayName', 'testMode', 'notifications', 'appearance', 'assistantName']) {
      if (body[key] !== undefined) patch[key] = body[key]
    }
    if (patch.assistantName !== undefined) {
      patch.assistantName = String(patch.assistantName || '').trim().slice(0, 20)
    }
    const settings = appStore.updateSettings(principal.id, patch)
    res.json({ ok: true, settings })
  })

  // ── 心情：读取当前用户 workspace/mood.json（前端顶栏展示） ─────────────────
  app.get('/api/v1/mood', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    try {
      const file = path.join(ROOT, 'userdata', principal.id, 'workspace', 'mood.json')
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
      res.json({
        ok: true,
        mood: Number(data.mood) || 0,
        state: String(data.state || ''),
        updatedAt: data.updatedAt || '',
      })
    } catch {
      res.json({ ok: true, mood: 0, state: '平静' })
    }
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

  app.post('/api/v1/settings/models/:id/test', auth, asyncRoute(async (req, res) => {
    const { principal } = appPrincipalFor(req)
    const model = appStore.getModel(principal.id, req.params.id)
    if (!model) return res.status(404).json({ ok: false, error: '模型不存在' })
    const result = await testModelConnection(principal.id, model)
    res.json({ ok: result.ok, ...result })
  }))

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
    const effective = effectiveAppPrincipal(principal, owner)
    const tool = getCatalogTool(principal.id, effective, req.params.id)
    if (!tool) return res.status(404).json({ ok: false, error: '工具不存在' })
    const body = req.body || {}

    if (body.enabled !== undefined && tool.available === false) {
      return res.status(400).json({ ok: false, error: '该工具待接入，暂不可启用' })
    }
    // 外接工具定义/配置是全局的；普通用户只能改自己的 enabled。
    if (tool.class === 'external' && (body.config !== undefined || body.secrets !== undefined)) {
      return res.status(403).json({ ok: false, error: '外接工具配置由主人统一管理' })
    }

    if (body.enabled !== undefined) appStore.setToolEnabled(principal.id, req.params.id, !!body.enabled)
    if (body.config && typeof body.config === 'object') appStore.setToolConfig(principal.id, req.params.id, body.config)
    if (body.secrets && typeof body.secrets === 'object') {
      for (const [key, value] of Object.entries(body.secrets)) {
        if (value) appStore.setToolSecret(principal.id, req.params.id, key, String(value))
      }
    }
    res.json({
      ok: true,
      tool: getCatalogTool(principal.id, effective, req.params.id),
    })
  })

  app.get('/api/v1/context', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    const session = getCurrentSession(principal.id)
    res.json({
      ok: true,
      context: appStore.getSessionContext(principal.id, session?.sessionId || ''),
    })
  })

  app.get('/api/v1/usage/summary', auth, asyncRoute(async (req, res) => {
    const started = Date.now()
    const { principal } = appPrincipalFor(req)
    // messageLimit=0：只要总量统计，不带明细（App 端首屏用，明细按需分页拉）
    // 首屏只需要最近一页；旧前端传 200 也最多给 60，避免 Tailscale 下拖大响应
    const messageLimit = req.query.messageLimit === '0'
      ? 0
      : Math.min(60, Math.max(20, Number(req.query.messageLimit) || 200))
    const pricing = appStore.readUsagePricing(principal.id)
    const summary = await queryOr('usageSummary', {
      principalId: principal.id,
      from: req.query.from,
      to: req.query.to,
      messageLimit,
      pricing,
    }, () => appStore.usageSummaryRange(principal.id, {
      from: req.query.from,
      to: req.query.to,
      messageLimit,
      pricing,
    }))
    const names = new Map(listSessions(principal.id).map(item => [item.sessionId, item.name]))
    summary.sessionList = Object.values(summary.bySession || {})
      .map(item => ({ ...item, name: names.get(item.sessionId) || '' }))
      .sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')))
    summary.messages = (summary.messages || []).map(item => ({
      ...item,
      sessionName: names.get(item.sessionId) || '',
    }))
    let presets = null
    if (req.query.presets === '1') {
      presets = await queryOr('usagePresets', {
        principalId: principal.id,
        pricing,
      }, () => appStore.usagePresetSummaries(principal.id, { pricing }))
    }
    res.json({ ok: true, summary, presets })
    logInfo('usage.timing', 'summary', {
      principalId: principal.id,
      messageLimit,
      messages: summary.messages.length,
      presets: presets ? Object.keys(presets).length : 0,
      ms: Date.now() - started,
    })
  }))

  /** 对话明细分页：展开时才拉，滚动到底用 nextBefore 加载更早。 */
  app.get('/api/v1/usage/messages', auth, asyncRoute(async (req, res) => {
    const started = Date.now()
    const { principal } = appPrincipalFor(req)
    const pricing = appStore.readUsagePricing(principal.id)
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20))
    const args = {
      principalId: principal.id,
      from: req.query.from,
      to: req.query.to,
      before: req.query.before || null,
      limit,
      pricing,
    }
    const data = await queryOr('usageMessages', args, () => appStore.usageMessagesPage(principal.id, args))
    res.json({ ok: true, ...data })
    logInfo('usage.timing', 'messages', {
      principalId: principal.id,
      limit,
      returned: data.messages.length,
      ms: Date.now() - started,
    })
  }))

  app.get('/api/v1/usage/message', auth, asyncRoute(async (req, res) => {
    const started = Date.now()
    const { principal } = appPrincipalFor(req)
    const turnId = typeof req.query.turnId === 'string' ? req.query.turnId.slice(0, 160) : ''
    if (!turnId) return res.status(400).json({ ok: false, error: 'turnId required' })
    const pricing = appStore.readUsagePricing(principal.id)
    const records = await queryOr('usageByTurn', {
      principalId: principal.id,
      turnId,
      pricing,
    }, () => appStore.listUsageByTurn(principal.id, turnId, pricing))
    res.json({ ok: true, records })
    logInfo('usage.timing', 'message', {
      principalId: principal.id,
      records: records.length,
      ms: Date.now() - started,
    })
  }))

  app.get('/api/v1/usage/pricing', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    res.json({ ok: true, pricing: appStore.readUsagePricing(principal.id) })
  })

  app.put('/api/v1/usage/pricing', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    const pricing = appStore.writeUsagePricing(principal.id, req.body || {})
    res.json({ ok: true, pricing })
  })

  app.get('/api/v1/usage/records', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 50))
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.slice(0, 80) : ''
    const level = req.query.level === 'call' ? 'call' : (req.query.level === 'turn' ? 'turn' : '')
    res.json({
      ok: true,
      records: appStore.listUsage(principal.id, {
        month: req.query.month,
        limit,
        sessionId,
        level,
      }),
    })
  })

  app.get('/api/v1/devices', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    res.json({ ok: true, devices: appStore.listDevices(principal.id) })
  })

  app.delete('/api/v1/devices/:clientId', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    res.json({ ok: appStore.removeDevice(principal.id, req.params.clientId) })
  })

  // ── 管理员授权（远程审批：手机允许/拒绝） ────────────────────────────────
  app.get('/api/v1/admin/approvals', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    res.json({ ok: true, approvals: listPendingApprovals(principal.id) })
  })

  app.post('/api/v1/admin/approvals/:id/decide', auth, (req, res) => {
    const { principal } = appPrincipalFor(req)
    const decision = req.body?.decision === 'allow' ? 'allow' : 'deny'
    const ok = decideApproval(req.params.id, principal.id, decision)
    if (!ok) return res.status(404).json({ ok: false, error: '请求不存在或已过期' })
    logInfo('app.approval.decide', '', { principalId: principal.id, approvalId: req.params.id, decision })
    res.json({ ok: true, decision })
  })

  app.use(express.static(APP_WEB_DIR, {
    extensions: ['html'],
    setHeaders: (res, filePath) => {
      // no-cache：每次都校验 ETag，文件没变返回 304（不再重复传 173KB 的 app.js），
      // 文件变了立即拿到新版本；兼顾「秒开」和「自更新后不缓存旧页面」。
      if (/\.(html|js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache')
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
    const provided = url.searchParams.get('token') || ''
    const user = authStore.findByToken(provided)
    if (!user) {
      ws.close(4401, '请先登录')
      return
    }
    const deviceId = sanitizeDevice(url.searchParams.get('device') || 'owner')
    const owner = ownerTokenOk(req, url)
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 120)
    const clientId = crypto.randomUUID()
    let set = clients.get(clientId)
    if (!set) { set = new Set(); clients.set(clientId, set) }
    set.add(ws)
    ws.deviceId = deviceId
    ws.clientId = clientId
    ws.isNative = /JarvisAndroid/i.test(userAgent)
    ws.userAgent = userAgent
    ws.connectedAt = Date.now()
    let deviceSet = deviceClientSets.get(deviceId)
    if (!deviceSet) { deviceSet = new Set(); deviceClientSets.set(deviceId, deviceSet) }
    deviceSet.add(clientId)
    deviceClients.set(deviceId, clientId)
    clientDevices.set(clientId, deviceId)
    clientDeviceHistory.set(clientId, { deviceId, at: Date.now() })
    pruneClientHistory()

    const principal = getPrincipal(user.principalId)
    if (!principal) {
      ws.close(4403, '账号未绑定用户主体')
      return
    }
    try {
      appStore.recordDevice(principal.id, { clientId, deviceId })
      ws.principalId = principal.id
      let pset = principalClients.get(principal.id)
      if (!pset) { pset = new Set(); principalClients.set(principal.id, pset) }
      pset.add(ws)
    } catch {}

    ws.send(JSON.stringify({
      type: 'hello',
      clientId,
      deviceId,
      owner,
      account: user.account,
      nickname: user.nickname,
      accountId: user.accountId,
      principalId: user.principalId,
    }))
    if (principal && runningTurns.has(principal.id)) {
      try {
        ws.send(JSON.stringify({ type: 'turn_status', ...runningTurns.get(principal.id) }))
      } catch {}
    }
    for (const key of [`${principal.id}:${clientId}`, `${principal.id}:${deviceId}`]) {
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
        else if (msg?.type === 'native_tool_result') handleNativeToolResult(ws, msg)
      } catch {}
    })

    ws.on('close', () => {
      for (const [requestId, pending] of nativeRequests) {
        if (pending.clientId !== clientId) continue
        clearTimeout(pending.timer)
        nativeRequests.delete(requestId)
        pending.resolve({ ok: false, error: '手机连接已断开' })
      }
      if (ws.principalId) {
        const pset = principalClients.get(ws.principalId)
        if (pset) {
          pset.delete(ws)
          if (!pset.size) principalClients.delete(ws.principalId)
        }
      }
      const bucket = clients.get(clientId)
      if (bucket) {
        bucket.delete(ws)
        if (bucket.size === 0) clients.delete(clientId)
      }
      const deviceSet = deviceClientSets.get(deviceId)
      if (deviceSet) {
        deviceSet.delete(clientId)
        if (deviceSet.size === 0) deviceClientSets.delete(deviceId)
      }
      if (deviceClients.get(deviceId) === clientId) {
        const remaining = deviceSet ? [...deviceSet] : []
        if (remaining.length) deviceClients.set(deviceId, remaining[remaining.length - 1])
        else deviceClients.delete(deviceId)
      }
      clientDevices.delete(clientId)
      logInfo('app.ws.close', '', { deviceId, clientId, ua: userAgent })
    })

    logInfo('app.ws.connect', '', {
      deviceId,
      clientId,
      owner,
      account: user.account,
      nickname: user.nickname,
      accountId: user.accountId,
      ua: userAgent,
    })
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
  logInfo('app.adapter.start', '', { host, port })
}

/** 该设备/客户端是否有活跃的 WebSocket（用于提醒优先投递到 App） */
export function isOnline(externalUserId) {
  const key = String(externalUserId || '')
  if (!key) return false
  const history = clientDeviceHistory.get(key)
  const deviceId = clientDevices.get(key)
    || (history && history.deviceId)
    || (deviceClientSets.has(key) ? key : '')
  if (!deviceId) {
    const set = clients.get(key)
    return !!set && [...set].some(ws => ws.readyState === 1)
  }
  const deviceSet = deviceClientSets.get(deviceId)
  if (!deviceSet) return false
  return [...deviceSet].some(clientId => {
    const set = clients.get(clientId)
    return !!set && [...set].some(ws => ws.readyState === 1)
  })
}

/**
 * 更新某个用户的回合运行状态，并实时推给该用户连接的 App。
 * patch.state: queued | started | tool | writing | interim | done
 */
export function setTurnStatus(principalId, patch = {}) {
  if (!principalId) return
  if (patch.state === 'done') {
    runningTurns.delete(principalId)
    pushTurnStatus(principalId, { state: 'done' })
    return
  }
  const prev = runningTurns.get(principalId) || null
  const next = {
    ...(prev || { since: Date.now() }),
    ...patch,
  }
  if (!next.since) next.since = Date.now()
  runningTurns.set(principalId, next)
  pushTurnStatus(principalId, next)
}

export function getTurnStatus(principalId) {
  return runningTurns.get(principalId) || null
}

function pushTurnStatus(principalId, status) {
  const set = principalClients.get(principalId)
  if (!set || !set.size) return
  const payload = JSON.stringify({ type: 'turn_status', ...status })
  for (const ws of set) {
    if (ws.readyState === 1) {
      try { ws.send(payload) } catch {}
    }
  }
}

export async function send(externalUserId, text, opts = {}) {
  if (!text) return
  // 「正在处理」安抚语已经在 App 状态条里展示，不再额外插入临时消息。
  if (opts.interim) return
  const principalId = opts.principalId || ''
  pushToTarget(externalUserId, {
    type: 'assistant',
    text: String(text),
    accountId: opts.accountId || 'default',
    principalId,
    timestamp: new Date().toISOString(),
  }, principalId)
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
  const size = fs.statSync(filePath).size
  const timestamp = new Date().toISOString()
  const info = {
    fileId: staged.id,
    fileName: staged.name,
    kind,
    isImage,
    size,
    timestamp,
  }
  const principalId = opts.principalId || ''
  if (principalId) persistFileMessage(principalId, info)
  pushToTarget(target, {
    type: 'file',
    id: staged.id,
    fileName: staged.name,
    kind,
    isImage,
    size,
    url: `/api/file/${staged.id}`,
    principalId,
    timestamp,
  }, principalId)
  logInfo('app.file.sent', fileName, { target, principalId: principalId || null, bytes: size })
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
  deviceClientSets.clear()
  clientDevices.clear()
  clientDeviceHistory.clear()
  pending.clear()
  principalClients.clear()
  runningTurns.clear()
  try { wss?.close() } catch {}
  wss = null
  try { server?.close() } catch {}
  server = null
  onMessageCb = null
}
