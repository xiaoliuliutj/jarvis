import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import { ensureUser, workspaceDir } from '../../../../core/user-store.mjs'

// 笔记属于当前用户，写在 userdata/<principalId>/workspace/notes 下。
const principalId = process.env.JARVIS_PRINCIPAL_ID
if (!principalId) throw new Error('缺少 JARVIS_PRINCIPAL_ID')
ensureUser(principalId)
const NOTES_DIR = path.join(workspaceDir(principalId), 'notes')
fs.mkdirSync(NOTES_DIR, { recursive: true })

const TASKS_FILE    = path.join(NOTES_DIR, 'tasks.md')
const SCHEDULE_FILE = path.join(NOTES_DIR, 'schedule.md')

function ensureFile(file, header) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, header + '\n', 'utf-8')
}

function readFile(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
}

const server = new McpServer({ name: 'notes', version: '1.0.0' })

// ── 添加记录 ──────────────────────────────────────────────────────────────────
server.tool(
  'notes__add',
  '添加一条记录。type=task(待办), note(笔记/资料), schedule(日程)',
  {
    type:    z.enum(['task', 'note', 'schedule']).describe('记录类型'),
    title:   z.string().describe('标题或简短描述'),
    content: z.string().optional().describe('详细内容（可选）'),
    tag:     z.string().optional().describe('note 专用：标签/分类，同标签存入同一文件（如 frontend, email, calendar）'),
    due:     z.string().optional().describe('schedule/task 专用：截止或计划时间，格式 YYYY-MM-DD 或自然语言'),
  },
  async ({ type, title, content, tag, due }) => {
    const now = new Date().toLocaleString('zh-CN', { hour12: false })
    const dateStr = new Date().toISOString().slice(0, 10)

    if (type === 'task') {
      ensureFile(TASKS_FILE, '# 待办事项\n')
      const dueStr = due ? ` (due: ${due})` : ''
      const body = content ? `\n  ${content.replace(/\n/g, '\n  ')}` : ''
      fs.appendFileSync(TASKS_FILE, `\n- [ ] **${title}**${dueStr} _(${dateStr})_${body}\n`, 'utf-8')
      return { content: [{ type: 'text', text: `✅ 已添加任务：${title}` }] }
    }

    if (type === 'schedule') {
      ensureFile(SCHEDULE_FILE, '# 日程安排\n')
      const timeStr = due || dateStr
      const body = content ? `\n  ${content.replace(/\n/g, '\n  ')}` : ''
      fs.appendFileSync(SCHEDULE_FILE, `\n- **${timeStr}** ${title}${body}\n`, 'utf-8')
      return { content: [{ type: 'text', text: `✅ 已添加日程：${title}` }] }
    }

    if (type === 'note') {
      const fileTag = (tag || 'general').replace(/[^a-zA-Z0-9_一-龥-]/g, '_')
      const noteFile = path.join(NOTES_DIR, `${fileTag}.md`)
      ensureFile(noteFile, `# 笔记：${tag || '通用'}\n`)
      const body = content ? `\n${content}\n` : ''
      fs.appendFileSync(noteFile, `\n## ${title} _(${now})_${body}\n`, 'utf-8')
      return { content: [{ type: 'text', text: `✅ 已添加笔记 [${fileTag}]：${title}` }] }
    }
  }
)

// ── 查看记录 ──────────────────────────────────────────────────────────────────
server.tool(
  'notes__read',
  '读取指定类型的记录文件',
  {
    type: z.enum(['task', 'schedule', 'note']).describe('记录类型'),
    tag:  z.string().optional().describe('note 专用：标签，不传则列出所有笔记文件名'),
  },
  async ({ type, tag }) => {
    if (type === 'task') {
      const text = readFile(TASKS_FILE) || '（暂无待办）'
      return { content: [{ type: 'text', text }] }
    }
    if (type === 'schedule') {
      const text = readFile(SCHEDULE_FILE) || '（暂无日程）'
      return { content: [{ type: 'text', text }] }
    }
    if (type === 'note') {
      if (!tag) {
        const files = fs.existsSync(NOTES_DIR)
          ? fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.md') && f !== 'tasks.md' && f !== 'schedule.md')
          : []
        return { content: [{ type: 'text', text: files.length ? files.join('\n') : '（暂无笔记）' }] }
      }
      const fileTag = tag.replace(/[^a-zA-Z0-9_一-龥-]/g, '_')
      const noteFile = path.join(NOTES_DIR, `${fileTag}.md`)
      const text = readFile(noteFile) || `（暂无 [${tag}] 笔记）`
      return { content: [{ type: 'text', text }] }
    }
  }
)

// ── 完成/删除任务 ─────────────────────────────────────────────────────────────
server.tool(
  'notes__task_done',
  '将 tasks.md 中某个待办标记为已完成（将 "- [ ]" 改为 "- [x]"）',
  {
    keyword: z.string().describe('任务标题的关键词，用于匹配'),
  },
  async ({ keyword }) => {
    if (!fs.existsSync(TASKS_FILE)) return { content: [{ type: 'text', text: '暂无待办文件' }] }
    const content = fs.readFileSync(TASKS_FILE, 'utf-8')
    const lines = content.split('\n')
    let count = 0
    const updated = lines.map(line => {
      if (line.startsWith('- [ ]') && line.includes(keyword)) {
        count++
        return line.replace('- [ ]', '- [x]')
      }
      return line
    })
    if (count === 0) return { content: [{ type: 'text', text: `未找到包含 "${keyword}" 的待办` }] }
    fs.writeFileSync(TASKS_FILE, updated.join('\n'), 'utf-8')
    return { content: [{ type: 'text', text: `✅ 已标记 ${count} 条任务为完成` }] }
  }
)

await server.connect(new StdioServerTransport())
