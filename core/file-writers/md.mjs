/**
 * Markdown 生成器。
 */

import { renderMarkdown } from './render.mjs'

export default {
  id: 'md',
  extensions: ['.md', '.markdown'],
  async build(model) {
    return Buffer.from(renderMarkdown(model), 'utf8')
  },
}
