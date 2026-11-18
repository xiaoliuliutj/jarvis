/**
 * Meta MCP Server —— 工具管理器
 *
 * 提供 4 个工具，让 Jarvis 能够创建、查询、更新、启用/禁用自定义工具。
 * 每次工具变更后，向主进程发送热加载信号（写 signal 文件）。
 *
 * 工具目录结构：
 *   agents/claude-cc/tools/
 *   ├── _meta/          ← 本文件
 *   ├── _registry.json  ← 工具索引
 *   └── <name>/
 *       ├── index.mjs   ← 工具实现（MCP server）
 *       └── manifest.json
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

const TOOLS_DIR    = path.resolve(import.meta.dirname, '..')
const REGISTRY     = path.join(TOOLS_DIR, '_registry.json')
const SIGNAL_FILE  = path.join(TOOLS_DIR, '_reload.signal')

// ── 注册表读写 ────────────────────────────────────────────────────────────────

function readRegistry() {
  try {
    return fs.existsSync(REGISTRY) ? JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')) : []
  } catch { return [] }
}

function writeRegistry(entries) {
  fs.writeFileSync(REGISTRY, JSON.stringify(entries, null, 2), 'utf-8')
}

/** 写 signal 文件通知主进程热加载 */
function signalReload() {
  fs.writeFileSync(SIGNAL_FILE, new Date().toISOString(), 'utf-8')
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: '_meta',
  version: '1.0.0',
})

// ── create_tool ───────────────────────────────────────────────────────────────

server.tool(
  'create_tool',
  '创建一个新的自定义工具并立即注册。工具以 Node.js MCP server 形式实现。' +
  '必须在实现中 import McpServer 和 StdioServerTransport，并以 await server.connect(new StdioServerTransport()) 结尾。',
  {
    name: z.string().regex(/^[a-z][a-z0-9_]*$/, '工具名只能包含小写字母、数字和下划线，以字母开头').describe('工具唯一名称，snake_case'),
    description: z.string().min(1).describe('工具功能描述，1-2 句话'),
    code: z.string().min(50).describe('完整的 MCP server 实现代码（index.mjs）'),
  },
  async ({ name, description, code }) => {
    // 1. 检查名称冲突
    const registry = readRegistry()
    if (registry.find(e => e.name === name)) {
      return { content: [{ type: 'text', text: `❌ 工具 "${name}" 已存在，请用 update_tool 更新。` }] }
    }
    if (name === '_meta') {
      return { content: [{ type: 'text', text: '❌ "_meta" 是保留名称。' }] }
    }

    // 2. 写文件
    const toolDir = path.join(TOOLS_DIR, name)
    fs.mkdirSync(toolDir, { recursive: true })
    const indexFile = path.join(toolDir, 'index.mjs')
    fs.writeFileSync(indexFile, code, 'utf-8')

    // 3. 语法检查
    try {
      execSync(`node --check "${indexFile}"`, { timeout: 5000, stdio: 'pipe' })
    } catch (err) {
      fs.rmSync(toolDir, { recursive: true })
      return { content: [{ type: 'text', text: `❌ 语法错误：${err.stderr?.toString() || err.message}` }] }
    }

    // 4. 写 manifest
    const manifest = { name, description, createdAt: new Date().toISOString(), version: '1.0.0' }
    fs.writeFileSync(path.join(toolDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')

    // 5. 注册
    registry.push({ name, description, enabled: true, createdAt: manifest.createdAt, version: '1.0.0' })
    writeRegistry(registry)

    // 6. 热加载信号
    signalReload()

    return { content: [{ type: 'text', text: `✅ 工具 "${name}" 创建成功！已自动注册并触发热加载。\n路径：${toolDir}` }] }
  }
)

// ── list_tools ────────────────────────────────────────────────────────────────

server.tool(
  'list_tools',
  '列出所有已注册的自定义工具，包含名称、描述、启用状态。',
  {},
  async () => {
    const registry = readRegistry()
    if (!registry.length) {
      return { content: [{ type: 'text', text: '当前没有任何自定义工具。' }] }
    }
    const lines = registry.map(e =>
      `${e.enabled ? '✅' : '⏸'} **${e.name}** — ${e.description}（v${e.version}，创建于 ${e.createdAt.slice(0, 10)}）`
    )
    return { content: [{ type: 'text', text: `共 ${registry.length} 个工具：\n\n${lines.join('\n')}` }] }
  }
)

// ── update_tool ───────────────────────────────────────────────────────────────

server.tool(
  'update_tool',
  '更新已有工具的实现代码。语法检查通过后替换原文件并触发热加载。',
  {
    name: z.string().describe('要更新的工具名称'),
    code: z.string().min(50).describe('新的完整 MCP server 实现代码'),
    description: z.string().optional().describe('可选：更新工具描述'),
  },
  async ({ name, code, description }) => {
    const registry = readRegistry()
    const entry = registry.find(e => e.name === name)
    if (!entry) {
      return { content: [{ type: 'text', text: `❌ 工具 "${name}" 不存在。` }] }
    }

    const toolDir = path.join(TOOLS_DIR, name)
    const indexFile = path.join(toolDir, 'index.mjs')

    // 语法检查（写临时文件）
    const tmpFile = indexFile + '.tmp'
    fs.writeFileSync(tmpFile, code, 'utf-8')
    try {
      execSync(`node --check "${tmpFile}"`, { timeout: 5000, stdio: 'pipe' })
    } catch (err) {
      fs.unlinkSync(tmpFile)
      return { content: [{ type: 'text', text: `❌ 语法错误：${err.stderr?.toString() || err.message}` }] }
    }

    // 替换
    fs.renameSync(tmpFile, indexFile)

    // 更新注册表
    if (description) entry.description = description
    entry.updatedAt = new Date().toISOString()
    entry.version = bumpVersion(entry.version)
    writeRegistry(registry)

    // 更新 manifest
    const manifestFile = path.join(toolDir, 'manifest.json')
    if (fs.existsSync(manifestFile)) {
      const m = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'))
      if (description) m.description = description
      m.version = entry.version
      m.updatedAt = entry.updatedAt
      fs.writeFileSync(manifestFile, JSON.stringify(m, null, 2), 'utf-8')
    }

    signalReload()

    return { content: [{ type: 'text', text: `✅ 工具 "${name}" 已更新至 v${entry.version}，热加载中。` }] }
  }
)

// ── toggle_tool ───────────────────────────────────────────────────────────────

server.tool(
  'toggle_tool',
  '启用或禁用一个工具。禁用后工具不再注入到 agent，但代码保留在磁盘。',
  {
    name: z.string().describe('工具名称'),
    enabled: z.boolean().describe('true = 启用，false = 禁用'),
  },
  async ({ name, enabled }) => {
    const registry = readRegistry()
    const entry = registry.find(e => e.name === name)
    if (!entry) {
      return { content: [{ type: 'text', text: `❌ 工具 "${name}" 不存在。` }] }
    }

    entry.enabled = enabled
    writeRegistry(registry)
    signalReload()

    return { content: [{ type: 'text', text: `${enabled ? '✅ 已启用' : '⏸ 已禁用'}工具 "${name}"，热加载中。` }] }
  }
)

// ── 工具代码模板（供 AI 参考）────────────────────────────────────────────────
// 这个工具让 Jarvis 获取标准模板，避免每次都从头构造

server.tool(
  'get_tool_template',
  '获取创建新工具的标准代码模板。创建工具前先调用这个获取模板。',
  {
    name: z.string().describe('新工具的名称（snake_case）'),
    description: z.string().describe('工具功能描述'),
  },
  async ({ name, description }) => {
    const template = `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: '${name}', version: '1.0.0' })

server.tool(
  '${name}',
  '${description}',
  {
    // 在这里定义参数，使用 z.string()、z.number() 等 Zod 类型
    // 例：query: z.string().describe('搜索关键词'),
  },
  async (args) => {
    // 在这里实现工具逻辑
    // 可以 import 任何 npm 包，调用本地 API，读写文件等
    const result = 'TODO: 实现工具逻辑'

    return { content: [{ type: 'text', text: result }] }
  }
)

await server.connect(new StdioServerTransport())
`
    return { content: [{ type: 'text', text: template }] }
  }
)

// ── 工具版本号自增 ────────────────────────────────────────────────────────────

function bumpVersion(v = '1.0.0') {
  const parts = v.split('.').map(Number)
  parts[2] = (parts[2] || 0) + 1
  return parts.join('.')
}

// ── 启动 ──────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport())
