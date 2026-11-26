/**
 * 上下文压缩：把较早的对话压成长期记忆摘要，并为新的 Agent 会话准备最近对话交接。
 *
 * 只读取当前 principal 的会话和记忆；摘要写回该 principal 的长期记忆。
 */

import {
  readMessages,
  readSessionDigestState,
  writeSessionDigestState,
  upsertSessionSummary,
} from './user-store.mjs'
import { logInfo, logWarn } from './logger.mjs'

const RECENT_TAIL = 6
const MAX_MESSAGES_PER_COMPACT = 100
const MAX_MESSAGE_CHARS = 500
const MAX_PROMPT_CHARS = 60000
const MAX_DIGEST_CHARS = 4000
const MAX_HANDOFF_CHARS = 3000

const SUMMARY_SYSTEM = `你是 Jarvis 的上下文压缩器。请把较早的对话压缩成一段长期记忆摘要，供后续对话继续使用。
保留：用户偏好、重要事实、正在进行/未完成的任务、关键文件路径、重要决定、最近话题。
不要保留：寒暄、重复内容、工具调用细节、密钥、token、凭证。
用中文输出 500-1200 字的纯文本，不要 Markdown 表格，不要写“以下是摘要”之类的前缀。`

function messageText(item) {
  if (!item || typeof item.text !== 'string') return ''
  return item.text.replace(/\s+/g, ' ').trim()
}

function formatConversation(messages) {
  const lines = []
  let total = 0
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i]
    if (!item || (item.type !== 'user' && item.type !== 'assistant')) continue
    const text = messageText(item)
    if (!text) continue
    const line = `[${item.type === 'user' ? '用户' : 'Jarvis'}] ${text.slice(0, MAX_MESSAGE_CHARS)}`
    if (total + line.length > MAX_PROMPT_CHARS) break
    lines.unshift(line)
    total += line.length + 1
  }
  return lines.join('\n')
}

function fallbackDigest(messages) {
  const tail = messages
    .filter(item => item && (item.type === 'user' || item.type === 'assistant'))
    .slice(-20)
  const body = tail.map(item => (
    `[${item.type === 'user' ? '用户' : 'Jarvis'}] ${messageText(item).slice(0, 120)}`
  )).filter(Boolean).join('\n')
  return `（自动压缩摘录）\n${body}`
}

async function summarizeText({ apiKey, baseUrl, authMode, model, prompt }) {
  const base = String(baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')
  const endpoint = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
  if (authMode === 'auth_token') {
    headers.authorization = `Bearer ${apiKey}`
  } else if (authMode === 'api_key') {
    headers['x-api-key'] = apiKey
  } else {
    headers['x-api-key'] = apiKey
    headers.authorization = `Bearer ${apiKey}`
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        system: SUMMARY_SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const data = await response.json()
    return (data.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
  } finally {
    clearTimeout(timer)
  }
}

function formatHandoff(messages) {
  const lines = []
  for (const item of messages) {
    if (!item || (item.type !== 'user' && item.type !== 'assistant')) continue
    const text = messageText(item)
    if (!text) continue
    lines.push(`[${item.type === 'user' ? '用户' : 'Jarvis'}] ${text.slice(0, 500)}`)
  }
  const body = lines.join('\n').slice(-MAX_HANDOFF_CHARS)
  return body
    ? `【上下文压缩交接｜以下是你进入新上下文前的最近对话，仅用于延续语境】\n${body}\n【当前用户消息】\n`
    : ''
}

/**
 * @returns {Promise<null|{digest, compactedUpto, handoffBlock}>}
 */
export async function compactSessionContext({
  principalId,
  displaySessionId,
  apiKey,
  baseUrl,
  authMode,
  model,
}) {
  if (!principalId || !displaySessionId) return null
  const allMessages = readMessages(principalId, displaySessionId)
  if (!allMessages.length) return null

  const state = readSessionDigestState(principalId, displaySessionId)
  const end = Math.max(0, allMessages.length - RECENT_TAIL)
  const start = Math.max(
    state.compactedUpto,
    end - MAX_MESSAGES_PER_COMPACT,
  )
  if (end <= 0) return null

  const slice = allMessages.slice(start, end)
  if (!slice.length && !state.digest) return null

  const handoffBlock = formatHandoff(allMessages.slice(end))
  let digest = state.digest
  if (slice.length) {
    const conversation = formatConversation(slice)
    const prompt = [
      state.digest ? `【已有长期摘要】\n${state.digest}` : '',
      `【本次需要压缩的对话】\n${conversation || '（没有可用的文本消息）'}`,
      '更早的历史消息如果不在上面，视为已由长期记忆覆盖。',
      '请输出更新后的长期记忆摘要。',
    ].filter(Boolean).join('\n\n')

    try {
      const summary = await summarizeText({ apiKey, baseUrl, authMode, model, prompt })
      if (summary) digest = summary
      else digest = fallbackDigest(slice)
    } catch (err) {
      logWarn('context.compact.summary.fail', err.message, { principalId })
      digest = fallbackDigest(slice)
    }
  }

  digest = String(digest || '').trim().slice(0, MAX_DIGEST_CHARS)
  if (!digest) return null

  upsertSessionSummary(principalId, displaySessionId, `【会话压缩摘要】\n${digest}`)
  writeSessionDigestState(principalId, displaySessionId, {
    digest,
    compactedUpto: end,
  })
  logInfo('context.compact', '', {
    principalId,
    sessionId: displaySessionId,
    fromMessage: start,
    toMessage: end,
    digestChars: digest.length,
  })

  return { digest, compactedUpto: end, handoffBlock }
}
