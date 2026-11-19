/**
 * 文件生成工具。
 *
 * 生成 txt / md / docx / xlsx / pdf 文件：
 *   - 文档型（txt/md/docx/pdf）：用 content（纯文本）或 blocks（标题/段落/列表/表格/代码）
 *   - 表格型（xlsx）：用 sheets
 * sendToUser=true 时写入发件箱，回合结束后自动发回给用户。
 *
 * 实现见 core/file-writers/ 注册表。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildFileBuffer } from '../../../core/file-writers/index.mjs'
import { logInfo, logError } from '../../../core/logger.mjs'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const principalId = process.env.JARVIS_PRINCIPAL_ID || ''

function timestamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function sanitizeFileName(name) {
  const base = path.basename(String(name || 'document'))
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return cleaned.slice(0, 80) || 'document'
}

function defaultOutDir(sendToUser) {
  const pid = principalId || 'pc-main'
  return sendToUser
    ? path.join(ROOT, 'userdata', pid, 'files', 'outbox')
    : path.join(ROOT, 'userdata', pid, 'workspace')
}

const blockSchema = z.object({
  type: z.enum(['heading', 'paragraph', 'list', 'table', 'code']).describe('块类型'),
  text: z.string().optional().describe('heading/paragraph/code 的文本'),
  level: z.number().int().min(1).max(3).optional().describe('heading 级别 1-3'),
  ordered: z.boolean().optional().describe('list 是否有序列表'),
  items: z.array(z.string()).optional().describe('list 的条目'),
  header: z.array(z.string()).optional().describe('table 表头'),
  rows: z.array(z.array(z.string())).optional().describe('table 数据行'),
})

async function handleBuild(args) {
  const { buffer, extension } = await buildFileBuffer(args.format, {
    title: args.title,
    content: args.content,
    blocks: args.blocks,
    sheets: args.sheets,
  })

  const dir = args.outDir ? path.resolve(args.outDir) : defaultOutDir(!!args.sendToUser)
  fs.mkdirSync(dir, { recursive: true })

  const base = sanitizeFileName(args.fileName || `${args.title || '文档'}_${timestamp()}`)
  const fileName = base.toLowerCase().endsWith(extension) ? base : base + extension
  const outPath = path.join(dir, fileName)
  fs.writeFileSync(outPath, buffer)

  logInfo('file.build', '', { format: args.format, bytes: buffer.length })

  return {
    path: outPath,
    format: args.format,
    sizeBytes: buffer.length,
    note: args.sendToUser
      ? '文件已放入发件箱，回合结束后会自动发回给用户。'
      : '文件已生成，可用 Read 查看或移动到发件箱发送。',
  }
}

// ── CLI 自测：node index.mjs --cli '{"format":"md","content":"hello"}' ────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
if (isMain && process.argv[2] === '--cli') {
  try {
    const args = JSON.parse(process.argv[3] || '{}')
    if (!args.outDir) args.outDir = os.tmpdir()
    console.log(JSON.stringify(await handleBuild(args), null, 2))
  } catch (err) {
    console.error('FAIL:', err.message)
    process.exitCode = 1
  }
  process.exit()
}

// ── MCP ─────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'file_builder', version: '1.0.0' })

server.tool(
  'file_builder',
  '生成文件：txt / md / docx / xlsx / pdf。' +
  '文档型（txt/md/docx/pdf）用 content（纯文本）或 blocks（结构化：标题/段落/列表/表格/代码块）；' +
  '表格型（xlsx）用 sheets（多工作表）。sendToUser=true 时直接放入发件箱，回合结束后自动发回给用户。',
  {
    format: z.enum(['txt', 'md', 'docx', 'xlsx', 'pdf']).describe('文件格式'),
    fileName: z.string().optional().describe('输出文件名（扩展名可省略，自动补全）'),
    title: z.string().optional().describe('文档标题（txt/md/docx/pdf 生效）'),
    content: z.string().optional().describe('纯文本内容（快捷方式，优先于 blocks）'),
    blocks: z.array(blockSchema).optional().describe('结构化内容块'),
    sheets: z.array(z.object({
      name: z.string().optional().describe('工作表名'),
      rows: z.array(z.array(z.union([z.string(), z.number()]))).describe('行 × 列的单元格数据'),
    })).optional().describe('xlsx 工作表数据'),
    sendToUser: z.boolean().optional().describe('直接发回给用户（写入发件箱），默认 false'),
    outDir: z.string().optional().describe('可选：输出目录（默认当前用户工作区）'),
  },
  async (args) => {
    try {
      const result = await handleBuild(args)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      logError('file.build.fail', err.message, { format: args.format })
      return { content: [{ type: 'text', text: `❌ ${err.message}` }] }
    }
  }
)

await server.connect(new StdioServerTransport())
