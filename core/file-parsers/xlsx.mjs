/**
 * Excel (.xlsx / .xls) 解析器。
 *
 * 使用 SheetJS 读取，每个工作表转成 CSV 文本拼接，便于模型直接阅读。
 */

import * as XLSX from 'xlsx'

export default {
  id: 'xlsx',
  extensions: ['.xlsx', '.xls'],
  maxSize: 15 * 1024 * 1024,
  async parse(buffer, { maxChars = 3000 } = {}) {
    const wb = XLSX.read(buffer, { type: 'buffer' })
    const sheetNames = wb.SheetNames || []
    const parts = []
    for (const name of sheetNames) {
      const ws = wb.Sheets[name]
      const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false }).trim()
      parts.push(`=== 工作表: ${name} ===\n${csv}`)
    }
    const text = parts.join('\n\n').trim()
    const truncated = text.length > maxChars
    return {
      text: truncated ? text.slice(0, maxChars) : text,
      meta: {
        sheets: sheetNames,
        chars: text.length,
        truncated,
        ...(text ? {} : { note: '工作表中没有可读内容' }),
      },
    }
  },
}
