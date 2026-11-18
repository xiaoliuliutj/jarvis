/**
 * 长期记忆存储层
 *
 * 负责：
 *   - long-term.jsonl 的读写（按条存储）
 *   - 权重动态计算（mentions / sqrt(days+1)）
 *   - token 上限校验与压缩
 *   - 文件操作记录
 */

import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

// ── 路径 ──────────────────────────────────────────────────────────────────────

// 所有用户配置统一放在项目根目录的 config/ 下
const CONFIG_DIR     = path.join(import.meta.dirname, '..', '..', 'config')
const MEMORY_DIR     = path.join(import.meta.dirname, 'memory')
const GLOBAL_FILE    = path.join(CONFIG_DIR, 'global.md')
const LONG_TERM_FILE = path.join(MEMORY_DIR, 'long-term.jsonl')
const SESSIONS_DIR   = path.join(MEMORY_DIR, 'sessions')

// 豁免阈值：低于此 token 数不压缩
const MIN_TOKENS_TO_COMPRESS = 20_000

// 权重低于此值的条目参与压缩候选
const LOW_WEIGHT_THRESHOLD = 0.3

// ── 初始化 ────────────────────────────────────────────────────────────────────

export function ensureMemoryDirs() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true })
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true })

  if (!fs.existsSync(GLOBAL_FILE)) {
    fs.writeFileSync(GLOBAL_FILE, `# 全局记忆

这是 Jarvis 必须遵守的全局配置，只能由用户手动修改。

## 用户信息
（在此填写你的基本信息，例如姓名、职业、偏好语言等）

## 行为规范
- 回答简洁直接
- 代码示例优先使用实际项目语言
`, 'utf-8')
  }

  if (!fs.existsSync(LONG_TERM_FILE)) {
    fs.writeFileSync(LONG_TERM_FILE, '', 'utf-8')
  }
}

// ── 全局记忆 ──────────────────────────────────────────────────────────────────

export function readGlobalMemory() {
  try {
    return fs.existsSync(GLOBAL_FILE) ? fs.readFileSync(GLOBAL_FILE, 'utf-8') : ''
  } catch { return '' }
}

// ── 长期记忆条目 ──────────────────────────────────────────────────────────────

/**
 * 计算条目权重
 * weight = mentions / sqrt(daysSinceLastMentioned + 1)
 */
function calcWeight(entry) {
  const days = (Date.now() - new Date(entry.lastMentioned).getTime()) / 86_400_000
  return entry.mentions / Math.sqrt(days + 1)
}

/** 读取所有长期记忆条目 */
export function readLongTermEntries() {
  try {
    const text = fs.readFileSync(LONG_TERM_FILE, 'utf-8')
    return text
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l))
  } catch { return [] }
}

/** 写入所有条目（覆盖） */
function writeAllEntries(entries) {
  fs.writeFileSync(LONG_TERM_FILE, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf-8')
}

/** 追加一条新记忆 */
export function appendMemoryEntry({ content, type = 'fact', refs = [], cwd = '' }) {
  ensureMemoryDirs()
  const entry = {
    id: randomUUID(),
    content,
    type,
    refs,
    cwd,
    mentions: 1,
    lastMentioned: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  }
  fs.appendFileSync(LONG_TERM_FILE, JSON.stringify(entry) + '\n', 'utf-8')
  return entry
}

/** 更新条目的 mentions 和 lastMentioned（当条目被再次提及时） */
export function touchMemoryEntry(id) {
  const entries = readLongTermEntries()
  const idx = entries.findIndex(e => e.id === id)
  if (idx === -1) return
  entries[idx].mentions++
  entries[idx].lastMentioned = new Date().toISOString()
  writeAllEntries(entries)
}

/**
 * 格式化长期记忆供注入 system prompt
 * 只展示 weight > LOW_WEIGHT_THRESHOLD 的条目，按 weight 降序
 * 超出 token 上限时截断（调用方传入 maxTokens）
 */
export function formatLongTermMemory(maxTokens) {
  const entries = readLongTermEntries()
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
    for (const e of sections.project_file) {
      lines.push(`- ${e.content}${e.refs.length ? ` [${e.refs.join(', ')}]` : ''}`)
    }
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

  // 按 token 上限截断（估算：4字符≈1token）
  const limit = maxTokens * 4
  let result = lines.join('\n')
  if (result.length > limit) result = result.slice(0, limit) + '\n...[记忆已截断]'
  return result
}

// ── 记忆压缩 ──────────────────────────────────────────────────────────────────

/**
 * 检查是否需要压缩，返回需要压缩的条目列表
 * @param {number} modelContextTokens  当前模型的总上下文窗口（token）
 */
export function getCompressibleEntries(modelContextTokens) {
  const maxTokens = Math.max(MIN_TOKENS_TO_COMPRESS, Math.floor(modelContextTokens * 0.1))
  const entries = readLongTermEntries()
  if (!entries.length) return { needsCompression: false, entries: [], maxTokens }

  // 估算当前 token 用量
  const totalChars = entries.reduce((s, e) => s + e.content.length, 0)
  const estimatedTokens = Math.ceil(totalChars / 4)

  if (estimatedTokens <= maxTokens) return { needsCompression: false, entries: [], maxTokens }

  // 按权重升序，权重最低的参与压缩
  const withWeight = entries
    .map(e => ({ ...e, weight: calcWeight(e) }))
    .sort((a, b) => a.weight - b.weight)

  // 找出要压缩的条目（权重最低的，直到字符数降到阈值以下）
  const targetChars = maxTokens * 4 * 0.8  // 压缩到 80% 阈值
  let accChars = totalChars
  const toCompress = []
  for (const e of withWeight) {
    if (accChars <= targetChars) break
    if (e.weight < 0.5) {  // 只压缩低权重条目
      toCompress.push(e)
      accChars -= e.content.length
    }
  }

  return { needsCompression: toCompress.length > 0, entries: toCompress, maxTokens }
}

/**
 * 执行压缩：删除 toCompress 条目，插入一条合并摘要
 * @param {string[]} idsToRemove  要删除的条目 ID
 * @param {string} summary        合并后的摘要文本
 */
export function applyCompression(idsToRemove, summary) {
  const entries = readLongTermEntries().filter(e => !idsToRemove.includes(e.id))
  const summaryEntry = {
    id: randomUUID(),
    content: summary,
    type: 'session_summary',
    refs: [],
    cwd: '',
    mentions: 1,
    lastMentioned: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  }
  writeAllEntries([...entries, summaryEntry])
}

// ── 会话管理 ──────────────────────────────────────────────────────────────────
// 统一索引：sessions/<cwd-hash>/index.json
// [{sessionId, name, createdAt, lastActiveAt, isCurrent}] 按 lastActiveAt 降序

/** 根据 cwd 生成唯一的目录名（哈希） */
function cwdHash(cwd) {
  let h = 5381
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) + h) ^ cwd.charCodeAt(i)
  return (h >>> 0).toString(16)
}

function getSessionDir(cwd) {
  const dir = path.join(SESSIONS_DIR, cwdHash(cwd))
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function getIndexFile(cwd) {
  return path.join(getSessionDir(cwd), 'index.json')
}

function readIndex(cwd) {
  try {
    const f = getIndexFile(cwd)
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'))
  } catch {}
  return []
}

function writeIndex(cwd, sessions) {
  // 按 lastActiveAt 降序
  sessions.sort((a, b) => new Date(b.lastActiveAt) - new Date(a.lastActiveAt))
  fs.writeFileSync(getIndexFile(cwd), JSON.stringify(sessions, null, 2), 'utf-8')
}

/** 读取所有会话（含当前），按最近活跃排序 */
export function listAllSessions(cwd) {
  return readIndex(cwd)
}

/** 读取当前活跃会话 */
export function readCurrentSession(cwd) {
  return readIndex(cwd).find(s => s.isCurrent) ?? null
}

/** 更新当前会话的最后活动时间 */
export function touchCurrentSession(cwd) {
  const sessions = readIndex(cwd)
  const cur = sessions.find(s => s.isCurrent)
  if (cur) {
    cur.lastActiveAt = new Date().toISOString()
    writeIndex(cwd, sessions)
  }
}

/** 创建新会话（同时把旧的 isCurrent 置为 false） */
export function createSession(cwd, sessionId, name = '') {
  const sessions = readIndex(cwd)
  // 取消之前的当前会话
  sessions.forEach(s => { s.isCurrent = false })
  sessions.push({
    sessionId,
    name: name || '新会话',
    cwd,
    workDirs: [],
    isMain: false,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    isCurrent: true,
  })
  writeIndex(cwd, sessions)
  return sessions.find(s => s.sessionId === sessionId)
}

/** 更新会话名称（以第一条用户消息为名） */
export function updateSessionName(cwd, sessionId, name) {
  const sessions = readIndex(cwd)
  const s = sessions.find(s => s.sessionId === sessionId)
  if (s && (s.name === '新会话' || !s.name)) {
    s.name = name.slice(0, 20)
    writeIndex(cwd, sessions)
  }
}

/** 归档当前会话（isCurrent → false，消息文件保留）主会话不可归档 */
export function archiveSession(cwd) {
  const sessions = readIndex(cwd)
  const cur = sessions.find(s => s.isCurrent)
  if (!cur) return null
  if (cur.isMain) return null  // 主会话不可归档
  cur.isCurrent = false
  cur.archivedAt = new Date().toISOString()
  writeIndex(cwd, sessions)
  return cur
}

/** 切换到指定会话（该会话变为 isCurrent） */
export function switchSession(cwd, sessionId) {
  const sessions = readIndex(cwd)
  sessions.forEach(s => { s.isCurrent = s.sessionId === sessionId })
  const target = sessions.find(s => s.sessionId === sessionId)
  if (target) target.lastActiveAt = new Date().toISOString()
  writeIndex(cwd, sessions)
  return target ?? null
}

/** 清除非主会话的 isCurrent 标记（用于"新建会话"场景，不归档） */
export function clearCurrentSession(cwd) {
  const sessions = readIndex(cwd)
  let changed = false
  for (const s of sessions) {
    if (s.isCurrent && !s.isMain) { s.isCurrent = false; changed = true }
  }
  if (changed) writeIndex(cwd, sessions)
  return changed
}

/** 获取或创建主会话 */
export function getOrCreateMainSession(cwd) {
  const sessions = readIndex(cwd)
  const main = sessions.find(s => s.isMain)
  if (main) return main
  // 首次创建主会话（不设 sessionId，等第一次发消息时由 SDK 分配）
  const mainSession = {
    sessionId: null,
    name: '主会话',
    cwd,
    workDirs: [],
    isMain: true,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    isCurrent: true,
  }
  sessions.forEach(s => { s.isCurrent = false })
  sessions.unshift(mainSession)
  writeIndex(cwd, sessions)
  return mainSession
}

/** 更新主会话的 sessionId（首次发消息后由 SDK 返回）*/
export function setMainSessionId(cwd, sessionId) {
  const sessions = readIndex(cwd)
  const main = sessions.find(s => s.isMain)
  if (main && !main.sessionId) {
    main.sessionId = sessionId
    main.lastActiveAt = new Date().toISOString()
    writeIndex(cwd, sessions)
  }
}

/** 更新会话的工作目录列表 */
export function updateSessionWorkDirs(cwd, sessionId, workDirs) {
  const sessions = readIndex(cwd)
  const s = sessions.find(s => s.sessionId === sessionId)
  if (s) {
    s.workDirs = workDirs.map(d => path.resolve(d))
    writeIndex(cwd, sessions)
    // 把新目录加入总工作空间
    for (const d of s.workDirs) addWorkspaceDir(d)
  }
}

/** 获取某个会话的工作目录 */
export function getSessionWorkDirs(cwd, sessionId) {
  const sessions = readIndex(cwd)
  const s = sessions.find(s => s.sessionId === sessionId)
  return s?.workDirs ?? []
}

/** 更新主会话的工作目录（无需 sessionId） */
export function addWorkDirToMain(cwd, dir) {
  const sessions = readIndex(cwd)
  const main = sessions.find(s => s.isMain)
  if (!main) return
  if (!main.workDirs) main.workDirs = []
  const absDir = path.resolve(dir)
  if (!main.workDirs.includes(absDir)) {
    main.workDirs.push(absDir)
    addWorkspaceDir(absDir)
    writeIndex(cwd, sessions)
  }
}

export function removeWorkDirFromMain(cwd, dir) {
  const sessions = readIndex(cwd)
  const main = sessions.find(s => s.isMain)
  if (!main) return
  const absDir = path.resolve(dir)
  main.workDirs = (main.workDirs || []).filter(d => d !== absDir)
  // 如果移除的是激活目录，清空激活目录（前端会 fallback 到默认）
  if (main.activeWorkDir === absDir) main.activeWorkDir = null
  writeIndex(cwd, sessions)
}

/** 设置会话的激活工作目录 */
export function setSessionActiveWorkdir(cwd, sessionId, dir, isMain) {
  const sessions = readIndex(cwd)
  const absDir = path.resolve(dir)
  let target
  if (isMain) {
    target = sessions.find(s => s.isMain)
  } else {
    target = sessions.find(s => s.sessionId === sessionId)
  }
  if (!target) return
  target.activeWorkDir = absDir
  writeIndex(cwd, sessions)
}

/** 获取会话的激活工作目录（没设置时返回 null） */
export function getSessionActiveWorkdir(cwd, sessionId, isMain) {
  const sessions = readIndex(cwd)
  let target
  if (isMain) {
    target = sessions.find(s => s.isMain)
  } else {
    target = sessions.find(s => s.sessionId === sessionId)
  }
  return target?.activeWorkDir ?? null
}
export function findStaleSession(cwd, thresholdMs = 2 * 60 * 60 * 1000) {  const session = readCurrentSession(cwd)
  if (!session) return null
  const lastActive = new Date(session.lastActiveAt).getTime()
  if (Date.now() - lastActive > thresholdMs) return session
  return null
}

// ── 工作空间管理 ──────────────────────────────────────────────────────────────

const AGENT_DIR       = path.join(import.meta.dirname)
const WORKSPACE_FILE  = path.join(CONFIG_DIR, 'workspace.json')
export const DEFAULT_WORKSPACE = path.join(AGENT_DIR, 'memory', 'workspace', 'defaultworkspace')

export function ensureWorkspace() {
  if (!fs.existsSync(DEFAULT_WORKSPACE)) fs.mkdirSync(DEFAULT_WORKSPACE, { recursive: true })
}

export function readWorkspaceDirs() {
  ensureWorkspace()
  try {
    const cfg = JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf-8'))
    // defaultworkspace 始终在列表第一位
    const extra = (cfg.dirs || []).filter(d => d !== DEFAULT_WORKSPACE)
    return [DEFAULT_WORKSPACE, ...extra]
  } catch { return [DEFAULT_WORKSPACE] }
}

export function addWorkspaceDir(dir) {
  const absDir = path.resolve(dir)
  let cfg = { dirs: [] }
  try { cfg = JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf-8')) } catch {}
  if (!cfg.dirs) cfg.dirs = []
  if (!cfg.dirs.includes(absDir) && absDir !== DEFAULT_WORKSPACE) {
    cfg.dirs.push(absDir)
    fs.writeFileSync(WORKSPACE_FILE, JSON.stringify(cfg, null, 2), 'utf-8')
  }
  return readWorkspaceDirs()
}

export function removeWorkspaceDir(dir) {
  const absDir = path.resolve(dir)
  if (absDir === DEFAULT_WORKSPACE) return readWorkspaceDirs() // 不能删默认目录
  let cfg = { dirs: [] }
  try { cfg = JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf-8')) } catch {}
  cfg.dirs = (cfg.dirs || []).filter(d => d !== absDir)
  fs.writeFileSync(WORKSPACE_FILE, JSON.stringify(cfg, null, 2), 'utf-8')
  return readWorkspaceDirs()
}

/** 检查路径是否在工作空间内 */
export function isInWorkspace(filePath) {
  const abs = path.resolve(filePath)
  return readWorkspaceDirs().some(d => abs.startsWith(d + path.sep) || abs === d)
}

/** 检查路径是否在默认工作空间内（所有会话可读写） */
export function isInDefaultWorkspace(filePath) {
  const abs = path.resolve(filePath)
  return abs.startsWith(DEFAULT_WORKSPACE + path.sep) || abs === DEFAULT_WORKSPACE
}

/** 检查路径是否在某个会话的工作目录内 */
export function isInSessionWorkDirs(filePath, workDirs = []) {
  const abs = path.resolve(filePath)
  return workDirs.some(d => abs.startsWith(path.resolve(d) + path.sep) || abs === path.resolve(d))
}

// ── 工具目录路径（任何会话都可读写）────────────────────────────────────────────
const TOOLS_DIR_PATH = path.join(AGENT_DIR, 'tools')
const MEMORY_DIR_PATH = path.join(AGENT_DIR, 'memory')
const GLOBAL_MEMORY_PATH = path.join(CONFIG_DIR, 'global.md')

export function isToolsPath(filePath) {
  const abs = path.resolve(filePath)
  return abs.startsWith(TOOLS_DIR_PATH + path.sep) || abs === TOOLS_DIR_PATH
}

export function isConfigPath(filePath) {
  const abs = path.resolve(filePath)
  return abs.startsWith(CONFIG_DIR + path.sep) || abs === path.resolve(CONFIG_DIR)
}

export function isMemoryPath(filePath) {
  const abs = path.resolve(filePath)
  return abs.startsWith(MEMORY_DIR_PATH + path.sep) || abs === MEMORY_DIR_PATH
}

export function isGlobalMemoryPath(filePath) {
  return path.resolve(filePath) === path.resolve(GLOBAL_MEMORY_PATH)
}

export function isJarvisCodePath(filePath) {
  // Jarvis 代码目录（agent/electron/renderer 等，但不包括配置、工作空间、工具、记忆）
  const abs = path.resolve(filePath)
  const root = path.resolve(AGENT_DIR, '..', '..')  // E:\Jarvis
  if (!abs.startsWith(root + path.sep)) return false
  // 排除配置、工作空间、工具、记忆
  if (isConfigPath(abs) || isInWorkspace(abs) || isToolsPath(abs) || isMemoryPath(abs)) return false
  return true
}

function getMessagesFile(cwd, sessionId) {
  return path.join(getSessionDir(cwd), `${sessionId}.messages.jsonl`)
}

/** 追加一条消息到磁盘 */
export function appendSessionMessage(cwd, sessionId, record) {
  const file = getMessagesFile(cwd, sessionId)
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf-8')
}

/** 读取某个会话的完整消息历史 */
export function readSessionMessages(cwd, sessionId) {
  const file = getMessagesFile(cwd, sessionId)
  try {
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf-8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l))
  } catch { return [] }
}
