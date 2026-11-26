/**
 * Meta MCP Server —— 工具管理器
 *
 * 规则：
 *   - 所有用户都可以创建工具；创建后所有用户都能使用
 *   - 只有创建者可以修改/删除自己的工具
 *   - main（maintainer）可以修改/删除所有用户工具
 *   - 系统工具在 agents/tools/ 下，只能由 maintainer/owner 通过项目文件修改
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
  canAccessTool,
} from '../../../core/tools.mjs'
import {
  listExternalToolDefinitions,
  createExternalTool,
  updateExternalTool,
  deleteExternalTool,
} from '../../../core/external-tools.mjs'
import { isToolEnabled } from '../../../core/app-store.mjs'

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
  '列出当前用户可见的系统工具和用户工具。用户工具只有创建者能改；access=owner 的工具仅主人和主会话可见。',
  {},
  async () => {
    const principal = { id: principalId, role }
    const tools = listAllTools().filter(t => canAccessTool(t, principal))
    if (!tools.length) return ok('当前没有工具。')
    const lines = tools.map(t => {
      const owner = t.scope === 'user' ? `，创建者 ${t.ownerId}` : ''
      const locked = t.access === 'owner' ? '，仅主人可用' : ''
      return `${t.enabled ? '✅' : '⏸'} **${t.name}** [${t.scope}${owner}${locked}] — ${t.description || ''}`
    })
    return ok(`共 ${tools.length} 个工具：\n\n${lines.join('\n')}`)
  }
)

// ── external tools ────────────────────────────────────────────────────────────
// 外接工具定义是全局的；只有 owner / maintainer 可以增删改，普通用户只能启用/停用。

server.tool(
  'list_external_tools',
  '列出全局外接工具定义和当前用户的启用状态。所有用户可查看；只有 owner/main 可以增删改。',
  {},
  async () => {
    const tools = listExternalToolDefinitions()
    if (!tools.length) return ok('当前没有外接工具。')
    const lines = tools.map(t => {
      const enabled = isToolEnabled(principalId, t.id, false)
      return `- **${t.id}** ${t.name} [${t.provider}] ${t.available ? '可用' : '待接入'} · 当前用户${enabled ? '已启用' : '未启用'} — ${t.summary || t.description || ''}`
    })
    return ok(`共 ${tools.length} 个外接工具：\n\n${lines.join('\n')}`)
  }
)

server.tool(
  'create_external_tool',
  '新增一个全局外接工具定义（仅 owner/main）。普通用户只能启用/停用和使用外接工具。',
  {
    id: z.string().regex(/^[a-z][a-z0-9_]*$/, '小写字母/数字/下划线，字母开头').describe('全局唯一 id'),
    name: z.string().min(1).describe('显示名称'),
    summary: z.string().min(1).max(80).describe('前端展示用的一句话简介'),
    description: z.string().min(1).describe('给模型看的能力说明'),
    provider: z.enum(['android-native', 'mcp', 'http']).describe('实现方式'),
    icon: z.string().optional().describe('emoji 图标'),
    category: z.string().optional().describe('分类'),
    risk: z.enum(['low', 'medium', 'high']).optional().describe('风险等级'),
    tags: z.array(z.string()).optional().describe('标签'),
    available: z.boolean().optional().describe('是否已接入；新增工具默认 false'),
    impl: z.any().optional().describe('实现参数（provider 专用）'),
    configFields: z.any().optional().describe('配置字段定义'),
    inputSchema: z.any().optional().describe('输入 schema（展示/未来 provider 用）'),
  },
  async (args) => {
    try {
      if (listAllTools().some(tool => tool.name === args.id)) {
        throw new Error(`Jarvis 工具 "${args.id}" 已存在，工具 id 必须全局唯一`)
      }
      const tool = createExternalTool(args, { role })
      return ok(`✅ 外接工具 "${tool.id}" 已创建（${tool.provider}）。`)
    } catch (err) {
      return fail(err)
    }
  }
)

server.tool(
  'update_external_tool',
  '修改全局外接工具定义（仅 owner/main）。普通用户只能用。',
  {
    id: z.string().describe('外接工具 id'),
    name: z.string().optional(),
    summary: z.string().max(80).optional(),
    description: z.string().optional(),
    provider: z.enum(['android-native', 'mcp', 'http']).optional(),
    icon: z.string().optional(),
    category: z.string().optional(),
    risk: z.enum(['low', 'medium', 'high']).optional(),
    tags: z.array(z.string()).optional(),
    available: z.boolean().optional(),
    impl: z.any().optional(),
    configFields: z.any().optional(),
    inputSchema: z.any().optional(),
  },
  async ({ id, ...patch }) => {
    try {
      const tool = updateExternalTool(id, patch, { role })
      return ok(`✅ 外接工具 "${tool.id}" 已更新。`)
    } catch (err) {
      return fail(err)
    }
  }
)

server.tool(
  'delete_external_tool',
  '删除全局外接工具定义（仅 owner/main）。内置工具不能删除，只能设为 available:false。',
  { id: z.string().describe('外接工具 id') },
  async ({ id }) => {
    try {
      deleteExternalTool(id, { role })
      return ok(`✅ 外接工具 "${id}" 已删除。`)
    } catch (err) {
      return fail(err)
    }
  }
)

// ── create_tool ───────────────────────────────────────────────────────────────

server.tool(
  'create_tool',
  '创建一个用户工具。默认所有用户可以使用；access=owner 时仅主人和主会话可用。' +
  '只有创建者/main 可以修改或删除。代码必须是完整的 MCP server，并以 await server.connect(new StdioServerTransport()) 结尾。' +
  '创建时必须自己生成 summary：用一句话概括工具能做什么，供 App 工具列表展示；不要照抄给模型看的 description，也不要写实现细节。',
  {
    name: z.string().regex(/^[a-z][a-z0-9_]*$/, '小写字母/数字/下划线，字母开头').describe('工具全局唯一名称'),
    description: z.string().min(1).describe('给模型看的能力说明（工具用途、参数、限制）'),
    summary: z.string().min(1).max(80).describe('给用户看的一句话简介，用于前端工具列表展示；10-30 字，不要技术细节'),
    code: z.string().min(50).describe('完整 MCP server 实现代码'),
    access: z.enum(['all', 'owner']).optional().describe('访问范围：all=所有用户（默认），owner=仅主人和主会话'),
  },
  async ({ name, description, summary, code, access }) => {
    try {
      requirePrincipal()
      const tool = createUserTool({ principalId, name, description, summary, code, access })
      const scopeText = tool.access === 'owner' ? '仅主人和主会话可用' : '所有用户都可以使用'
      return ok(`✅ 工具 "${name}" 已创建（${scopeText}）。\n简介：${tool.summary}\n路径：${tool.dir}`)
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
    description: z.string().optional().describe('可选：给模型看的新能力说明'),
    summary: z.string().max(80).optional().describe('可选：给用户看的一句话简介（前端展示），10-30 字'),
    access: z.enum(['all', 'owner']).optional().describe('可选：访问范围，all=所有用户，owner=仅主人和主会话'),
  },
  async ({ name, code, description, summary, access }) => {
    try {
      requirePrincipal()
      const manifest = updateUserTool({ principalId, role, name, code, description, summary, access })
      const scopeText = manifest.access === 'owner' ? '，仅主人和主会话可用' : ''
      return ok(`✅ 工具 "${name}" 已更新到 v${manifest.version}${scopeText}，所有会话会自动热加载。`)
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
