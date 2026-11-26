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

export function createSession(principalId, sessionId, { name = '新会话', isMain = false } = {}) {
  ensureUser(principalId)
  const sessions = listSessions(principalId)
  sessions.forEach(s => { s.isCurrent = false })
  const session = {
    sessionId,
    agentSessionId: sessionId,
    name,
    isMain,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    isCurrent: true,
  }
  sessions.push(session)
  writeJson(indexFile(principalId), sessions)
  return session
}

/** 如果会话不存在则创建，存在则 touch。新会话的名称取第一条用户消息。 */
export function ensureSession(principalId, sessionId, { name = '新会话', isMain = false } = {}) {
  const existing = getSession(principalId, sessionId)
  if (existing) {
    touchSession(principalId, sessionId)
    return existing
  }
  return createSession(principalId, sessionId, { name, isMain })
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

/** 格式化为 system prompt 片段；按权重排序并在 token 限制处截断。 */
export function formatMemory(principalId, maxTokens = 6000) {
  const entries = readMemoryEntries(principalId)
  if (!entries.length) return ''

  const withWeight = entries
    .map(e => ({ ...e, weight: calcWeight(e) }))
    .filter(e => e.weight >= LOW_WEIGHT_THRESHOLD)
    .sort((a, b) => b.weight - a.weight)

  const sections = { project_file: [], preference: [], session_summary: [], fact: [] }
  for (const e of withWeight) {
    const key = sections[e.type] ? e.type : 'fact'
    sections[key].push(e)
  }

  const lines = ['## 长期记忆']
  if (sections.project_file.length) {
    lines.push('\n### 近期文件操作')
    for (const e of sections.project_file) lines.push(`- ${e.content}${e.refs.length ? ` [${e.refs.join(', ')}]` : ''}`)
  }
  if (sections.preference.length) {
    lines.push('\n### 用户偏好')
    for (const e of sections.preference) lines.push(`- ${e.content}`)
  }
  if (sections.session_summary.length) {
    lines.push('\n### 历史会话摘要')
    for (const e of sections.session_summary) lines.push(`- ${e.content}`)
  }
  if (sections.fact.length) {
    lines.push('\n### 记录的事实')
    for (const e of sections.fact) lines.push(`- ${e.content}`)
  }

  const limit = maxTokens * 4
  let result = lines.join('\n')
  if (result.length > limit) result = result.slice(0, limit) + '\n...[记忆已截断]'
  return result
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
