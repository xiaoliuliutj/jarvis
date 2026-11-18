/**
 * 工具注册与加载。
 *
 * 系统工具：agents/tools/（项目内，只有 maintainer/owner 可改）
 * 用户工具：userdata/tools/<ownerId>/<toolName>/（所有用户加载和使用）
 *
 * 所有启用工具都会加载给所有会话；所有权只在 _meta 管理操作时校验。
 */

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import {
  SYSTEM_TOOLS_DIR,
  USER_TOOLS_DIR,
  RELOAD_SIGNAL_FILE,
  ensureDir,
} from './paths.mjs'

const SYSTEM_REGISTRY = path.join(SYSTEM_TOOLS_DIR, '_registry.json')
const NAME_RE = /^[a-z][a-z0-9_]*$/

function readSystemRegistry() {
  return JSON.parse(fs.readFileSync(SYSTEM_REGISTRY, 'utf-8'))
}

function writeSystemRegistry(entries) {
  fs.writeFileSync(SYSTEM_REGISTRY, JSON.stringify(entries, null, 2), 'utf-8')
}

function listUserToolDirs() {
  if (!fs.existsSync(USER_TOOLS_DIR)) return []
  const result = []
  for (const ownerId of fs.readdirSync(USER_TOOLS_DIR)) {
    const ownerDir = path.join(USER_TOOLS_DIR, ownerId)
    if (!fs.statSync(ownerDir).isDirectory()) continue
    for (const toolName of fs.readdirSync(ownerDir)) {
      const dir = path.join(ownerDir, toolName)
      const manifestFile = path.join(dir, 'manifest.json')
      const indexFile = path.join(dir, 'index.mjs')
      if (!fs.existsSync(manifestFile) || !fs.existsSync(indexFile)) continue
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'))
      result.push({ ...manifest, ownerId, dir, indexFile })
    }
  }
  return result
}

export function listAllTools() {
  const system = readSystemRegistry().map(e => ({
    name: e.name,
    description: e.description,
    enabled: e.enabled !== false,
    scope: 'system',
    ownerId: null,
  }))
  const user = listUserToolDirs().map(m => ({
    name: m.name,
    description: m.description || '',
    enabled: m.enabled !== false,
    scope: 'user',
    ownerId: m.ownerId,
    createdAt: m.createdAt,
  }))
  return [...system, ...user]
}

export function listSystemTools() {
  return readSystemRegistry()
}

export function findUserTool(name) {
  return listUserToolDirs().find(m => m.name === name) || null
}

function assertNameAvailable(name) {
  if (!NAME_RE.test(name)) throw new Error('工具名只能是小写字母/数字/下划线，且以字母开头')
  if (name === '_meta') throw new Error('"_meta" 是保留名称')
  if (readSystemRegistry().some(e => e.name === name)) {
    throw new Error(`系统工具 "${name}" 已存在，请换一个名字`)
  }
  if (findUserTool(name)) {
    throw new Error(`工具 "${name}" 已存在，且工具名必须全局唯一`)
  }
}

function checkSyntax(file) {
  execFileSync('node', ['--check', file], { stdio: 'pipe', timeout: 5000 })
}

export function signalReload() {
  fs.writeFileSync(RELOAD_SIGNAL_FILE, new Date().toISOString(), 'utf-8')
}

// ── 用户工具 CRUD ─────────────────────────────────────────────────────────────

export function createUserTool({ principalId, name, description, code }) {
  assertNameAvailable(name)
  const dir = path.join(USER_TOOLS_DIR, principalId, name)
  ensureDir(dir)

  const indexFile = path.join(dir, 'index.mjs')
  fs.writeFileSync(indexFile, code, 'utf-8')
  try {
    checkSyntax(indexFile)
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw new Error(`语法错误：${err.stderr?.toString() || err.message}`)
  }

  const manifest = {
    name,
    description,
    ownerId: principalId,
    createdAt: new Date().toISOString(),
    version: '1.0.0',
    enabled: true,
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  signalReload()
  return { ...manifest, dir }
}

function assertCanManage(principalId, role, tool) {
  if (role === 'maintainer') return
  if (tool.ownerId !== principalId) {
    throw new Error(`工具 "${tool.name}" 属于其他用户，不能修改或删除`)
  }
}

export function updateUserTool({ principalId, role, name, code, description }) {
  const tool = findUserTool(name)
  if (!tool) throw new Error(`用户工具 "${name}" 不存在；系统工具请直接修改项目文件`)
  assertCanManage(principalId, role, tool)

  // node --check 需要 .mjs 扩展名；临时文件不能叫 .tmp
  const tmpFile = path.join(tool.dir, 'index.tmp.mjs')
  fs.writeFileSync(tmpFile, code, 'utf-8')
  try {
    checkSyntax(tmpFile)
  } catch (err) {
    fs.unlinkSync(tmpFile)
    throw new Error(`语法错误：${err.stderr?.toString() || err.message}`)
  }
  // Windows 上 rename 覆盖已存在文件可能 EPERM，直接复制后删临时文件
  fs.copyFileSync(tmpFile, tool.indexFile)
  fs.unlinkSync(tmpFile)

  const manifestFile = path.join(tool.dir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'))
  if (description) manifest.description = description
  manifest.version = bumpVersion(manifest.version)
  manifest.updatedAt = new Date().toISOString()
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf-8')
  signalReload()
  return manifest
}

export function deleteUserTool({ principalId, role, name }) {
  const tool = findUserTool(name)
  if (!tool) throw new Error(`用户工具 "${name}" 不存在；系统工具不能用 _meta 删除`)
  assertCanManage(principalId, role, tool)
  fs.rmSync(tool.dir, { recursive: true, force: true })
  signalReload()
  return tool
}

export function toggleUserTool({ principalId, role, name, enabled }) {
  const tool = findUserTool(name)
  if (!tool) throw new Error(`用户工具 "${name}" 不存在；系统工具不能用 _meta 禁用`)
  assertCanManage(principalId, role, tool)
  const manifestFile = path.join(tool.dir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'))
  manifest.enabled = enabled
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf-8')
  signalReload()
  return manifest
}

function bumpVersion(v = '1.0.0') {
  const parts = v.split('.').map(Number)
  parts[2] = (parts[2] || 0) + 1
  return parts.join('.')
}

// ── 加载 MCP servers ──────────────────────────────────────────────────────────

function toolEnv(principal) {
  // 只传需要的两个变量。不要把整个 process.env 复制到每个 MCP server：
  // SDK 会把 mcpServers 配置带进子进程参数，Windows 下很容易 ENAMETOOLONG。
  return {
    JARVIS_PRINCIPAL_ID: principal.id,
    JARVIS_ROLE: principal.role,
  }
}

/**
 * 所有会话加载同一套工具：系统工具 + 所有用户工具。
 * `_meta` 永远加载，用于工具管理。
 */
export function buildMcpServers(principal) {
  const env = toolEnv(principal)
  const servers = {
    _meta: {
      command: 'node',
      args: [path.join(SYSTEM_TOOLS_DIR, '_meta', 'index.mjs')],
      env,
    },
  }

  for (const entry of readSystemRegistry()) {
    if (entry.enabled === false) continue
    const indexFile = path.join(SYSTEM_TOOLS_DIR, entry.name, 'index.mjs')
    if (!fs.existsSync(indexFile)) continue
    servers[entry.name] = { command: 'node', args: [indexFile], env }
  }

  for (const tool of listUserToolDirs()) {
    if (tool.enabled === false) continue
    if (servers[tool.name]) {
      throw new Error(`工具名冲突：${tool.name}（系统工具/其他用户工具已存在）`)
    }
    servers[tool.name] = { command: 'node', args: [tool.indexFile], env }
  }

  return servers
}
