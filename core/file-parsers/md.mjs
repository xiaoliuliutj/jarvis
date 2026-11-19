/**
 * Markdown 解析器。
 */

import { decodeText } from './text-utils.mjs'

export default {
  id: 'md',
  extensions: ['.md', '.markdown'],
  maxSize: 10 * 1024 * 1024,
  async parse(buffer, { maxChars = 3000 } = {}) {
    const { text, encoding } = decodeText(buffer)
    const truncated = text.length > maxChars
    const headings = (text.match(/^#{1,6}\s/gm) || []).length
    return {
      text: truncated ? text.slice(0, maxChars) : text,
      meta: {
        encoding,
        chars: text.length,
        lines: text.split('\n').length,
        headings,
        truncated,
      },
    }
  },
}
