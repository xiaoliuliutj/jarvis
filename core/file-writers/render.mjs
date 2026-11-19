/**
 * 文档块模型渲染工具。
 *
 * 统一的块模型（blocks）：
 *   { type: 'heading',   level?: 1-3, text }
 *   { type: 'paragraph', text }
 *   { type: 'list',      ordered?: bool, items: [string] }
 *   { type: 'table',     header?: [string], rows: [[string]] }
 *   { type: 'code',      text }
 *
 * txt / md 直接由块模型渲染；docx / pdf 各自把块翻译成对应元素。
 */

export function normRows(rows = []) {
  return rows.map(r => (Array.isArray(r) ? r : [r]).map(c => String(c ?? '')))
}

/** 渲染为纯文本 */
export function renderPlainText({ title, blocks = [], content }) {
  const lines = []
  if (title) {
    lines.push(title)
    lines.push('-'.repeat(Math.min(48, [...title].length * 2 || 8)))
    lines.push('')
  }
  if (content != null && content !== '') {
    lines.push(String(content))
    return lines.join('\n').trim() + '\n'
  }
  for (const b of blocks) {
    if (!b) continue
    if (b.type === 'heading') {
      lines.push(`【${b.text || ''}】`, '')
    } else if (b.type === 'paragraph') {
      lines.push(String(b.text || ''), '')
    } else if (b.type === 'list') {
      ;(b.items || []).forEach((it, i) => lines.push(`${b.ordered ? `${i + 1}.` : '-'} ${it}`))
      lines.push('')
    } else if (b.type === 'table') {
      normRows(b.rows).forEach(r => lines.push(r.join('\t')))
      lines.push('')
    } else if (b.type === 'code') {
      lines.push(String(b.text || ''), '')
    }
  }
  return lines.join('\n').trim() + '\n'
}

/** 渲染为 Markdown */
export function renderMarkdown({ title, blocks = [], content }) {
  const lines = []
  if (title) lines.push(`# ${title}`, '')
  if (content != null && content !== '') {
    lines.push(String(content))
    return lines.join('\n').trim() + '\n'
  }
  for (const b of blocks) {
    if (!b) continue
    if (b.type === 'heading') {
      const level = Math.min(6, Math.max(1, Number(b.level) || 2))
      lines.push(`${'#'.repeat(level)} ${b.text || ''}`, '')
    } else if (b.type === 'paragraph') {
      lines.push(String(b.text || ''), '')
    } else if (b.type === 'list') {
      ;(b.items || []).forEach((it, i) => lines.push(`${b.ordered ? `${i + 1}.` : '-'} ${it}`))
      lines.push('')
    } else if (b.type === 'table') {
      const header = (b.header || []).map(String)
      const rows = normRows(b.rows)
      if (header.length) lines.push(`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`)
      rows.forEach(r => lines.push(`| ${r.join(' | ')} |`))
      lines.push('')
    } else if (b.type === 'code') {
      lines.push('```', String(b.text || ''), '```', '')
    }
  }
  return lines.join('\n').trim() + '\n'
}
