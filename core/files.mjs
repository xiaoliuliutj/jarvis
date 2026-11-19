/**
 * 用户文件收发（系统能力，不是工具）。
 *
 * 设计原则：
 *   - adapter 只负责「传输」（下载/上传），本模块负责其余全部逻辑；
 *   - 收（inbound）与发（outbound）共用同一套目录/命名/安全检查；
 *   - 解析按文件类型走 file-parsers 注册表，新增类型不改本文件；
 *   - 目录按 principal 隔离：userdata/<principalId>/files/…
 *
 * 目录约定：
 *   files/inbox/            收到的文件
 *   files/outbox/           Jarvis 生成的待发送文件（回合结束后自动发出）
 *   files/outbox/sent/      已发送归档
 */

import fs from 'fs'
import path from 'path'
import { inboxDir, outboxDir, sentDir, ensureDir } from './paths.mjs'
import { parseFilePreview } from './file-parsers/index.mjs'

export const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024        // 单个附件上限 20MB
export const MAX_ATTACHMENTS_PER_MESSAGE = 3              // 每条消息最多处理 3 个附件
const INBOX_KEEP_DAYS = 7                                 // 收件箱保留天数
const INBOX_KEEP_COUNT = 100                              // 收件箱最多保留文件数

// ── 目录与命名 ───────────────────────────────────────────────────────────────

export function ensureFileDirs(principalId) {
  ensureDir(inboxDir(principalId))
  ensureDir(sentDir(principalId))
}

function timestamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 去掉路径分隔符、非法字符，防止路径穿越与覆盖 */
export function sanitizeFileName(fileName) {
  const base = path.basename(String(fileName || 'file'))
  const cleaned = base
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.slice(0, 80) || 'file'
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// ── 收件 ────────────────────────────────────────────────────────────────────

/**
 * 保存入站附件到收件箱。
 * @param {string} principalId
 * @param {Array<{kind?:string, fileName?:string, buffer?:Buffer}>} attachments
 * @returns {Array<{path:string, name:string, size:number, kind:string, buffer:Buffer}>}
 */
export function saveInboundFiles(principalId, attachments = []) {
  const accepted = attachments
    .filter(a => a && Buffer.isBuffer(a.buffer))
    .slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
  if (!accepted.length) return []

  ensureFileDirs(principalId)
  const saved = []
  for (const att of accepted) {
    if (att.buffer.length > MAX_ATTACHMENT_SIZE) {
      console.warn(`[files] 附件过大，跳过: ${att.fileName} (${formatSize(att.buffer.length)})`)
      continue
    }
    const name = sanitizeFileName(att.fileName || `file_${timestamp()}`)
    let target = path.join(inboxDir(principalId), `${timestamp()}_${name}`)
    // 极短时间内的重名兜底
    if (fs.existsSync(target)) {
      target = path.join(inboxDir(principalId), `${timestamp()}_${Math.random().toString(36).slice(2, 6)}_${name}`)
    }
    fs.writeFileSync(target, att.buffer)
    saved.push({ path: target, name, size: att.buffer.length, kind: att.kind || 'file', buffer: att.buffer })
  }
  pruneInbox(principalId)
  return saved
}

/** 收件箱清理：超过保留期或数量上限的旧文件自动删除 */
function pruneInbox(principalId) {
  try {
    const dir = inboxDir(principalId)
    const files = fs.readdirSync(dir)
      .map(name => {
        const p = path.join(dir, name)
        const st = fs.statSync(p)
        return st.isFile() ? { path: p, mtimeMs: st.mtimeMs } : null
      })
      .filter(Boolean)
      .sort((a, b) => a.mtimeMs - b.mtimeMs)

    const cutoff = Date.now() - INBOX_KEEP_DAYS * 24 * 60 * 60 * 1000
    const overflow = files.length - INBOX_KEEP_COUNT
    files.forEach((f, i) => {
      if (f.mtimeMs < cutoff || i < overflow) {
        try { fs.unlinkSync(f.path) } catch {}
      }
    })
  } catch (err) {
    console.warn('[files] 收件箱清理失败:', err.message)
  }
}

/**
 * 把入站附件落盘并组装成 prompt 附加块。
 * @returns {Promise<string>} 无有效附件时返回空字符串
 */
export async function prepareInbound(principalId, attachments = []) {
  const saved = saveInboundFiles(principalId, attachments)
  if (!saved.length) return ''

  const lines = [`【系统】用户发来了 ${saved.length} 个文件（已保存到收件箱）：`]
  for (const [i, f] of saved.entries()) {
    const preview = await parseFilePreview({ fileName: f.name, buffer: f.buffer, maxChars: 3000 })
    const metaParts = []
    if (preview.meta?.encoding) metaParts.push(`编码 ${preview.meta.encoding}`)
    if (preview.meta?.lines != null) metaParts.push(`${preview.meta.lines} 行`)
    metaParts.push(formatSize(f.size))

    lines.push(`\n${i + 1}. ${f.name}（${metaParts.join('，')}）`)
    lines.push(`   保存路径：${f.path}`)

    if (preview.text) {
      lines.push(`   内容预览（前 3000 字${preview.meta?.truncated ? '，已截断' : ''}）：`)
      lines.push(preview.text)
    } else if (preview.meta?.note) {
      lines.push(`   说明：${preview.meta.note}`)
    }
  }
  lines.push('\n处理提示：需要完整内容时，用 Read 工具读取上面的保存路径。')
  return lines.join('\n')
}

// ── 发件 ────────────────────────────────────────────────────────────────────

/** 列出待发送的文件（不含 sent 归档目录，按修改时间升序） */
export function listOutboxFiles(principalId) {
  const dir = outboxDir(principalId)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .map(name => {
      const p = path.join(dir, name)
      const st = fs.statSync(p)
      return st.isFile() ? { path: p, name, size: st.size, mtimeMs: st.mtimeMs } : null
    })
    .filter(Boolean)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
}

/** 发送成功后归档到 outbox/sent/ */
export function markOutboxSent(principalId, filePath) {
  ensureDir(sentDir(principalId))
  const name = path.basename(filePath)
  let target = path.join(sentDir(principalId), `${timestamp()}_${name}`)
  if (fs.existsSync(target)) {
    target = path.join(sentDir(principalId), `${timestamp()}_${Math.random().toString(36).slice(2, 6)}_${name}`)
  }
  fs.renameSync(filePath, target)
  return target
}
