/**
 * 每个 principal 的独立存储。
 *
 * userdata/<principalId>/
 *   persona.md
 *   sessions/index.json + <sessionId>.messages.jsonl
 *   workspace/
 *   memory/long-term.jsonl
 *   crons.json
 *   schedules.json
 *
 * 说明：
 *   - 这是个人项目，写文件用同步 writeFile/appendFile 即可；
 *     同一 principal 的并发由 core/conversation 的锁保证。
 *   - 主会话和用户使用完全相同的结构，只是 principalId 不同。
 */

import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  USERDATA_DIR,
  ensureDir,
  principalDir,
  sessionsDir,
  workspaceDir,
  memoryFile,
  personaFile,
  cronsFile,
  schedulesFile,
} from './paths.mjs'
import { readRules } from './config.mjs'
import { DEFAULT_PERSONA } from './persona-presets.mjs'

export { workspaceDir }

const LOW_WEIGHT_THRESHOLD = 0.3

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

function writeJson(file, value) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8')
}

// ── 初始化 ────────────────────────────────────────────────────────────────────

export function ensureUser(principalId) {
  ensureDir(principalDir(principalId))
  ensureDir(sessionsDir(principalId))
  ensureDir(workspaceDir(principalId))
  ensureDir(path.dirname(memoryFile(principalId)))

  if (!fs.existsSync(personaFile(principalId))) {
    fs.writeFileSync(personaFile(principalId), DEFAULT_PERSONA, 'utf-8')
  }
  if (!fs.existsSync(memoryFile(principalId))) {
    fs.writeFileSync(memoryFile(principalId), '', 'utf-8')
  }
  if (!fs.existsSync(cronsFile(principalId))) {
    writeJson(cronsFile(principalId), [])
  }
  if (!fs.existsSync(schedulesFile(principalId))) {
    writeJson(schedulesFile(principalId), [])
  }
}

// ── Persona / 全局 rules ──────────────────────────────────────────────────────

export function readPersona(principalId) {
  ensureUser(principalId)
  return fs.readFileSync(personaFile(principalId), 'utf-8')
}

export function writePersona(principalId, content) {
  ensureUser(principalId)
  fs.writeFileSync(personaFile(principalId), content, 'utf-8')
}

export function readRulesText() {
  return readRules()
}

// ── 会话 ──────────────────────────────────────────────────────────────────────

function indexFile(principalId) {
  return path.join(sessionsDir(principalId), 'index.json')
}

function messagesFile(principalId, sessionId) {
  return path.join(sessionsDir(principalId), `${sessionId}.messages.jsonl`)
}

export function listSessions(principalId) {
  ensureUser(principalId)
  const sessions = readJson(indexFile(principalId), [])
  return sessions.sort((a, b) => new Date(b.lastActiveAt) - new Date(a.lastActiveAt))
}

export function getSession(principalId, sessionId) {
  return listSessions(principalId).find(s => s.sessionId === sessionId) || null
}

export function getCurrentSession(principalId) {
  return listSessions(principalId).find(s => s.isCurrent) || null
}

export function createSession(principalId, sessionId, { name = '新会话', isMain = false, makeCurrent = true } = {}) {
  ensureUser(principalId)
  const sessions = listSessions(principalId)
  if (makeCurrent) sessions.forEach(s => { s.isCurrent = false })
  const session = {
    sessionId,
    agentSessionId: sessionId,
    name,
    isMain,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    isCurrent: makeCurrent,
  }
  sessions.push(session)
  writeJson(indexFile(principalId), sessions)
  return session
}

/** 如果会话不存在则创建，存在则 touch。新会话的名称取第一条用户消息。 */
export function ensureSession(principalId, sessionId, { name = '新会话', isMain = false, makeCurrent = true } = {}) {
  const existing = getSession(principalId, sessionId)
  if (existing) {
    touchSession(principalId, sessionId)
    return existing
  }
  return createSession(principalId, sessionId, { name, isMain, makeCurrent })
}

export function touchSession(principalId, sessionId) {
  const sessions = listSessions(principalId)
  const session = sessions.find(s => s.sessionId === sessionId)
  if (!session) return
  session.lastActiveAt = new Date().toISOString()
  writeJson(indexFile(principalId), sessions)
}

export function setCurrentSession(principalId, sessionId) {
  const sessions = listSessions(principalId)
  sessions.forEach(s => { s.isCurrent = s.sessionId === sessionId })
  writeJson(indexFile(principalId), sessions)
}

export function renameSession(principalId, sessionId, name) {
  const sessions = listSessions(principalId)
  const session = sessions.find(s => s.sessionId === sessionId)
  if (!session) return
  session.name = name
  writeJson(indexFile(principalId), sessions)
}

/** 显示会话 ID 与 Agent SDK 会话 ID 分开保存：上下文压缩时只换 Agent 会话，不清空 App 历史。 */
export function setSessionAgentId(principalId, sessionId, agentSessionId) {
  const sessions = listSessions(principalId)
  const session = sessions.find(s => s.sessionId === sessionId)
  if (!session) return null
  session.agentSessionId = agentSessionId
  writeJson(indexFile(principalId), sessions)
  return session
}

// ── 会话提示词快照 ────────────────────────────────────────────────────────────
// system prompt 里的长期记忆在会话内冻结：
//   - 记忆写入照常落库（appendMemory）
//   - 但只有历史压缩/换挡（agentSessionId 变化）时才重建快照
// 这样 system prompt 字节级稳定，缓存前缀不会被每轮记忆更新打断。

function promptSnapshotFile(principalId, sessionId) {
  return path.join(sessionsDir(principalId), `${sessionId}.prompt.json`)
}

export function readPromptSnapshot(principalId, sessionId) {
  if (!principalId || !sessionId) return null
  const data = readJson(promptSnapshotFile(principalId, sessionId), null)
  if (!data || typeof data.memoryText !== 'string') return null
  return {
    memoryText: data.memoryText,
    agentSessionId: typeof data.agentSessionId === 'string' ? data.agentSessionId : null,
    memoryTokens: Number(data.memoryTokens) || 0,
    builtAt: data.builtAt || null,
  }
}

export function writePromptSnapshot(principalId, sessionId, { memoryText = '', agentSessionId = null } = {}) {
  if (!principalId || !sessionId) return null
  const text = String(memoryText || '')
  const snapshot = {
    memoryText: text,
    agentSessionId: agentSessionId || null,
    memoryTokens: estimateMemoryTokens(text),
    builtAt: new Date().toISOString(),
  }
  writeJson(promptSnapshotFile(principalId, sessionId), snapshot)
  return snapshot
}

// ── 最近一次定时任务结果 ─────────────────────────────────────────────────────
// cron 结果写进聊天显示层，但用的是独立 Agent 会话；聊天 Agent 下一轮看不到。
// 这里存最近一条，聊天回合以「尾部拼接」的方式带上，避免追问时接不上。
function lastCronResultFile(principalId) {
  return path.join(principalDir(principalId), 'cron-last-result.json')
}

export function readLastCronResult(principalId) {
  const data = readJson(lastCronResultFile(principalId), null)
  if (!data || typeof data.text !== 'string') return null
  return {
    text: data.text,
    at: data.at || null,
    source: data.source || 'cron',
  }
}

export function writeLastCronResult(principalId, { text = '', at = new Date().toISOString(), source = 'cron' } = {}) {
  const body = String(text || '').trim()
  if (!body) return null
  const data = { text: body, at, source }
  writeJson(lastCronResultFile(principalId), data)
  return data
}

// 定时任务执行历史：写进 workspace 的 Markdown，方便事后查看，也能被 Agent 直接 Read。
export function appendCronHistory(principalId, {
  at = new Date().toISOString(),
  task = '定时任务',
  text = '',
  silent = false,
  isError = false,
  tools = [],
} = {}) {
  ensureUser(principalId)
  const when = new Date(at)
  const timeText = Number.isNaN(when.getTime())
    ? String(at)
    : when.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
  const body = String(text || '').trim()
    || (silent ? '（静默，无提醒）' : '（无输出）')
  const toolLine = Array.isArray(tools) && tools.length
    ? `\n- 工具：${tools.filter(Boolean).join(', ')}`
    : ''
  const section = `\n## ${timeText}｜${String(task || '定时任务').slice(0, 60)}\n- 状态：${isError ? '失败' : '成功'}${toolLine}\n\n${body}\n`
  const file = path.join(workspaceDir(principalId), 'cron-history.md')
  fs.appendFileSync(file, section, 'utf-8')
  return file
}

export function readSessionDigestState(principalId, sessionId) {
  const file = path.join(sessionsDir(principalId), `${sessionId}.digest.json`)
  const data = readJson(file, null)
  return {
    digest: typeof data?.digest === 'string' ? data.digest : '',
    compactedUpto: Number(data?.compactedUpto) || 0,
    updatedAt: data?.updatedAt || null,
  }
}

export function writeSessionDigestState(principalId, sessionId, { digest = '', compactedUpto = 0 } = {}) {
  ensureDir(sessionsDir(principalId))
  const file = path.join(sessionsDir(principalId), `${sessionId}.digest.json`)
  writeJson(file, {
    digest: String(digest || ''),
    compactedUpto: Math.max(0, Number(compactedUpto) || 0),
    updatedAt: new Date().toISOString(),
  })
}

export function appendMessage(principalId, sessionId, record) {
  ensureUser(principalId)
  const entry = record?.id ? record : { ...record, id: `msg_${randomUUID()}` }
  fs.appendFileSync(messagesFile(principalId, sessionId), JSON.stringify(entry) + '\n', 'utf-8')
  return entry
}

export function readMessages(principalId, sessionId) {
  const file = messagesFile(principalId, sessionId)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map((line, index) => {
      const record = JSON.parse(line)
      return {
        ...record,
        // 旧记录没有 id；用 sessionId:index 生成稳定 ID。seq 用于 App 增量同步。
        id: record.id || `${sessionId}:${index}`,
        seq: index,
      }
    })
}

/** 扫描所有 principal 目录（跳过 tools/_legacy 等非用户目录）。 */
export function listUserIds() {
  if (!fs.existsSync(USERDATA_DIR)) return []
  return fs.readdirSync(USERDATA_DIR)
    .filter(name => !name.startsWith('_') && name !== 'tools')
    .filter(name => fs.existsSync(path.join(USERDATA_DIR, name, 'sessions')))
}

// ── 长期记忆 ──────────────────────────────────────────────────────────────────

function calcWeight(entry) {
  const days = (Date.now() - new Date(entry.lastMentioned).getTime()) / 86_400_000
  return entry.mentions / Math.sqrt(days + 1)
}

export function readMemoryEntries(principalId) {
  ensureUser(principalId)
  const text = fs.readFileSync(memoryFile(principalId), 'utf-8')
  return text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
}

export function appendMemory(principalId, { content, type = 'fact', refs = [] }) {
  ensureUser(principalId)
  const entry = {
    id: randomUUID(),
    content,
    type,
    refs,
    mentions: 1,
    lastMentioned: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  }
  fs.appendFileSync(memoryFile(principalId), JSON.stringify(entry) + '\n', 'utf-8')
  return entry
}

/** 每个显示会话只保留一条压缩摘要，避免长期记忆无限膨胀。 */
export function upsertSessionSummary(principalId, sessionId, content) {
  ensureUser(principalId)
  const ref = `session:${sessionId}`
  const entries = readMemoryEntries(principalId).filter(entry => (
    !(entry.type === 'session_summary'
      && Array.isArray(entry.refs)
      && entry.refs.includes(ref))
  ))
  const entry = {
    id: randomUUID(),
    content,
    type: 'session_summary',
    refs: [ref],
    mentions: 1,
    lastMentioned: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  }
  entries.push(entry)
  fs.writeFileSync(
    memoryFile(principalId),
    entries.map(item => JSON.stringify(item)).join('\n') + (entries.length ? '\n' : ''),
    'utf-8',
  )
  return entry
}

// 长期记忆在上下文窗口中的预算：4% 以内原样保留，超过 4% 时压缩到 2%。
// 2% 作为保底预留，保证重要摘要不会被大量文件操作记录挤掉。
const MEMORY_MIN_RATIO = 0.02
const MEMORY_MAX_RATIO = 0.04
const MEMORY_CHARS_PER_TOKEN = 3
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200000

// 「近期文件操作」只是近况提示，不是履历：
//  - 进 prompt 的最多 40 个文件（按最近提及排序、按路径去重）
//  - 磁盘上的 memory 文件保持全量，不裁剪；磁盘空间足够，历史可回溯
const MAX_PROJECT_FILES_IN_PROMPT = 40

const MEMORY_SECTIONS = [
  ['preference', '用户偏好'],
  ['session_summary', '历史会话摘要'],
  ['fact', '记录的事实'],
  ['project_file', '近期文件操作'],
]

export function estimateMemoryTokens(text) {
  return Math.ceil(String(text || '').length / MEMORY_CHARS_PER_TOKEN)
}

export function resolveMemoryBudget(contextWindowTokens = 0) {
  const windowTokens = Number(contextWindowTokens) > 0
    ? Number(contextWindowTokens)
    : DEFAULT_CONTEXT_WINDOW_TOKENS
  return {
    contextWindowTokens: windowTokens,
    minTokens: Math.ceil(windowTokens * MEMORY_MIN_RATIO),
    maxTokens: Math.ceil(windowTokens * MEMORY_MAX_RATIO),
  }
}

function memoryLine(entry) {
  const refs = Array.isArray(entry.refs) ? entry.refs : []
  const suffix = entry.type === 'project_file' && refs.length ? ` [${refs.join(', ')}]` : ''
  return `- ${String(entry.content || '').trim()}${suffix}`
}

function renderMemorySections(sections) {
  const lines = ['## 长期记忆']
  for (const [key, title] of MEMORY_SECTIONS) {
    const list = sections[key] || []
    if (!list.length) continue
    lines.push(`\n### ${title}`)
    for (const entry of list) lines.push(memoryLine(entry))
  }
  return lines.join('\n')
}

function dedupeEntries(entries) {
  const seen = new Set()
  const result = []
  for (const entry of entries) {
    const content = String(entry.content || '').trim()
    if (!content || seen.has(content)) continue
    seen.add(content)
    result.push(entry)
  }
  return result
}

function dedupeProjectFiles(entries) {
  const byRef = new Map()
  for (const entry of entries) {
    const refs = Array.isArray(entry.refs) ? entry.refs : []
    const key = refs[0] || String(entry.content || '').trim()
    if (!key) continue
    const prev = byRef.get(key)
    const prevAt = prev ? Date.parse(prev.lastMentioned) || 0 : 0
    const nextAt = Date.parse(entry.lastMentioned) || 0
    if (!prev || nextAt >= prevAt) byRef.set(key, entry)
  }
  return [...byRef.values()].sort((a, b) => (
    (Date.parse(b.lastMentioned) || 0) - (Date.parse(a.lastMentioned) || 0)
    || String(b.id || '').localeCompare(String(a.id || ''))
  ))
}

function trimMemoryText(text, maxChars) {
  if (text.length <= maxChars) return text
  const note = '\n...[长期记忆已按上下文预算压缩]'
  const slice = text.slice(0, Math.max(0, maxChars - note.length))
  const cut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('。'), slice.lastIndexOf('；'))
  const body = cut > slice.length * 0.6 ? slice.slice(0, cut) : slice
  return `${body}${note}`
}

function compressMemorySections(sections, targetTokens, maxProjectFiles = MAX_PROJECT_FILES_IN_PROMPT) {
  const budgetChars = Math.max(0, Math.floor(targetTokens * MEMORY_CHARS_PER_TOKEN))
  const important = {
    session_summary: dedupeEntries(sections.session_summary || []),
    preference: dedupeEntries(sections.preference || []),
    fact: dedupeEntries(sections.fact || []),
    project_file: [],
  }
  const baseText = renderMemorySections(important)
  if (baseText.length >= budgetChars) {
    return trimMemoryText(baseText, budgetChars)
  }

  let used = baseText.length
  let headerAdded = false
  const selected = []
  for (const entry of dedupeProjectFiles(sections.project_file || []).slice(0, maxProjectFiles)) {
    const headerCost = headerAdded ? 0 : '\n### 近期文件操作'.length
    const line = memoryLine(entry)
    if (used + headerCost + line.length + 1 > budgetChars) break
    selected.push(entry)
    used += headerCost + line.length + 1
    headerAdded = true
  }
  if (!selected.length) return baseText
  return renderMemorySections({ ...important, project_file: selected })
}

/**
 * 格式化为 system prompt 片段。
 *
 * 预算按上下文窗口的 5%-10% 计算：
 *   - 低于 10%：原样保留，不压缩；
 *   - 超过 10%：压缩到 5%，优先保留用户偏好/会话摘要/事实，再保留最近的去重文件记录。
 */
export function formatMemory(principalId, options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const entries = readMemoryEntries(principalId)
  if (!entries.length) return ''

  const deterministic = opts.deterministic === true
  const maxProjectFiles = Math.max(1, Number(opts.maxProjectFiles) || MAX_PROJECT_FILES_IN_PROMPT)

  let ordered
  if (deterministic) {
    // 会话内冻结快照时，顺序必须只由存储顺序/创建时间决定，
    // 不能按「距今天数」加权排序——否则内容不变、顺序也会漂移，缓存前缀失效。
    ordered = entries
      .filter(e => String(e.content || '').trim())
      .sort((a, b) => {
        const ta = Date.parse(a.createdAt) || 0
        const tb = Date.parse(b.createdAt) || 0
        if (ta !== tb) return ta - tb
        return String(a.id || '').localeCompare(String(b.id || ''))
      })
  } else {
    ordered = entries
      .map(e => ({ ...e, weight: calcWeight(e) }))
      .filter(e => e.weight >= LOW_WEIGHT_THRESHOLD && String(e.content || '').trim())
      .sort((a, b) => b.weight - a.weight)
  }

  const sections = { project_file: [], preference: [], session_summary: [], fact: [] }
  for (const e of ordered) {
    const key = sections[e.type] ? e.type : 'fact'
    sections[key].push(e)
  }
  // 相同内容的偏好/事实/摘要只保留一条，避免重复条目占 prompt。
  sections.preference = dedupeEntries(sections.preference)
  sections.session_summary = dedupeEntries(sections.session_summary)
  sections.fact = dedupeEntries(sections.fact)
  // 文件操作只保留最近 N 个唯一文件，避免 1600 条记录塞满 prompt。
  sections.project_file = dedupeProjectFiles(sections.project_file).slice(0, maxProjectFiles)
  if (!MEMORY_SECTIONS.some(([key]) => sections[key].length)) return ''

  const budget = resolveMemoryBudget(opts.contextWindowTokens)
  const full = renderMemorySections(sections)
  if (estimateMemoryTokens(full) <= budget.maxTokens) return full
  return compressMemorySections(sections, budget.minTokens, maxProjectFiles)
}

// ── Cron ──────────────────────────────────────────────────────────────────────

export function readCrons(principalId) {
  ensureUser(principalId)
  return readJson(cronsFile(principalId), [])
}

export function writeCrons(principalId, crons) {
  ensureUser(principalId)
  writeJson(cronsFile(principalId), crons)
}

/** 最近一条用户消息的时间戳（ms）；没有则返回 null。用于「长时间没见」检测，Bridge 重启后也能恢复判断。 */
export function lastUserMessageAt(principalId) {
  const dir = sessionsDir(principalId)
  if (!fs.existsSync(dir)) return null
  let latest = null
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.messages.jsonl')) continue
    try {
      const lines = fs.readFileSync(path.join(dir, name), 'utf-8').trim().split('\n').filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const rec = JSON.parse(lines[i])
          if (rec.type === 'user' && rec.timestamp) {
            const t = Date.parse(rec.timestamp)
            if (!Number.isNaN(t) && (!latest || t > latest)) latest = t
            break
          }
        } catch {}
      }
    } catch {}
  }
  return latest
}
