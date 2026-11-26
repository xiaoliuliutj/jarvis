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
import { isToolEnabled } from './app-store.mjs'
import { normalizeJarvisTool } from './tool-definition.mjs'
import { listExternalToolDefinitions } from './external-tools.mjs'
import { buildProviderMcpServers } from './tool-providers/index.mjs'

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

/** 前端展示用的一句话简介：去掉多余空白，限制长度。 */
export function normalizeToolSummary(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

/** 系统工具 + userdata 用户工具，统一成 Jarvis 工具定义。 */
export function listJarvisToolDefinitions() {
  const system = readSystemRegistry().map(entry => normalizeJarvisTool({
    ...entry,
    id: entry.name,
    name: entry.name,
    source: 'system',
    scope: 'system',
    globalEnabled: entry.enabled !== false,
    ownerId: entry.ownerId || null,
    access: entry.access === 'owner' ? 'owner' : 'all',
    impl: {
      type: 'local-mcp',
      server: entry.name,
      tool: entry.name,
      path: path.join(SYSTEM_TOOLS_DIR, entry.name, 'index.mjs'),
    },
  }))
  const user = listUserToolDirs().map(manifest => normalizeJarvisTool({
    ...manifest,
    id: manifest.name,
    name: manifest.name,
    source: 'user',
    scope: 'user',
    globalEnabled: manifest.enabled !== false,
    ownerId: manifest.ownerId,
    access: manifest.access === 'owner' ? 'owner' : 'all',
    impl: {
      type: 'local-mcp',
      server: manifest.name,
      tool: manifest.name,
      path: manifest.indexFile,
    },
  }))
  return [...system, ...user]
}

export function listAllTools() {
  return listJarvisToolDefinitions().map(def => ({
    name: def.id,
    description: def.description,
    summary: def.summary,
    enabled: def.globalEnabled !== false,
    scope: def.source === 'user' ? 'user' : 'system',
    ownerId: def.ownerId || null,
    createdAt: def.createdAt,
    access: def.access === 'owner' ? 'owner' : 'all',
  }))
}

/**
 * 工具访问控制：
 *   access === 'owner' 的用户工具仅对 owner / maintainer（主会话）可用。
 *   系统工具和其它用户工具默认所有用户可用。
 */
export function canAccessTool(tool, principal) {
  if (tool?.access !== 'owner') return true
  return principal?.role === 'owner' || principal?.role === 'maintainer'
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
  if (name === 'android_native') throw new Error('"android_native" 是原生工具保留名称')
  if (readSystemRegistry().some(e => e.name === name)) {
    throw new Error(`系统工具 "${name}" 已存在，请换一个名字`)
  }
  if (findUserTool(name)) {
    throw new Error(`工具 "${name}" 已存在，且工具名必须全局唯一`)
  }
  if (listExternalToolDefinitions().some(tool => tool.id === name)) {
    throw new Error(`外接工具 "${name}" 已存在，工具 id 必须全局唯一`)
  }
}

function checkSyntax(file) {
  execFileSync('node', ['--check', file], { stdio: 'pipe', timeout: 5000 })
}

export function signalReload() {
  fs.writeFileSync(RELOAD_SIGNAL_FILE, new Date().toISOString(), 'utf-8')
}

// ── 用户工具 CRUD ─────────────────────────────────────────────────────────────

export function createUserTool({ principalId, name, description, summary, code, access = 'all' }) {
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
    summary: normalizeToolSummary(summary),
    ownerId: principalId,
    createdAt: new Date().toISOString(),
    version: '1.0.0',
    enabled: true,
    access: access === 'owner' ? 'owner' : 'all',
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

export function updateUserTool({ principalId, role, name, code, description, summary, access }) {
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
  if (summary !== undefined) manifest.summary = normalizeToolSummary(summary)
  if (access === 'all' || access === 'owner') manifest.access = access
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
 * 所有会话加载同一套工具：
 *   - Jarvis 工具（系统 + 用户创建）
 *   - 用户已启用的外接工具
 * `_meta` 永远加载，用于工具管理。
 *
 * 具体 MCP server 的形态由 tool-providers 按 impl.type 生成。
 */
export function buildMcpServers(principal) {
  const env = toolEnv(principal)
  const androidEnv = {
    ...(process.env.JARVIS_BRIDGE_INTERNAL_URL
      ? { JARVIS_BRIDGE_INTERNAL_URL: String(process.env.JARVIS_BRIDGE_INTERNAL_URL) }
      : {}),
    ...(process.env.JARVIS_INTERNAL_TOKEN
      ? { JARVIS_INTERNAL_TOKEN: String(process.env.JARVIS_INTERNAL_TOKEN) }
      : {}),
  }

  const definitions = [...listJarvisToolDefinitions(), ...listExternalToolDefinitions()]
  const usable = definitions.filter(def => {
    if (def.kind !== 'tool') return false
    if (!def.available) return false
    if (!canAccessTool(def, principal)) return false
    if (def.class === 'jarvis') {
      if (def.globalEnabled === false) return false
      return isToolEnabled(principal.id, def.id, true)
    }
    return isToolEnabled(principal.id, def.id, def.enabledByDefault === true)
  })

  const servers = {
    _meta: {
      command: 'node',
      args: [path.join(SYSTEM_TOOLS_DIR, '_meta', 'index.mjs')],
      env,
    },
  }

  const providerServers = buildProviderMcpServers(usable, {
    env,
    androidEnv,
    principal,
  })
  for (const [name, config] of Object.entries(providerServers)) {
    if (servers[name]) {
      throw new Error(`工具名冲突：${name}（系统工具/其他用户工具已存在）`)
    }
    servers[name] = config
  }

  return servers
}
