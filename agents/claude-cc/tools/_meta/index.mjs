/**
 * Meta MCP Server —— 工具管理器
 *
 * 规则：
 *   - 所有用户都可以创建工具；创建后所有用户都能使用
 *   - 只有创建者可以修改/删除自己的工具
 *   - main（maintainer）可以修改/删除所有用户工具
 *   - 系统工具在 agents/claude-cc/tools/ 下，只能由 maintainer/owner 通过项目文件修改
 *
 * 用户工具存放在 userdata/tools/<ownerId>/<toolName>/。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  createUserTool,
  updateUserTool,
  deleteUserTool,
  toggleUserTool,
  listAllTools,
} from '../../../../core/tools.mjs'

const principalId = process.env.JARVIS_PRINCIPAL_ID
const role = process.env.JARVIS_ROLE

function requirePrincipal() {
  if (!principalId) throw new Error('缺少 JARVIS_PRINCIPAL_ID，工具管理不可用')
}

function ok(text) {
  return { content: [{ type: 'text', text }] }
}

function fail(err) {
  return { content: [{ type: 'text', text: `❌ ${err.message}` }] }
}

const server = new McpServer({ name: '_meta', version: '2.0.0' })

// ── list_tools ────────────────────────────────────────────────────────────────

server.tool(
  'list_tools',
  '列出所有系统工具和用户工具。所有用户都可以使用这些工具；用户工具只有创建者能改。',
  {},
  async () => {
    const tools = listAllTools()
    if (!tools.length) return ok('当前没有工具。')
    const lines = tools.map(t => {
      const owner = t.scope === 'user' ? `，创建者 ${t.ownerId}` : ''
      return `${t.enabled ? '✅' : '⏸'} **${t.name}** [${t.scope}${owner}] — ${t.description || ''}`
    })
    return ok(`共 ${tools.length} 个工具：\n\n${lines.join('\n')}`)
  }
)

// ── create_tool ───────────────────────────────────────────────────────────────

server.tool(
  'create_tool',
  '创建一个用户工具。创建后所有用户都可以使用；只有创建者/main 可以修改或删除。' +
  '代码必须是完整的 MCP server，并以 await server.connect(new StdioServerTransport()) 结尾。',
  {
    name: z.string().regex(/^[a-z][a-z0-9_]*$/, '小写字母/数字/下划线，字母开头').describe('工具全局唯一名称'),
    description: z.string().min(1).describe('工具描述'),
    code: z.string().min(50).describe('完整 MCP server 实现代码'),
  },
  async ({ name, description, code }) => {
    try {
      requirePrincipal()
      const tool = createUserTool({ principalId, name, description, code })
      return ok(`✅ 工具 "${name}" 已创建，所有用户都可以使用。\n路径：${tool.dir}`)
    } catch (err) {
      return fail(err)
    }
  }
)

// ── update_tool ───────────────────────────────────────────────────────────────

server.tool(
  'update_tool',
  '更新一个用户工具。只有创建者或 main 可以更新；系统工具不能通过这里修改。',
  {
    name: z.string().describe('工具名称'),
    code: z.string().min(50).describe('新的完整 MCP server 代码'),
    description: z.string().optional().describe('可选：新描述'),
  },
  async ({ name, code, description }) => {
    try {
      requirePrincipal()
      const manifest = updateUserTool({ principalId, role, name, code, description })
      return ok(`✅ 工具 "${name}" 已更新到 v${manifest.version}，所有会话会自动热加载。`)
    } catch (err) {
      return fail(err)
    }
  }
)

// ── delete_tool ───────────────────────────────────────────────────────────────

server.tool(
  'delete_tool',
  '删除一个用户工具。只有创建者或 main 可以删除；系统工具不能删除。',
  { name: z.string().describe('工具名称') },
  async ({ name }) => {
    try {
      requirePrincipal()
      deleteUserTool({ principalId, role, name })
      return ok(`✅ 工具 "${name}" 已删除。`)
    } catch (err) {
      return fail(err)
    }
  }
)

// ── toggle_tool ───────────────────────────────────────────────────────────────

server.tool(
  'toggle_tool',
  '启用/禁用一个用户工具。只有创建者或 main 可以操作。',
  {
    name: z.string().describe('工具名称'),
    enabled: z.boolean().describe('true = 启用，false = 禁用'),
  },
  async ({ name, enabled }) => {
    try {
      requirePrincipal()
      toggleUserTool({ principalId, role, name, enabled })
      return ok(`${enabled ? '✅ 已启用' : '⏸ 已禁用'}工具 "${name}"。`)
    } catch (err) {
      return fail(err)
    }
  }
)

// ── get_tool_template ─────────────────────────────────────────────────────────

server.tool(
  'get_tool_template',
  '获取创建用户工具的标准代码模板。',
  {
    name: z.string().describe('工具名称（snake_case）'),
    description: z.string().describe('工具描述'),
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
    // 参数示例：query: z.string().describe('搜索关键词'),
  },
  async (args) => {
    return { content: [{ type: 'text', text: 'TODO: 实现工具逻辑' }] }
  }
)

await server.connect(new StdioServerTransport())
`
    return ok(template)
  }
)

await server.connect(new StdioServerTransport())
