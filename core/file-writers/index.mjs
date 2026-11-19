/**
 * 文件生成器注册表。
 *
 * 每种格式对应一个 writer：
 *   {
 *     id: 'docx',
 *     extensions: ['.docx'],
 *     build(model) → Promise<Buffer>
 *   }
 *
 * 统一文档模型 model：
 *   { title?, content?, blocks? }        —— txt / md / docx / pdf
 *   { sheets: [{ name?, rows: [[...]] }] } —— xlsx
 *
 * 扩展新格式（如 pptx、csv）：在目录下新建 writer 文件并加入 BUILTIN_WRITERS。
 */

import txtWriter from './txt.mjs'
import mdWriter from './md.mjs'
import docxWriter from './docx.mjs'
import xlsxWriter from './xlsx.mjs'
import pdfWriter from './pdf.mjs'

const BUILTIN_WRITERS = [txtWriter, mdWriter, docxWriter, xlsxWriter, pdfWriter]

const writers = [...BUILTIN_WRITERS]

export function registerWriter(writer) {
  if (!writer?.id || typeof writer.build !== 'function') {
    throw new Error('writer 需要 id / build')
  }
  writers.push(writer)
}

export function getWriter(formatOrExt) {
  const key = String(formatOrExt || '').toLowerCase().replace(/^\./, '')
  return writers.find(w => w.id === key || w.extensions.includes(`.${key}`)) || null
}

export function listWriterFormats() {
  return writers.map(w => ({ id: w.id, extensions: [...w.extensions] }))
}

/**
 * 根据格式生成文件 Buffer。
 * @param {string} format 'txt' | 'md' | 'docx' | 'xlsx' | 'pdf'
 * @param {object} model 文档模型
 * @returns {Promise<Buffer>}
 */
export async function buildFileBuffer(format, model) {
  const writer = getWriter(format)
  if (!writer) throw new Error(`不支持的格式：${format}（支持：${listWriterFormats().map(w => w.id).join(', ')}）`)
  const buffer = await writer.build(model || {})
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error(`生成 ${format} 失败：输出为空`)
  }
  return { buffer, extension: writer.extensions[0] }
}
