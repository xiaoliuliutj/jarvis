/**
 * 从 Claude Agent SDK 的会话 transcript 里读取逐次 LLM 调用的 usage。
 *
 * SDK 的流式 assistant 事件会按 content block 重复出现，且部分 provider
 * 在流事件里只给 input/cache、output 为 0；transcript 里保存的是每次
 * API 响应的完整 usage。这里按 message.id 合并同一响应的多个 block。
 *
 * 只读取本机当前用户的 transcript，不读取其他用户数据，也不外传。
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')
const USAGE_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
]

function findTranscriptFile(sessionId) {
  if (!sessionId || !fs.existsSync(PROJECTS_DIR)) return null
  let entries = []
  try {
    entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(PROJECTS_DIR, entry.name, `${sessionId}.jsonl`)
    if (fs.existsSync(file)) return file
  }
  return null
}

// file -> { offset: number, remainder: string }
// 只读取每回合新增的 transcript，避免每次翻 16MB 拖慢回复。
const transcriptCache = new Map()

function readBytes(file, start) {
  const stat = fs.statSync(file)
  if (start >= stat.size) return { text: '', size: stat.size }
  const fd = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(stat.size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    return { text: buffer.toString('utf8'), size: stat.size }
  } finally {
    fs.closeSync(fd)
  }
}

function readNewTranscriptText(file, maxBytes) {
  const stat = fs.statSync(file)
  const cached = transcriptCache.get(file)
  let start
  let prefix = ''
  if (cached && stat.size >= cached.offset) {
    start = cached.offset
    prefix = cached.remainder || ''
  } else {
    start = Math.max(0, stat.size - maxBytes)
  }

  const { text: raw, size } = readBytes(file, start)
  let text = prefix + raw
  // 首次从文件中段开始时，第一行可能被截断
  if (!cached && start > 0) {
    const firstNewline = text.indexOf('\n')
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : ''
  }
  if (!text) {
    transcriptCache.set(file, { offset: size, remainder: '' })
    return ''
  }

  const lines = text.split('\n')
  const remainder = lines.pop() || ''
  const complete = lines.length ? lines.join('\n') + '\n' : ''
  const consumed = start
    + Buffer.byteLength(text, 'utf8')
    - Buffer.byteLength(remainder, 'utf8')
  transcriptCache.set(file, { offset: consumed, remainder })
  return complete
}

/**
 * @param {string} sessionId
 * @param {{ sinceMs?: number, maxBytes?: number }} options
 * @returns {Array<{ts, usage, model, tools, subagent}>}
 */
export function readTranscriptUsage(sessionId, { sinceMs = 0, maxBytes = 16 * 1024 * 1024 } = {}) {
  const file = findTranscriptFile(sessionId)
  if (!file) return []
  let text = ''
  try {
    text = readNewTranscriptText(file, maxBytes)
  } catch {
    return []
  }
  if (!text) return []

  const byMessage = new Map()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type !== 'assistant' || !entry.message?.usage) continue
    const tsMs = Date.parse(entry.timestamp)
    if (Number.isFinite(tsMs) && tsMs < sinceMs) continue
    const usage = entry.message.usage
    const key = entry.message.id || entry.uuid
    if (!key) continue
    const content = Array.isArray(entry.message.content) ? entry.message.content : []
    const tools = content
      .filter(block => block.type === 'tool_use')
      .map(block => block.name)
      .filter(Boolean)

    if (!byMessage.has(key)) {
      byMessage.set(key, {
        messageId: key,
        ts: entry.timestamp || new Date().toISOString(),
        usage: {
          input_tokens: Number(usage.input_tokens) || 0,
          output_tokens: Number(usage.output_tokens) || 0,
          cache_creation_input_tokens: Number(usage.cache_creation_input_tokens) || 0,
          cache_read_input_tokens: Number(usage.cache_read_input_tokens) || 0,
        },
        model: entry.message.model || '',
        tools: [...new Set(tools)],
        subagent: !!entry.isSidechain,
      })
    } else {
      const existing = byMessage.get(key)
      for (const field of USAGE_FIELDS) {
        existing.usage[field] = Math.max(existing.usage[field], Number(usage[field]) || 0)
      }
      for (const tool of tools) {
        if (!existing.tools.includes(tool)) existing.tools.push(tool)
      }
      existing.subagent = existing.subagent || !!entry.isSidechain
    }
  }

  return [...byMessage.values()]
    .filter(event => Object.values(event.usage).some(value => value > 0))
    .sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0))
}
