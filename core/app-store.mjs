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

// ── context usage ─────────────────────────────────────────────────────────────

export function setSessionContext(principalId, sessionId, context) {
  if (!context) return null
  ensureAppDir(principalId)
  const entry = {
    sessionId: sessionId || '',
    totalTokens: Number(context.totalTokens) || 0,
    maxTokens: Number(context.maxTokens) || 0,
    rawMaxTokens: Number(context.rawMaxTokens) || 0,
    percentage: Number(context.percentage) || 0,
    categories: Array.isArray(context.categories)
      ? context.categories.map(item => ({
          id: item?.id || '',
          name: item?.name || '',
          tokens: Number(item?.tokens) || 0,
          color: item?.color || '',
          kind: item?.kind || 'used',
          isDeferred: !!item?.isDeferred,
        }))
      : [],
    updatedAt: nowIso(),
  }
  writeJson(appFile(principalId, 'context.json'), entry)
  return entry
}

export function getSessionContext(principalId, sessionId) {
  const data = readJson(appFile(principalId, 'context.json'), null)
  if (!data || !Array.isArray(data.categories)) return null
  if (sessionId && data.sessionId && data.sessionId !== sessionId) return null
  return data
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
  const hasRaw = !!model.raw && hasSecret(principalId, `model:${model.id}:raw`)
  return {
    ...model,
    hasKey: hasRaw || hasSecret(principalId, `model:${model.id}`),
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

  // 原始 LLM 配置：整段 JSON 加密保存，不拆 provider/baseUrl/model/apiKey。
  // 只保留 name/enabled/priority 这类展示元数据。
  if (capability === 'chat' && input.rawConfig !== undefined) {
    let raw = input.rawConfig
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw) } catch { throw new Error('rawConfig JSON 格式错误') }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('rawConfig 必须是 JSON 对象')
    }
    const entry = {
      id,
      capability: 'chat',
      name: String(input.name || raw.name || raw.model || existing.name || 'LLM 配置').slice(0, 80),
      raw: true,
      enabled: input.enabled !== undefined ? !!input.enabled : (existing.enabled !== false),
      priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : (existing.priority || 0),
      createdAt: existing.createdAt || nowIso(),
      updatedAt: nowIso(),
    }
    setSecret(principalId, `model:${id}:raw`, JSON.stringify(raw))
    deleteSecret(principalId, `model:${id}`)
    if (existingIndex >= 0) models.models[existingIndex] = entry
    else models.models.push(entry)
    writeModels(principalId, models.models)
    return publicModel(principalId, entry)
  }

  // 原始配置的元数据更新（编辑时文本框留空，保持原配置）
  if (existing.raw && input.rawConfig === undefined) {
    const entry = {
      ...existing,
      name: String(input.name || existing.name || 'LLM 配置').slice(0, 80),
      enabled: input.enabled !== undefined ? !!input.enabled : (existing.enabled !== false),
      priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : (existing.priority || 0),
      updatedAt: nowIso(),
    }
    if (existingIndex >= 0) models.models[existingIndex] = entry
    writeModels(principalId, models.models)
    return publicModel(principalId, entry)
  }

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
  deleteSecret(principalId, `model:${id}:raw`)
  return true
}

/** 读取原始 LLM 配置（整段 JSON；含 Key，只在服务端内存使用）。 */
export function getRawModelConfig(principalId, id) {
  const text = getSecret(principalId, `model:${id}:raw`)
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null
  } catch {
    return null
  }
}

/** 供 conversation 使用：优先原始配置，其次旧的分字段 chat 模型。 */
export function getChatRuntime(principalId) {
  const models = readModels(principalId).models
    .filter(m => m.capability === 'chat' && m.enabled !== false)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
  for (const model of models) {
    if (model.raw) {
      const rawConfig = getRawModelConfig(principalId, model.id)
      if (!rawConfig) continue
      return {
        id: model.id,
        name: model.name,
        raw: true,
        rawConfig,
      }
    }
  }
  for (const model of models) {
    if (model.raw) continue
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

function usageDir(principalId) {
  return path.join(appDir(principalId), 'usage')
}

function normalizeMonth(month) {
  const value = String(month || '')
  return /^\d{4}-\d{2}$/.test(value) ? value : monthKey()
}

function usageFile(principalId, month = monthKey()) {
  return path.join(usageDir(principalId), `${normalizeMonth(month)}.jsonl`)
}

function readUsageRows(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
}

export function appendUsage(principalId, record = {}) {
  ensureAppDir(principalId)
  const entry = {
    id: `u_${crypto.randomBytes(6).toString('hex')}`,
    ts: record.ts || nowIso(),
    principalId,
    sessionId: record.sessionId || null,
    turnId: record.turnId || null,
    level: record.level === 'call' ? 'call' : 'turn',
    messagePreview: record.messagePreview
      ? String(record.messagePreview).replace(/\s+/g, ' ').trim().slice(0, 80)
      : '',
    source: record.source || 'chat',
    capability: record.capability || 'chat',
    model: record.model || '',
    provider: record.provider || '',
    inputTokens: Number(record.inputTokens) || 0,
    outputTokens: Number(record.outputTokens) || 0,
    cacheReadTokens: Number(record.cacheReadTokens) || 0,
    cacheWriteTokens: Number(record.cacheWriteTokens) || 0,
    turns: Number(record.turns) || 0,
    latencyMs: Number(record.latencyMs) || 0,
    status: record.status || 'ok',
    tools: Array.isArray(record.tools) ? record.tools.slice(0, 20) : [],
    ...(record.subagent ? { subagent: true } : {}),
  }
  fs.appendFileSync(usageFile(principalId, monthKey(new Date(entry.ts))), JSON.stringify(entry) + '\n', 'utf-8')
  return entry
}

export function listUsage(principalId, { month = monthKey(), limit = 100, sessionId = '', level = '' } = {}) {
  let rows = readUsageRows(usageFile(principalId, month))
  if (sessionId) rows = rows.filter(row => (row.sessionId || 'unknown') === sessionId)
  rows = rows.map(row => ({ ...row, level: row.level === 'call' ? 'call' : 'turn' }))
  if (level === 'call' || level === 'turn') rows = rows.filter(row => row.level === level)
  return rows.slice(-Math.max(1, Number(limit) || 100)).reverse()
}

function monthBounds(month) {
  const safeMonth = normalizeMonth(month)
  const [year, m] = safeMonth.split('-').map(Number)
  return {
    from: new Date(year, m - 1, 1, 0, 0, 0, 0),
    to: new Date(year, m, 1, 0, 0, 0, 0),
  }
}

function monthKeysBetween(from, to) {
  const keys = []
  const cursor = new Date(from.getFullYear(), from.getMonth(), 1)
  const end = new Date(to.getTime() - 1)
  const last = new Date(end.getFullYear(), end.getMonth(), 1)
  while (cursor <= last) {
    keys.push(monthKey(cursor))
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return keys
}

function readUsageRowsInRange(principalId, { from, to }) {
  const fromMs = from.getTime()
  const toMs = to.getTime()
  if (!(fromMs < toMs)) return []
  const rows = []
  for (const key of monthKeysBetween(from, to)) {
    for (const row of readUsageRows(usageFile(principalId, key))) {
      const ts = Date.parse(row.ts)
      if (!Number.isFinite(ts) || ts < fromMs || ts >= toMs) continue
      rows.push({ ...row, level: row.level === 'call' ? 'call' : 'turn' })
    }
  }
  rows.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0))
  return rows
}

export function listUsageByTurn(principalId, turnId) {
  if (!turnId) return []
  const dir = usageDir(principalId)
  if (!fs.existsSync(dir)) return []
  const files = fs.readdirSync(dir)
    .filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name))
    .sort()
  const rows = []
  for (const name of files) {
    for (const row of readUsageRows(path.join(dir, name))) {
      if (row.turnId !== turnId) continue
      rows.push({ ...row, level: row.level === 'call' ? 'call' : 'turn' })
    }
  }
  rows.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0))
  return rows
}

function summarizeRows(rows, { from = null, to = null, messageLimit = 200 } = {}) {
  // 旧中间版本写出的逐次记录没有 turnId，无法归到具体对话轮，且是重复计费；
  // 读取时直接忽略，只保留有 turnId 的新逐次记录和旧整轮汇总。
  const validRows = rows.filter(row => !(row.level === 'call' && !row.turnId))
  const summary = {
    from: from ? new Date(from).toISOString() : null,
    to: to ? new Date(to).toISOString() : null,
    calls: validRows.length,
    sessionCount: 0,
    messageTotal: 0,
    llmCalls: 0,
    callRecords: 0,
    legacyTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    errors: 0,
    activeDays: 0,
    avgLatencyMs: 0,
    byModel: {},
    byCapability: {},
    bySource: {},
    bySession: {},
    messages: [],
  }
  let latencySum = 0
  let latencyCount = 0
  const days = new Set()
  const messageMap = new Map()

  for (const row of validRows) {
    const units = row.level === 'call' ? 1 : Math.max(1, Number(row.turns) || 1)
    summary.inputTokens += row.inputTokens || 0
    summary.outputTokens += row.outputTokens || 0
    summary.cacheReadTokens += row.cacheReadTokens || 0
    summary.cacheWriteTokens += row.cacheWriteTokens || 0
    if (row.status === 'error') summary.errors += 1
    if (row.ts) {
      const date = new Date(row.ts)
      if (Number.isFinite(date.getTime())) {
        days.add(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`)
      }
    }
    if (row.latencyMs) { latencySum += row.latencyMs; latencyCount += 1 }

    const modelKey = row.model || 'unknown'
    if (!summary.byModel[modelKey]) {
      summary.byModel[modelKey] = {
        calls: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      }
    }
    const model = summary.byModel[modelKey]
    model.calls += units
    model.inputTokens += row.inputTokens || 0
    model.outputTokens += row.outputTokens || 0
    model.cacheReadTokens += row.cacheReadTokens || 0
    model.cacheWriteTokens += row.cacheWriteTokens || 0

    const cap = row.capability || 'chat'
    if (!summary.byCapability[cap]) summary.byCapability[cap] = { calls: 0 }
    summary.byCapability[cap].calls += units

    const source = row.source || 'chat'
    if (!summary.bySource[source]) summary.bySource[source] = { calls: 0, inputTokens: 0, outputTokens: 0 }
    summary.bySource[source].calls += units
    summary.bySource[source].inputTokens += row.inputTokens || 0
    summary.bySource[source].outputTokens += row.outputTokens || 0

    const sid = row.sessionId || 'unknown'
    if (!summary.bySession[sid]) {
      summary.bySession[sid] = {
        sessionId: sid,
        calls: 0,
        turnRecords: 0,
        legacyTurns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        firstTs: null,
        lastTs: null,
      }
    }
    const sess = summary.bySession[sid]
    if (row.level === 'call') {
      sess.calls += 1
    } else {
      sess.turnRecords += 1
      sess.legacyTurns += Number(row.turns) || 0
    }
    sess.inputTokens += row.inputTokens || 0
    sess.outputTokens += row.outputTokens || 0
    sess.cacheReadTokens += row.cacheReadTokens || 0
    sess.cacheWriteTokens += row.cacheWriteTokens || 0
    if (row.ts) {
      if (!sess.firstTs || row.ts < sess.firstTs) sess.firstTs = row.ts
      if (!sess.lastTs || row.ts > sess.lastTs) sess.lastTs = row.ts
    }

    const turnId = row.turnId || `legacy:${row.id}`
    if (!messageMap.has(turnId)) {
      messageMap.set(turnId, {
        turnId,
        sessionId: row.sessionId || '',
        preview: '',
        calls: 0,
        turnRecords: 0,
        legacyTurns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        firstTs: row.ts || null,
        lastTs: row.ts || null,
        models: [],
        tools: [],
        status: 'ok',
      })
    }
    const message = messageMap.get(turnId)
    if (!message.sessionId && row.sessionId) message.sessionId = row.sessionId
    if (!message.preview && row.messagePreview) message.preview = row.messagePreview
    if (row.level === 'call') {
      message.calls += 1
    } else {
      message.turnRecords += 1
      message.legacyTurns += Number(row.turns) || 0
    }
    message.inputTokens += row.inputTokens || 0
    message.outputTokens += row.outputTokens || 0
    message.cacheReadTokens += row.cacheReadTokens || 0
    message.cacheWriteTokens += row.cacheWriteTokens || 0
    if (row.ts) {
      if (!message.firstTs || row.ts < message.firstTs) message.firstTs = row.ts
      if (!message.lastTs || row.ts > message.lastTs) message.lastTs = row.ts
    }
    if (row.model && !message.models.includes(row.model)) message.models.push(row.model)
    if (Array.isArray(row.tools)) {
      for (const tool of row.tools) {
        if (tool && !message.tools.includes(tool)) message.tools.push(tool)
      }
    }
    if (row.status === 'error') message.status = 'error'
  }

  summary.avgLatencyMs = latencyCount ? Math.round(latencySum / latencyCount) : 0
  summary.activeDays = days.size
  for (const sess of Object.values(summary.bySession)) {
    sess.totalTokens = sess.inputTokens + sess.outputTokens + sess.cacheReadTokens + sess.cacheWriteTokens
    sess.llmCalls = sess.calls + (sess.legacyTurns || sess.turnRecords)
    summary.llmCalls += sess.llmCalls
    summary.callRecords += sess.calls
    summary.legacyTurns += sess.legacyTurns
  }
  summary.sessionCount = Object.keys(summary.bySession).length

  const messages = [...messageMap.values()].map(message => ({
    ...message,
    level: message.calls > 0 ? 'calls' : 'turn',
    llmCalls: message.calls + (message.legacyTurns || message.turnRecords),
    totalTokens: message.inputTokens
      + message.outputTokens
      + message.cacheReadTokens
      + message.cacheWriteTokens,
  })).sort((a, b) => String(b.firstTs || '').localeCompare(String(a.firstTs || '')))
  summary.messageTotal = messages.length
  const limit = Math.max(1, Math.min(500, Number(messageLimit) || 200))
  summary.messages = messages.slice(0, limit)
  return summary
}

export function usageSummaryRange(principalId, { from, to, messageLimit = 200 } = {}) {
  const now = new Date()
  const fallback = monthBounds(monthKey(now))
  let fromDate = from instanceof Date ? from : new Date(from)
  let toDate = to instanceof Date ? to : new Date(to)
  if (!Number.isFinite(fromDate.getTime())) fromDate = fallback.from
  if (!Number.isFinite(toDate.getTime())) toDate = fallback.to
  if (!(fromDate.getTime() < toDate.getTime())) {
    fromDate = fallback.from
    toDate = fallback.to
  }
  const rows = readUsageRowsInRange(principalId, { from: fromDate, to: toDate })
  return summarizeRows(rows, { from: fromDate, to: toDate, messageLimit })
}

export function usageSummary(principalId, { month = monthKey() } = {}) {
  const safeMonth = normalizeMonth(month)
  const { from, to } = monthBounds(safeMonth)
  const summary = usageSummaryRange(principalId, { from, to, messageLimit: 500 })
  summary.month = safeMonth
  return summary
}

// ── devices ──────────────────────────────────────────────────────────────────

function normalizeDevices(devices = {}) {
  const byDevice = new Map()
  for (const [key, item] of Object.entries(devices || {})) {
    if (!item || typeof item !== 'object') continue
    const deviceId = item.deviceId || key
    const entry = {
      deviceId,
      clientId: item.clientId || key,
      name: item.name || deviceId || 'App',
      lastSeen: item.lastSeen || nowIso(),
    }
    const prev = byDevice.get(deviceId)
    if (!prev || new Date(entry.lastSeen) > new Date(prev.lastSeen)) {
      byDevice.set(deviceId, entry)
    }
  }
  return Object.fromEntries(byDevice)
}

function readDevices(principalId) {
  const data = readJson(appFile(principalId, 'devices.json'), {})
  return { version: 1, devices: normalizeDevices(data.devices) }
}

export function recordDevice(principalId, { clientId, deviceId, name = '' } = {}) {
  if (!clientId) return null
  const data = readDevices(principalId)
  const key = deviceId || clientId
  data.devices[key] = {
    deviceId: key,
    clientId,
    name: name || deviceId || key || 'App',
    lastSeen: nowIso(),
  }
  ensureAppDir(principalId)
  writeJson(appFile(principalId, 'devices.json'), data)
  return data.devices[key]
}

export function listDevices(principalId) {
  return Object.values(readDevices(principalId).devices)
    .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen))
}

export function removeDevice(principalId, key) {
  const data = readDevices(principalId)
  const deviceId = Object.keys(data.devices).find(k =>
    k === key || data.devices[k]?.clientId === key
  )
  if (!deviceId) return false
  delete data.devices[deviceId]
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

// ── inbound idempotency ──────────────────────────────────────────────────────

function inboundFile(principalId) {
  return appFile(principalId, 'inbound.json')
}

export function hasInboundId(principalId, clientMessageId) {
  const id = String(clientMessageId || '').trim()
  if (!id) return false
  const data = readJson(inboundFile(principalId), { version: 1, ids: [] })
  return (data.ids || []).some(item => item.id === id)
}

export function rememberInboundId(principalId, clientMessageId) {
  const id = String(clientMessageId || '').trim()
  if (!id) return
  const data = readJson(inboundFile(principalId), { version: 1, ids: [] })
  const ids = Array.isArray(data.ids) ? data.ids.filter(item => item.id !== id) : []
  ids.push({ id, at: nowIso() })
  writeJson(inboundFile(principalId), { version: 1, ids: ids.slice(-300) })
}

// ── read state ───────────────────────────────────────────────────────────────

function readStateFile(principalId) {
  return appFile(principalId, 'read.json')
}

export function readAppReadState(principalId) {
  const data = readJson(readStateFile(principalId), { version: 1, sessions: {} })
  return { version: 1, sessions: (data.sessions && typeof data.sessions === 'object') ? data.sessions : {} }
}

export function getReadCursor(principalId, sessionId) {
  const state = readAppReadState(principalId)
  const item = state.sessions[String(sessionId || '')]
  return item ? Math.max(0, Number(item.cursor) || 0) : 0
}

export function markRead(principalId, sessionId, cursor) {
  const id = String(sessionId || '').trim()
  if (!id) return 0
  const value = Math.max(0, Number(cursor) || 0)
  const state = readAppReadState(principalId)
  const previous = state.sessions[id]
  const next = Math.max(value, previous ? Number(previous.cursor) || 0 : 0)
  state.sessions[id] = { cursor: next, updatedAt: nowIso() }
  writeJson(readStateFile(principalId), state)
  return next
}

export { appDir }
