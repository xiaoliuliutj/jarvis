import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'fs'
import mammoth from 'mammoth'

const server = new McpServer({ name: 'read_word', version: '1.0.0' })

server.tool(
  'read_word',
  '解析 Word (.docx) 文件，提取纯文本或转换为 Markdown',
  {
    filePath: z.string().describe('Word 文件的完整路径（.docx 格式）'),
    format: z.enum(['text', 'markdown']).optional().default('text').describe('输出格式：text（纯文本，默认）或 markdown（保留标题、列表等结构）'),
  },
  async ({ filePath, format }) => {
    if (!fs.existsSync(filePath)) {
      return { content: [{ type: 'text', text: `❌ 文件不存在：${filePath}` }] }
    }

    try {
      let result
      if (format === 'markdown') {
        result = await mammoth.convertToMarkdown({ path: filePath })
      } else {
        result = await mammoth.extractRawText({ path: filePath })
      }

      const text = result.value.trim()
      const warnings = result.messages
        .filter(m => m.type === 'warning')
        .map(m => m.message)

      let output = text || '（文档内容为空）'
      if (warnings.length > 0) {
        output += `\n\n---\n⚠️ 解析警告：\n${warnings.join('\n')}`
      }

      return { content: [{ type: 'text', text: output }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ 解析失败：${err.message}` }] }
    }
  }
)

await server.connect(new StdioServerTransport())
