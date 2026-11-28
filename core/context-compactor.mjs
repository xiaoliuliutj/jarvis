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
import { syncScheduleMemory } from './schedule-memory.mjs'
import { logInfo, logWarn } from './logger.mjs'

const RECENT_TAIL = 6
// 每批最多 100 条消息；一次压缩最多跑 5 批 / 90 秒。
// 从上次 compactedUpto 开始逐批推进，不再跳过中间消息。
const MAX_MESSAGES_PER_COMPACT = 100
const MAX_BATCHES_PER_COMPACT = 5
const MAX_COMPACT_MS = 90_000
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

// 摘要调用失败时：保留旧摘要，再追加本批的原文摘录；绝不直接覆盖旧摘要。
function mergeFallbackDigest(existingDigest, messages) {
  const base = String(existingDigest || '').trim()
  const excerpt = fallbackDigest(messages)
  if (!base) return excerpt.slice(0, MAX_DIGEST_CHARS)
  const room = Math.max(0, MAX_DIGEST_CHARS - base.length - 2)
  if (!room) return base.slice(0, MAX_DIGEST_CHARS)
  return `${base}\n\n${excerpt.slice(0, room)}`.slice(0, MAX_DIGEST_CHARS)
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
 * @returns {Promise<null|{digest, compactedUpto, handoffBlock, partial}>}
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
  if (end <= 0) return null

  const handoffBlock = formatHandoff(allMessages.slice(end))
  let digest = state.digest
  // 从上次处理到的位置开始逐批推进，绝不跳过中间消息。
  const startAt = Math.min(Math.max(Number(state.compactedUpto) || 0, 0), end)
  let cursor = startAt
  let batches = 0
  const startedAt = Date.now()

  while (
    cursor < end
    && batches < MAX_BATCHES_PER_COMPACT
    && Date.now() - startedAt < MAX_COMPACT_MS
  ) {
    const to = Math.min(cursor + MAX_MESSAGES_PER_COMPACT, end)
    const batch = allMessages.slice(cursor, to)
    const conversation = formatConversation(batch)
    if (conversation) {
      const prompt = [
        digest ? `【已有长期摘要】\n${digest}` : '',
        `【本次需要压缩的对话】\n${conversation}`,
        '更早的历史消息如果不在上面，视为已由长期记忆覆盖。',
        '请输出更新后的长期记忆摘要。',
      ].filter(Boolean).join('\n\n')
      try {
        const summary = await summarizeText({ apiKey, baseUrl, authMode, model, prompt })
        digest = summary || mergeFallbackDigest(digest, batch)
      } catch (err) {
        logWarn('context.compact.summary.fail', err.message, {
          principalId,
          fromMessage: cursor,
          toMessage: to,
        })
        digest = mergeFallbackDigest(digest, batch)
      }
      batches += 1
    }
    cursor = to
  }

  digest = String(digest || '').trim().slice(0, MAX_DIGEST_CHARS)
  if (!digest) {
    // 整段都是工具记录等没有摘要的情况：推进游标，但不触发换挡。
    if (cursor !== state.compactedUpto) {
      writeSessionDigestState(principalId, displaySessionId, {
        digest: '',
        compactedUpto: cursor,
      })
    }
    return null
  }

  upsertSessionSummary(principalId, displaySessionId, `【会话压缩摘要】\n${digest}`)
  // 压缩时顺带同步「日程」概念：按 schedule:<id> 去重更新，不重复追加
  try {
    syncScheduleMemory(principalId)
  } catch (err) {
    logWarn('schedule.memory.sync.fail', err.message, { principalId })
  }
  writeSessionDigestState(principalId, displaySessionId, {
    digest,
    compactedUpto: cursor,
  })
  logInfo('context.compact', '', {
    principalId,
    sessionId: displaySessionId,
    fromMessage: startAt,
    toMessage: cursor,
    batches,
    remaining: Math.max(0, end - cursor),
    digestChars: digest.length,
  })

  return {
    digest,
    compactedUpto: cursor,
    handoffBlock,
    partial: cursor < end,
  }
}
