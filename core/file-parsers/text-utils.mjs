/**
 * 文本类文件共用的解码工具。
 */

/** 自动识别 UTF-8 / GB18030（含 GBK）解码 */
export function decodeText(buffer) {
  for (const enc of ['utf-8', 'gb18030']) {
    try {
      return { text: new TextDecoder(enc, { fatal: true }).decode(buffer), encoding: enc }
    } catch {
      // 换下一种编码继续尝试
    }
  }
  return { text: buffer.toString('utf8'), encoding: 'utf-8(fallback)' }
}
