/**
 * 纯文本生成器。
 */

import { renderPlainText } from './render.mjs'

export default {
  id: 'txt',
  extensions: ['.txt'],
  async build(model) {
    return Buffer.from(renderPlainText(model), 'utf8')
  },
}
