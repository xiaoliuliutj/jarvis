/**
 * Word (.docx) 解析器。
 *
 * 使用 mammoth 提取纯文本。完整内容仍可用 read_word 工具或 mammoth 的 markdown 模式查看。
 */

import mammoth from 'mammoth'

export default {
  id: 'docx',
  extensions: ['.docx'],
  maxSize: 15 * 1024 * 1024,
  async parse(buffer, { maxChars = 3000 } = {}) {
    const result = await mammoth.extractRawText({ buffer })
    const text = String(result.value || '').trim()
    const truncated = text.length > maxChars
    return {
      text: truncated ? text.slice(0, maxChars) : text,
      meta: {
        chars: text.length,
        paragraphs: text.split(/\n+/).filter(Boolean).length,
        warnings: (result.messages || []).filter(m => m.type === 'warning').length,
        truncated,
      },
    }
  },
}
