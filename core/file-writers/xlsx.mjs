/**
 * Excel (.xlsx) 生成器。
 *
 * 使用 SheetJS：sheets 数组 → 多个工作表。
 *   { sheets: [{ name?: string, rows: [[cell, ...], ...] }] }
 */

import * as XLSX from 'xlsx'

export default {
  id: 'xlsx',
  extensions: ['.xlsx'],
  async build({ sheets = [] }) {
    const wb = XLSX.utils.book_new()
    const list = Array.isArray(sheets) && sheets.length ? sheets : [{ name: 'Sheet1', rows: [] }]
    list.forEach((s, idx) => {
      const rows = Array.isArray(s?.rows) ? s.rows : []
      const ws = XLSX.utils.aoa_to_sheet(rows)
      const name = String(s?.name || `Sheet${idx + 1}`).slice(0, 31)
      XLSX.utils.book_append_sheet(wb, ws, name)
    })
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  },
}
