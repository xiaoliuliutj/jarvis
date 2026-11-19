/**
 * Word (.docx) 生成器。
 *
 * 使用 docx 库，把统一块模型翻译成 Word 段落/列表/表格。
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
} from 'docx'
import { normRows } from './render.mjs'

const HEADING_BY_LEVEL = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
}

function tableFromBlock(b) {
  const rows = []
  if (Array.isArray(b.header) && b.header.length) {
    rows.push(new TableRow({
      tableHeader: true,
      children: b.header.map(h => new TableCell({
        width: { size: 100 / b.header.length, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ children: [new TextRun({ text: String(h ?? ''), bold: true })] })],
      })),
    }))
  }
  for (const r of normRows(b.rows)) {
    rows.push(new TableRow({
      children: r.map(c => new TableCell({
        children: [new Paragraph(String(c))],
      })),
    }))
  }
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })
}

export default {
  id: 'docx',
  extensions: ['.docx'],
  async build({ title, blocks = [], content }) {
    const children = []

    if (title) {
      children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }))
    }

    if (content != null && content !== '') {
      for (const line of String(content).split(/\r?\n/)) {
        children.push(new Paragraph({ children: [new TextRun(line)] }))
      }
    } else {
      for (const b of blocks) {
        if (!b) continue
        if (b.type === 'heading') {
          children.push(new Paragraph({
            text: b.text || '',
            heading: HEADING_BY_LEVEL[Number(b.level) || 2] || HeadingLevel.HEADING_2,
          }))
        } else if (b.type === 'paragraph') {
          children.push(new Paragraph(String(b.text || '')))
        } else if (b.type === 'list') {
          for (const it of b.items || []) {
            children.push(new Paragraph({
              text: String(it),
              ...(b.ordered ? { numbering: { reference: 'num-list', level: 0 } } : { bullet: { level: 0 } }),
            }))
          }
        } else if (b.type === 'table') {
          children.push(tableFromBlock(b))
          children.push(new Paragraph(''))
        } else if (b.type === 'code') {
          children.push(new Paragraph({
            children: [new TextRun({ text: String(b.text || ''), font: 'Consolas' })],
          }))
        }
      }
    }

    const doc = new Document({
      numbering: {
        config: [{
          reference: 'num-list',
          levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: 'start' }],
        }],
      },
      sections: [{ children }],
    })
    return await Packer.toBuffer(doc)
  },
}
