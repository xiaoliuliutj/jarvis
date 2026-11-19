/**
 * PDF 生成器。
 *
 * 使用 pdfkit。中文需要嵌入系统字体：优先黑体（simhei.ttf），
 * 找不到时退回微软雅黑（msyh.ttc），再不行用内置字体（仅英文可用）。
 */

import fs from 'fs'
import PDFDocument from 'pdfkit'
import { normRows } from './render.mjs'

const FONT_CANDIDATES = [
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/simsun.ttc',
]

function pickFont(doc) {
  for (const file of FONT_CANDIDATES) {
    if (!fs.existsSync(file)) continue
    try {
      doc.registerFont('cjk', file)
      return 'cjk'
    } catch {
      // 换下一个候选字体
    }
  }
  return 'Helvetica'
}

export default {
  id: 'pdf',
  extensions: ['.pdf'],
  async build({ title, blocks = [], content }) {
    const doc = new PDFDocument({ size: 'A4', margin: 50 })
    const chunks = []
    doc.on('data', c => chunks.push(c))
    const finished = new Promise((resolve, reject) => {
      doc.on('end', resolve)
      doc.on('error', reject)
    })

    const font = pickFont(doc)
    doc.font(font)

    if (title) {
      doc.fontSize(20).text(String(title), { align: 'center' })
      doc.moveDown()
    }

    const renderBlock = (b) => {
      if (!b) return
      if (b.type === 'heading') {
        const size = Number(b.level) === 1 ? 16 : Number(b.level) === 3 ? 13 : 14.5
        doc.moveDown(0.6).fontSize(size).text(String(b.text || ''))
        doc.moveDown(0.3)
      } else if (b.type === 'paragraph') {
        doc.fontSize(11.5).text(String(b.text || ''), { lineGap: 3 })
        doc.moveDown(0.4)
      } else if (b.type === 'list') {
        ;(b.items || []).forEach((it, i) => {
          doc.fontSize(11.5).text(`${b.ordered ? `${i + 1}.` : '•'} ${it}`, { indent: 12, lineGap: 2 })
        })
        doc.moveDown(0.4)
      } else if (b.type === 'table') {
        const rows = normRows(b.rows)
        const header = Array.isArray(b.header) ? b.header.map(String) : []
        const all = header.length ? [header, ...rows] : rows
        const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right
        const colCount = Math.max(1, ...all.map(r => r.length))
        const colWidth = pageWidth / colCount
        for (const r of all) {
          const y = doc.y
          let x = doc.page.margins.left
          const isHeader = header.length && r === all[0]
          for (let c = 0; c < colCount; c++) {
            doc.fontSize(10).text(String(r[c] ?? ''), x, y, {
              width: colWidth - 6,
              continued: false,
              ...(isHeader ? {} : {}),
            })
            x += colWidth
          }
          doc.y = Math.max(doc.y, y + 16)
          if (doc.y > doc.page.height - doc.page.margins.bottom - 20) doc.addPage()
        }
        doc.moveDown(0.6)
      } else if (b.type === 'code') {
        doc.fontSize(10).text(String(b.text || ''), { lineGap: 2 })
        doc.moveDown(0.4)
      }
    }

    if (content != null && content !== '') {
      doc.fontSize(11.5).text(String(content), { lineGap: 3 })
    } else {
      for (const b of blocks) renderBlock(b)
    }

    doc.end()
    await finished
    return Buffer.concat(chunks)
  },
}
