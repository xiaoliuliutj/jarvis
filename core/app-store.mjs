/**
 * App 端每用户存储。
 *
 * 所有数据挂在 userdata/<principalId>/app/ 下：
 *   settings.json / models.json / tools.json / devices.json / usage/*.jsonl / media/
 * API Key 单独加密存到 userdata/_secrets/<principalId>.json，
 * 主密钥在 config/app-secrets.key（0600，文件工具应拒绝访问）。
 *
 * 这是 App 管理台的数据层，不替代 user-store 的会话/记忆。
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { CONFIG_DIR, USERDATA_DIR, principalDir, ensureDir } from './paths.mjs'

const APP_DIR_NAME = 'app'
const SECRETS_DIR = path.join(USERDATA_DIR, '_secrets')
const MASTER_KEY_FILE = path.join(CONFIG_DIR, 'app-secrets.key')
const CAPABILITIES = new Set(['chat', 'image', 'video', 'voice', 'embedding'])

function appDir(principalId) {
  return path.join(principalDir(principalId), APP_DIR_NAME)
}

function appFile(principalId, name) {
  return path.join(appDir(principalId), name)
}

function ensureAppDir(principalId) {
  ensureDir(appDir(principalId))
  ensureDir(path.join(appDir(principalId), 'usage'))
  ensureDir(path.join(appDir(principalId), 'media'))
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8')
  fs.renameSync(tmp, file)
}

function nowIso() {
  return new Date().toISOString()
}

// ── settings ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  version: 1,
  displayName: '',
  testMode: true,
  notifications: { enabled: true, sound: true, doNotDisturb: false },
  appearance: { theme: 'system', language: 'zh-CN' },
  updatedAt: null,
}

export function readSettings(principalId) {
  const saved = readJson(appFile(principalId, 'settings.json'), {})
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(saved.notifications || {}) },
    appearance: { ...DEFAULT_SETTINGS.appearance, ...(saved.appearance || {}) },
  }
}

export function updateSettings(principalId, patch = {}) {
  ensureAppDir(principalId)
  const current = readSettings(principalId)
  const next = {
    ...current,
    ...patch,
    notifications: { ...current.notifications, ...(patch.notifications || {}) },
    appearance: { ...current.appearance, ...(patch.appearance || {}) },
    updatedAt: nowIso(),
  }
  writeJson(appFile(principalId, 'settings.json'), next)
  return next
}

// ── secrets ──────────────────────────────────────────────────────────────────

function masterKey() {
  ensureDir(CONFIG_DIR)
  try {
    if (fs.existsSync(MASTER_KEY_FILE)) {
      const hex = fs.readFileSync(MASTER_KEY_FILE, 'utf-8').trim()
      if (/^[a-f0-9]{64}$/i.test(hex)) return Buffer.from(hex, 'hex')
    }
  } catch {}
  const key = crypto.randomBytes(32)
  fs.writeFileSync(MASTER_KEY_FILE, key.toString('hex') + '\n', { encoding: 'utf-8', mode: 0o600 })
  return key
}

function secretsFile(principalId) {
  return path.join(SECRETS_DIR, `${principalId}.json`)
}

function readSecrets(principalId) {
  return readJson(secretsFile(principalId), { version: 1, secrets: {} })
}

function writeSecrets(principalId, data) {
  ensureDir(SECRETS_DIR)
  writeJson(secretsFile(principalId), data)
}

function encryptText(value) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv)
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

function decryptText(payload) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    masterKey(),
    Buffer.from(payload.iv, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

export function setSecret(principalId, name, value) {
  const data = readSecrets(principalId)
  data.secrets[name] = encryptText(value)
  writeSecrets(principalId, data)
  return true
}

export function getSecret(principalId, name) {
  const data = readSecrets(principalId)
  const payload = data.secrets?.[name]
  if (!payload) return null
  try {
    return decryptText(payload)
  } catch {
    return null
  }
}

export function hasSecret(principalId, name) {
  return !!readSecrets(principalId).secrets?.[name]
}

export function deleteSecret(principalId, name) {
  const data = readSecrets(principalId)
  if (!data.secrets?.[name]) return false
  delete data.secrets[name]
  writeSecrets(principalId, data)
  return true
}

export function listSecretNames(principalId) {
  return Object.keys(readSecrets(principalId).secrets || {})
}

// ── models ───────────────────────────────────────────────────────────────────

function readModels(principalId) {
  const data = readJson(appFile(principalId, 'models.json'), {})
  return { version: 1, models: Array.isArray(data.models) ? data.models : [] }
}

function writeModels(principalId, models) {
  ensureAppDir(principalId)
  writeJson(appFile(principalId, 'models.json'), { version: 1, models })
}

function publicModel(principalId, model) {
  return {
    ...model,
    hasKey: hasSecret(principalId, `model:${model.id}`),
  }
}

export function listModels(principalId) {
  return readModels(principalId).models
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .map(m => publicModel(principalId, m))
}

export function upsertModel(principalId, input = {}) {
  const capability = CAPABILITIES.has(input.capability) ? input.capability : 'chat'
  const models = readModels(principalId)
  const id = String(input.id || `model_${crypto.randomBytes(6).toString('hex')}`)
  const existingIndex = models.models.findIndex(m => m.id === id)
  const existing = existingIndex >= 0 ? models.models[existingIndex] : {}
  const entry = {
    ...existing,
    id,
    capability,
    name: String(input.name || existing.name || '未命名模型').slice(0, 80),
    provider: String(input.provider || existing.provider || 'custom').slice(0, 60),
    baseUrl: String(input.baseUrl || existing.baseUrl || '').slice(0, 300),
    model: String(input.model || existing.model || '').slice(0, 200),
    authMode: ['both', 'api-key', 'auth-token'].includes(input.authMode)
      ? input.authMode
      : (existing.authMode || 'both'),
    params: (input.params && typeof input.params === 'object') ? input.params : (existing.params || {}),
    enabled: input.enabled !== undefined ? !!input.enabled : (existing.enabled !== false),
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : (existing.priority || 0),
    createdAt: existing.createdAt || nowIso(),
    updatedAt: nowIso(),
  }
  if (input.apiKey) setSecret(principalId, `model:${id}`, String(input.apiKey))
  if (input.clearKey) deleteSecret(principalId, `model:${id}`)
  if (existingIndex >= 0) models.models[existingIndex] = entry
  else models.models.push(entry)
  writeModels(principalId, models.models)
  return publicModel(principalId, entry)
}

export function deleteModel(principalId, id) {
  const models = readModels(principalId)
  const next = models.models.filter(m => m.id !== id)
  if (next.length === models.models.length) return false
  writeModels(principalId, next)
  deleteSecret(principalId, `model:${id}`)
  return true
}

/** 供 conversation 使用：解析当前用户启用的 chat 模型（无配置返回 null）。 */
export function getChatRuntime(principalId) {
  const models = readModels(principalId).models
    .filter(m => m.capability === 'chat' && m.enabled !== false)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
  for (const model of models) {
    const apiKey = getSecret(principalId, `model:${model.id}`)
    if (!apiKey) continue
    return {
      id: model.id,
      name: model.name,
      provider: model.provider,
      baseUrl: model.baseUrl,
      model: model.model,
      authMode: model.authMode || 'both',
      apiKey,
    }
  }
  return null
}

export function getModel(principalId, id) {
  const model = readModels(principalId).models.find(m => m.id === id)
  return model ? publicModel(principalId, model) : null
}

// ── tool configs ─────────────────────────────────────────────────────────────

function readTools(principalId) {
  const data = readJson(appFile(principalId, 'tools.json'), {})
  return {
    version: 1,
    enabled: (data.enabled && typeof data.enabled === 'object') ? data.enabled : {},
    config: (data.config && typeof data.config === 'object') ? data.config : {},
  }
}

function writeTools(principalId, data) {
  ensureAppDir(principalId)
  writeJson(appFile(principalId, 'tools.json'), { version: 1, ...data })
}

export function isToolEnabled(principalId, toolId, fallback = true) {
  const data = readTools(principalId)
  return data.enabled[toolId] !== undefined ? !!data.enabled[toolId] : fallback
}

export function setToolEnabled(principalId, toolId, enabled) {
  const data = readTools(principalId)
  data.enabled[toolId] = !!enabled
  writeTools(principalId, data)
  return data.enabled[toolId]
}

export function getToolConfig(principalId, toolId) {
  return readTools(principalId).config[toolId] || {}
}

export function setToolConfig(principalId, toolId, config = {}) {
  const data = readTools(principalId)
  data.config[toolId] = config
  writeTools(principalId, data)
  return data.config[toolId]
}

export function getAllToolConfigs(principalId) {
  return readTools(principalId)
}

export function setToolSecret(principalId, toolId, name, value) {
  return setSecret(principalId, `tool:${toolId}:${name}`, value)
}

export function hasToolSecret(principalId, toolId, name) {
  return hasSecret(principalId, `tool:${toolId}:${name}`)
}

// ── usage ────────────────────────────────────────────────────────────────────

function monthKey(date = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}`
}

function usageFile(principalId, month = monthKey()) {
  return path.join(appDir(principalId), 'usage', `${month}.jsonl`)
}

export function appendUsage(principalId, record = {}) {
  ensureAppDir(principalId)
  const entry = {
    id: `u_${crypto.randomBytes(6).toString('hex')}`,
    ts: record.ts || nowIso(),
    principalId,
    sessionId: record.sessionId || null,
    source: record.source || 'chat',
    capability: record.capability || 'chat',
    model: record.model || '',
    provider: record.provider || '',
    inputTokens: Number(record.inputTokens) || 0,
    outputTokens: Number(record.outputTokens) || 0,
    cost: Number(record.cost) || 0,
    turns: Number(record.turns) || 0,
    latencyMs: Number(record.latencyMs) || 0,
    status: record.status || 'ok',
    tools: Array.isArray(record.tools) ? record.tools.slice(0, 20) : [],
  }
  fs.appendFileSync(usageFile(principalId, monthKey(new Date(entry.ts))), JSON.stringify(entry) + '\n', 'utf-8')
  return entry
}

export function listUsage(principalId, { month = monthKey(), limit = 100 } = {}) {
  const file = usageFile(principalId, month)
  if (!fs.existsSync(file)) return []
  const rows = fs.readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
  return rows.slice(-Math.max(1, Number(limit) || 100)).reverse()
}

export function usageSummary(principalId, { month = monthKey() } = {}) {
  const rows = listUsage(principalId, { month, limit: 100000 })
  const summary = {
    month,
    calls: rows.length,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    errors: 0,
    avgLatencyMs: 0,
    byModel: {},
    byCapability: {},
  }
  let latencySum = 0
  let latencyCount = 0
  for (const row of rows) {
    summary.inputTokens += row.inputTokens || 0
    summary.outputTokens += row.outputTokens || 0
    summary.cost += row.cost || 0
    if (row.status === 'error') summary.errors += 1
    if (row.latencyMs) { latencySum += row.latencyMs; latencyCount += 1 }
    const modelKey = row.model || 'unknown'
    if (!summary.byModel[modelKey]) summary.byModel[modelKey] = { calls: 0, cost: 0, inputTokens: 0, outputTokens: 0 }
    summary.byModel[modelKey].calls += 1
    summary.byModel[modelKey].cost += row.cost || 0
    summary.byModel[modelKey].inputTokens += row.inputTokens || 0
    summary.byModel[modelKey].outputTokens += row.outputTokens || 0
    const cap = row.capability || 'chat'
    if (!summary.byCapability[cap]) summary.byCapability[cap] = { calls: 0, cost: 0 }
    summary.byCapability[cap].calls += 1
    summary.byCapability[cap].cost += row.cost || 0
  }
  summary.avgLatencyMs = latencyCount ? Math.round(latencySum / latencyCount) : 0
  return summary
}

// ── devices ──────────────────────────────────────────────────────────────────

function readDevices(principalId) {
  const data = readJson(appFile(principalId, 'devices.json'), {})
  return { version: 1, devices: (data.devices && typeof data.devices === 'object') ? data.devices : {} }
}

export function recordDevice(principalId, { clientId, deviceId, name = '' } = {}) {
  if (!clientId) return null
  const data = readDevices(principalId)
  data.devices[clientId] = {
    clientId,
    deviceId: deviceId || '',
    name: name || deviceId || 'App',
    lastSeen: nowIso(),
  }
  ensureAppDir(principalId)
  writeJson(appFile(principalId, 'devices.json'), data)
  return data.devices[clientId]
}

export function listDevices(principalId) {
  return Object.values(readDevices(principalId).devices)
    .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen))
}

export function removeDevice(principalId, clientId) {
  const data = readDevices(principalId)
  if (!data.devices[clientId]) return false
  delete data.devices[clientId]
  writeJson(appFile(principalId, 'devices.json'), data)
  return true
}

// ── media ────────────────────────────────────────────────────────────────────

function mediaIndexFile(principalId) {
  return path.join(appDir(principalId), 'media', 'index.json')
}

function readMediaIndex(principalId) {
  return readJson(mediaIndexFile(principalId), { version: 1, items: {} })
}

function writeMediaIndex(principalId, data) {
  ensureDir(path.join(appDir(principalId), 'media'))
  writeJson(mediaIndexFile(principalId), data)
}

function sanitizeFileName(name) {
  const base = path.basename(String(name || 'file'))
  return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'file'
}

export function saveMedia(principalId, { fileName, mime, buffer } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('空文件')
  ensureAppDir(principalId)
  const id = `media_${crypto.randomBytes(8).toString('hex')}`
  const safeName = sanitizeFileName(fileName)
  const ext = path.extname(safeName).toLowerCase().slice(0, 12)
  const storageKey = `${id}${ext}`
  const filePath = path.join(appDir(principalId), 'media', storageKey)
  fs.writeFileSync(filePath, buffer)
  const item = {
    id,
    fileName: safeName,
    mime: String(mime || 'application/octet-stream').slice(0, 100),
    size: buffer.length,
    storageKey,
    createdAt: nowIso(),
  }
  const index = readMediaIndex(principalId)
  index.items[id] = item
  writeMediaIndex(principalId, index)
  return item
}

export function getMedia(principalId, id) {
  const item = readMediaIndex(principalId).items[id]
  if (!item) return null
  return { ...item, filePath: path.join(appDir(principalId), 'media', item.storageKey) }
}

export function listMedia(principalId, limit = 50) {
  return Object.values(readMediaIndex(principalId).items)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, Math.max(1, limit))
}

export { appDir }
