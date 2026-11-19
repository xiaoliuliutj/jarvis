/**
 * 纯文本解析器。
 *
 * 自动识别 UTF-8 / GB18030（含 GBK）编码。
 * 解析结果只用于给模型的预览，完整内容仍可让模型用 Read 工具读取原文件。
 */

function decodeText(buffer) {
  for (const enc of ['utf-8', 'gb18030']) {
    try {
      return { text: new TextDecoder(enc, { fatal: true }).decode(buffer), encoding: enc }
    } catch {
      // 换下一种编码继续尝试
    }
  }
  return { text: buffer.toString('utf8'), encoding: 'utf-8(fallback)' }
}

export default {
  id: 'txt',
  extensions: ['.txt'],
  maxSize: 10 * 1024 * 1024,
  async parse(buffer, { maxChars = 3000 } = {}) {
    const { text, encoding } = decodeText(buffer)
    const truncated = text.length > maxChars
    return {
      text: truncated ? text.slice(0, maxChars) : text,
      meta: {
        encoding,
        chars: text.length,
        lines: text.split('\n').length,
        truncated,
      },
    }
  },
}
