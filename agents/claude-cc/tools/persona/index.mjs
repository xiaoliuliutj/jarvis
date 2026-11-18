/**
 * Persona 工具：修改当前用户自己的 AI 人设。
 *
 * 只写当前 principal 的 userdata/<id>/persona.md；
 * 不触碰全局 rules，也不触碰其他用户。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { writePersona, readPersona } from '../../../../core/user-store.mjs'

const principalId = process.env.JARVIS_PRINCIPAL_ID

if (!principalId) throw new Error('缺少 JARVIS_PRINCIPAL_ID')

const server = new McpServer({ name: 'persona', version: '1.0.0' })

server.tool(
  'update_persona',
  '更新当前用户自己的 AI 人设。只在用户明确要求修改人设时调用。内容会完整替换 persona.md，并在下一轮对话生效。全局 rules 不能被修改。',
  {
    content: z.string().min(1).describe('完整的新 persona Markdown 内容'),
  },
  async ({ content }) => {
    writePersona(principalId, content)
    return {
      content: [{ type: 'text', text: '✅ 人设已更新，下一轮对话生效。' }],
    }
  }
)

server.tool(
  'get_persona',
  '读取当前用户自己的 AI 人设。',
  {},
  async () => {
    return { content: [{ type: 'text', text: readPersona(principalId) }] }
  }
)

await server.connect(new StdioServerTransport())
