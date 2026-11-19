/**
 * 文件解析器注册表。
 *
 * 每种文件类型对应一个解析器（parser）：
 *   {
 *     id: string,               // 解析器标识，如 'txt'
 *     extensions: ['.txt'],     // 支持的扩展名（小写，含点）
 *     maxSize?: number,         // 超过该大小只保存、不自动解析
 *     parse(buffer, opts)       // → { text, meta }；text 是给模型的预览文本
 *   }
 *
 * 扩展新类型（pdf / word / 图片 …）时：
 *   在本目录新建 parser 文件，并在下面的 BUILTIN_PARSERS 里注册即可。
 *   收文件流程与 prompt 组装不需要任何改动。
 */

import path from 'path'
import txtParser from './txt.mjs'
import mdParser from './md.mjs'
import docxParser from './docx.mjs'
import xlsxParser from './xlsx.mjs'
import pdfParser from './pdf.mjs'

const BUILTIN_PARSERS = [txtParser, mdParser, docxParser, xlsxParser, pdfParser]

const parsers = [...BUILTIN_PARSERS]

export function registerParser(parser) {
  if (!parser?.id || !Array.isArray(parser.extensions) || typeof parser.parse !== 'function') {
    throw new Error('parser 需要 id / extensions / parse')
  }
  parsers.push(parser)
}

export function getParserForFile(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase()
  if (!ext) return null
  return parsers.find(p => p.extensions.includes(ext)) || null
}

export function listParsers() {
  return parsers.map(p => ({ id: p.id, extensions: [...p.extensions] }))
}

/**
 * 解析文件，生成预览。
 * @returns {Promise<{parser: string|null, text: string, meta: object}>}
 */
export async function parseFilePreview({ fileName, buffer, maxChars = 3000 }) {
  const parser = getParserForFile(fileName)
  if (!parser) {
    return { parser: null, text: '', meta: { note: '该类型暂不支持自动解析，可用 Read 工具直接读取文件' } }
  }
  if (parser.maxSize && buffer.length > parser.maxSize) {
    return { parser: parser.id, text: '', meta: { note: '文件过大，跳过自动预览（可用 Read 工具分段读取）' } }
  }
  try {
    const { text, meta } = await parser.parse(buffer, { fileName, maxChars })
    return { parser: parser.id, text: text || '', meta: meta || {} }
  } catch (err) {
    return { parser: parser.id, text: '', meta: { note: `解析失败：${err.message}` } }
  }
}
