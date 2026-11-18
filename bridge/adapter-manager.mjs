/**
 * adapter-manager.mjs
 *
 * 单激活 adapter + 超时自动释放 + 消息队列。
 * 同一时间只有一个 adapter 处于激活状态，其他 adapter 的消息排队等待。
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getAdapterCwd, ensureAdapterCwdDir } from './anchor-session.mjs'
import { readCurrentSession, appendSessionMessage, readWorkspaceDirs, DEFAULT_WORKSPACE } from '../agents/claude-cc/memory-store.mjs'

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url))

// ── 运行时状态 ─────────────────────────────────────────────────────────────────

let activeAdapterId = null       // 当前激活的 adapter，null = 空闲
let activeRunPromise = null      // 当前在跑的 agent.run Promise（用于防止 release 中途打断）
let inactivityTimer = null       // 超时计时器句柄
const queues = new Map()         // adapterId → [{ payload, resolve, reject, messageId, enqueuedAt }]

// 外部注入：broadcast 函数（server.mjs 初始化时设置）
let broadcastFn = null
// 外部注入：adapters 映射（adapterId → { send }）
let adaptersSendMap = null
// Bridge 配置（由 init() 写入）
let bridgeConfig = null

// ── 初始化 ────────────────────────────────────────────────────────────────────

/**
 * 初始化 adapter-manager。
 * @param {{ broadcast: Function, adapters: Object, config: Object }} opts
 */
export function init({ broadcast, adapters, config }) {
  broadcastFn = broadcast
  adaptersSendMap = adapters
  bridgeConfig = config
}

// ── 读取 agent 配置 ───────────────────────────────────────────────────────────

function loadAgentConfig() {
  const configPath = path.join(BRIDGE_DIR, '..', 'config', 'agent.json')
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch {
    return {}
  }
}

// ── 核心路由 ──────────────────────────────────────────────────────────────────

/**
 * 外部消息入口。立即返回 { messageId, status }，agent 结果通过 broadcast 推送。
 * @param {string} adapterId
 * @param {{ from: string, text: string, attachments?: any[], timestamp?: string }} payload
 * @returns {{ messageId: string, status: 'running'|'queued' }}
 */
export function routeMessage(adapterId, payload) {
  const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  // 广播 incoming，让渲染层显示用户发来的消息（无论走 HTTP 还是 adapter 长轮询路径）
  broadcast({ type: 'incoming', adapterId, payload })

  if (!queues.has(adapterId)) queues.set(adapterId, [])

  const canRunNow = (activeAdapterId === null || activeAdapterId === adapterId)
    && activeRunPromise === null

  if (canRunNow) {
    activeAdapterId = adapterId
    broadcast({ type: 'active', adapterId })
    resetInactivityTimer()
    // 异步执行，不阻塞路由返回
    runWithAdapter(adapterId, payload, messageId).catch(err => {
      console.error(`[adapter-manager] runWithAdapter error (${adapterId}):`, err.message)
    })
    return { messageId, status: 'running' }
  } else {
    const queue = queues.get(adapterId)
    const position = Array.from(queues.values()).reduce((sum, q) => sum + q.length, 0)
    queue.push({ payload, messageId, enqueuedAt: Date.now() })
    broadcast({ type: 'queued', adapterId, position: position + 1, messageId })
    return { messageId, status: 'queued' }
  }
}

// ── 实际运行 ──────────────────────────────────────────────────────────────────

async function runWithAdapter(adapterId, payload, messageId) {
  ensureAdapterCwdDir(adapterId)
  const adapterCwd = getAdapterCwd(adapterId)  // 用于 session 存储（cwdHash 隔离）

  // 实际工作目录：从 config/workspace.json 取第一个非默认目录，回退到 E:\Jarvis
  const workspaceDirs = readWorkspaceDirs()
  const workCwd = workspaceDirs.find(d => d !== DEFAULT_WORKSPACE)
    || path.join(BRIDGE_DIR, '..')  // 回退到 E:\Jarvis

  const agentConfig = loadAgentConfig()
  const adapterConfig = bridgeConfig?.adapters?.[adapterId] ?? {}
  const apiKey = agentConfig.env?.ANTHROPIC_AUTH_TOKEN
    || agentConfig.env?.ANTHROPIC_API_KEY
    || agentConfig.apiKey
    || ''
  const baseUrl = agentConfig.env?.ANTHROPIC_BASE_URL || ''
  const model = agentConfig.model || agentConfig.env?.ANTHROPIC_MODEL || 'claude-sonnet-5-5'
  const permissionMode = adapterConfig.permissionMode || 'rulesOnly'
  const isMain = adapterConfig.isMain !== false  // 默认 true，所有 adapter 锚会话等同主会话权限
  const systemPromptAppend = [
    adapterConfig.systemPrompt || '',
    `\n## 工作目录\n你的工作目录是 ${workCwd}，所有文件操作默认基于此路径。`,
  ].filter(Boolean).join('\n')

  if (!apiKey) {
    broadcast({
      type: 'result', adapterId, messageId,
      from: payload.from, text: '未配置 API Key，无法处理请求。', cost: 0, turns: 0, isError: true,
    })
    return
  }

  const { run } = await import('../agents/claude-cc/agent.mjs')
  const enrichedPrompt = `[来自 ${adapterId}，发送人: ${payload.from}]\n${payload.text}`

  // 写入用户消息到会话历史
  const currentSession = readCurrentSession(adapterCwd)
  const sessionIdForRecord = currentSession?.sessionId

  if (sessionIdForRecord) {
    appendSessionMessage(adapterCwd, sessionIdForRecord, {
      type: 'user',
      text: payload.text,
      from: payload.from,
      timestamp: payload.timestamp,
    })
  }

  let resultPayload = null
  let resultReturned = false  // 防止 result 已返回后确认消息还被发出
  let pendingTimer = null

  // 10 秒后 agent 还没返回 result，用大模型生成一条确认消息发给用户
  const pendingTimeoutMs = adapterConfig.pendingTimeoutMs ?? 10000
  if (adapterConfig.pendingTimeoutMs !== 0) {
    pendingTimer = setTimeout(async () => {
      try {
        if (resultReturned) return  // result 已返回，不发确认
        const { default: Anthropic } = await import('@anthropic-ai/sdk')
        const client = new Anthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) })
        const resp = await client.messages.create({
          model,
          max_tokens: 60,
          system: systemPromptAppend || undefined,
          messages: [{
            role: 'user',
            content: `用户刚才发了一条消息："${payload.text}"，你正在处理中，还需要一些时间。请用一句简短自然的话告诉用户你在处理，不超过20字。直接输出这句话，不要加任何前缀或解释。`,
          }],
        })
        if (resultReturned) return  // API 调用期间 result 已返回，取消发送
        const pendingText = resp.content.find(b => b.type === 'text')?.text?.trim()
        if (pendingText) {
          const adapterMod = adaptersSendMap?.[adapterId]
          if (adapterMod?.send) {
            await adapterMod.send(payload.from, pendingText).catch(() => {})
          }
          broadcast({ type: 'pending', adapterId, messageId, from: payload.from, text: pendingText })
        }
      } catch (err) {
        console.error('[adapter-manager] pending message error:', err.message)
      }
    }, pendingTimeoutMs)
  }

  activeRunPromise = (async () => {
    for await (const event of run(enrichedPrompt, {
      model,
      permissionMode,
      apiKey,
      baseUrl,
      cwd: adapterCwd,
      isMain,
      workDirs: [],
      systemPromptAppend,
      jarvisCodeWritable: false,  // 非 PC adapter 不允许写 Jarvis 项目文件
    })) {
      if (event.type === 'tool') {
        broadcast({ type: 'tool', adapterId, messageId, name: event.name, input: event.input })
      } else if (event.type === 'memory') {
        broadcast({ type: 'memory', adapterId, messageId, ...event })
      } else if (event.type === 'result') {
        clearTimeout(pendingTimer)  // result 到达，立即取消确认消息计时器
        pendingTimer = null
        resultReturned = true
        resultPayload = event
      }
    }
  })()

  try {
    await activeRunPromise
  } finally {
    clearTimeout(pendingTimer)
    activeRunPromise = null
  }

  if (resultPayload) {
    // 写入 assistant 回复到会话历史
    // sessionId 可能在 run() 里才被分配（首次会话），用 resultPayload.sessionId
    const finalSessionId = resultPayload.sessionId || sessionIdForRecord
    if (finalSessionId) {
      // 若首次会话，补写 user 消息（此时才有 sessionId）
      if (!sessionIdForRecord) {
        appendSessionMessage(adapterCwd, finalSessionId, {
          type: 'user',
          text: payload.text,
          from: payload.from,
          timestamp: payload.timestamp,
        })
      }
      appendSessionMessage(adapterCwd, finalSessionId, {
        type: 'assistant',
        text: resultPayload.text,
        timestamp: new Date().toISOString(),
      })
    }

    broadcast({
      type: 'result',
      adapterId,
      messageId,
      from: payload.from,
      text: resultPayload.text,
      cost: resultPayload.cost,
      turns: resultPayload.turns,
      sessionId: resultPayload.sessionId,
      isError: resultPayload.isError ?? false,
    })
    // 把回复发回原平台
    const adapterMod = adaptersSendMap?.[adapterId]
    if (adapterMod?.send && resultPayload.text && !resultPayload.isError) {
      adapterMod.send(payload.from, resultPayload.text).catch(err => {
        console.error(`[adapter-manager] send reply error (${adapterId}):`, err.message)
      })
    }
  }

  // 重置超时，准备接受下一条消息
  resetInactivityTimer()
  drainNextQueued().catch(console.error)
}

/**
 * Cron 专用：直接运行 agent，不走队列，返回回复文本。
 * 结果不通过 adapter send 发出（由 cron-manager 负责发送）。
 */
export async function runAdapterDirect(adapterId, payload) {
  ensureAdapterCwdDir(adapterId)
  const adapterCwd = getAdapterCwd(adapterId)

  const agentConfig = loadAgentConfig()
  const adapterConfig = bridgeConfig?.adapters?.[adapterId] ?? {}
  const apiKey = agentConfig.env?.ANTHROPIC_AUTH_TOKEN
    || agentConfig.env?.ANTHROPIC_API_KEY
    || agentConfig.apiKey
    || ''
  const baseUrl = agentConfig.env?.ANTHROPIC_BASE_URL || ''
  const model = agentConfig.model || agentConfig.env?.ANTHROPIC_MODEL || 'claude-sonnet-5-5'
  const permissionMode = adapterConfig.permissionMode || 'rulesOnly'
  const isMain = adapterConfig.isMain !== false
  const workspaceDirs = readWorkspaceDirs()
  const workCwd = workspaceDirs.find(d => d !== DEFAULT_WORKSPACE) || path.join(BRIDGE_DIR, '..')
  const systemPromptAppend = [
    adapterConfig.systemPrompt || '',
    `\n## 工作目录\n你的工作目录是 ${workCwd}，所有文件操作默认基于此路径。`,
  ].filter(Boolean).join('\n')

  if (!apiKey) return ''

  const messageId = `cron-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  broadcast({ type: 'incoming', adapterId, payload: { from: '__cron__', text: payload.text } })

  const { run } = await import('../agents/claude-cc/agent.mjs')
  let resultText = ''

  for await (const event of run(payload.text, {
    model, permissionMode, apiKey, baseUrl,
    cwd: adapterCwd, isMain, workDirs: [],
    systemPromptAppend, jarvisCodeWritable: false,
  })) {
    if (event.type === 'tool') {
      broadcast({ type: 'tool', adapterId, messageId, name: event.name, input: event.input })
    } else if (event.type === 'result' && !event.isError) {
      resultText = event.text
      broadcast({ type: 'result', adapterId, messageId, from: '__cron__', text: resultText, cost: event.cost, turns: event.turns, isError: false })
    }
  }

  return resultText
}

// ── 超时与释放 ────────────────────────────────────────────────────────────────

function resetInactivityTimer() {
  clearTimeout(inactivityTimer)
  const timeoutMs = bridgeConfig?.inactivityTimeoutMs ?? 300_000
  inactivityTimer = setTimeout(() => {
    releaseAdapter(activeAdapterId, 'timeout')
  }, timeoutMs)
}

/**
 * 释放激活权。若当前有任务在跑则等任务结束后再释放（不中途打断）。
 */
function releaseAdapter(adapterId, reason = 'manual') {
  if (adapterId == null || adapterId !== activeAdapterId) return
  if (activeRunPromise !== null) {
    // 任务还在跑，等结束后由 drainNextQueued 自然释放
    return
  }
  clearTimeout(inactivityTimer)
  inactivityTimer = null
  activeAdapterId = null
  broadcast({ type: 'released', adapterId, reason })
}

export function getStatus() {
  const queueInfo = {}
  for (const [id, q] of queues.entries()) {
    queueInfo[id] = { queued: q.length }
  }
  return {
    activeAdapter: activeAdapterId,
    inactivityTimeoutMs: bridgeConfig?.inactivityTimeoutMs ?? 300_000,
    adapters: queueInfo,
  }
}

// ── 队列出队 ──────────────────────────────────────────────────────────────────

async function drainNextQueued() {
  if (activeRunPromise !== null) return  // 还有任务在跑

  // 找所有队列中最早入队的那一条
  let earliest = null
  let earliestAdapterId = null
  for (const [id, queue] of queues.entries()) {
    if (queue.length === 0) continue
    const head = queue[0]
    if (!earliest || head.enqueuedAt < earliest.enqueuedAt) {
      earliest = head
      earliestAdapterId = id
    }
  }

  if (!earliest) {
    // 所有队列空，释放激活
    releaseAdapter(activeAdapterId, 'queue-empty')
    return
  }

  // 取出并执行
  const queue = queues.get(earliestAdapterId)
  queue.shift()

  activeAdapterId = earliestAdapterId
  broadcast({ type: 'active', adapterId: earliestAdapterId })
  resetInactivityTimer()

  await runWithAdapter(earliestAdapterId, earliest.payload, earliest.messageId)
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function broadcast(event) {
  broadcastFn?.(event)
}
