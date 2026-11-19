/**
 * PDF 解析器。
 *
 * 使用 pdf-parse（v2 的 PDFParse API）提取文本。
 * 扫描件（图片型 PDF）提取不到文字时会给出提示。
 */

import { PDFParse } from 'pdf-parse'

export default {
  id: 'pdf',
  extensions: ['.pdf'],
  maxSize: 20 * 1024 * 1024,
  async parse(buffer, { maxChars = 3000 } = {}) {
    const parser = new PDFParse({ data: buffer })
    try {
      const result = await parser.getText()
      const text = String(result?.text || '').replace(/\n{3,}/g, '\n\n').trim()
      const truncated = text.length > maxChars
      const pages = result?.total ?? (Array.isArray(result?.pages) ? result.pages.length : undefined)
      return {
        text: truncated ? text.slice(0, maxChars) : text,
        meta: {
          ...(pages !== undefined ? { pages } : {}),
          chars: text.length,
          truncated,
          ...(text ? {} : { note: '未提取到文字：可能是扫描件/图片型 PDF，可转图片后让我查看' }),
        },
      }
    } finally {
      try { await parser.destroy() } catch {}
    }
  },
}
