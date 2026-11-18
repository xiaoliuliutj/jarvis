/**
 * 用 Node.js Canvas 生成高质量 ICO 图标
 * 需要安装 canvas: npm install canvas
 */
import { createCanvas } from 'canvas'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function drawIcon(size) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const s = size
  const cx = s / 2, cy = s / 2

  // 背景：圆角矩形，深紫色
  const r = s * 0.22
  ctx.beginPath()
  ctx.moveTo(r, 0)
  ctx.lineTo(s - r, 0)
  ctx.quadraticCurveTo(s, 0, s, r)
  ctx.lineTo(s, s - r)
  ctx.quadraticCurveTo(s, s, s - r, s)
  ctx.lineTo(r, s)
  ctx.quadraticCurveTo(0, s, 0, s - r)
  ctx.lineTo(0, r)
  ctx.quadraticCurveTo(0, 0, r, 0)
  ctx.closePath()
  const bg = ctx.createLinearGradient(0, 0, s, s)
  bg.addColorStop(0, '#120e2a')
  bg.addColorStop(1, '#38205f')
  ctx.fillStyle = bg
  ctx.fill()

  // 外圈光晕
  const glow = ctx.createRadialGradient(cx, cy, s * 0.1, cx, cy, s * 0.45)
  glow.addColorStop(0, 'rgba(140,110,255,0.3)')
  glow.addColorStop(1, 'rgba(140,110,255,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, s, s)

  // 神经网络：6条辐射线 + 末端节点
  const armR = s * 0.34
  const nodeR = s * 0.055
  for (let i = 0; i < 6; i++) {
    const angle = (i * 60 - 90) * Math.PI / 180
    const ex = cx + armR * Math.cos(angle)
    const ey = cy + armR * Math.sin(angle)
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(ex, ey)
    ctx.strokeStyle = `rgba(160,140,255,0.5)`
    ctx.lineWidth = s * 0.018
    ctx.stroke()
    // 末端节点
    ctx.beginPath()
    ctx.arc(ex, ey, nodeR, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(170,150,255,0.7)'
    ctx.fill()
  }

  // 中心圆：亮紫色核心
  const coreR = s * 0.14
  const core = ctx.createRadialGradient(cx - coreR * 0.2, cy - coreR * 0.2, coreR * 0.1, cx, cy, coreR)
  core.addColorStop(0, '#e0d0ff')
  core.addColorStop(0.4, '#a080f0')
  core.addColorStop(1, 'rgba(80,50,160,0)')
  ctx.beginPath()
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2)
  ctx.fillStyle = core
  ctx.fill()

  // 中心点：纯白亮点
  ctx.beginPath()
  ctx.arc(cx, cy, s * 0.04, 0, Math.PI * 2)
  ctx.fillStyle = '#ffffff'
  ctx.fill()

  return canvas
}

// 生成各尺寸 PNG
const sizes = [16, 32, 48, 64, 128, 256]
const pngBuffers = sizes.map(s => drawIcon(s).toBuffer('image/png'))

// 保存 256px 预览
fs.writeFileSync(path.join(ROOT, 'jarvis-preview.png'), pngBuffers[5])
console.log('Preview saved: jarvis-preview.png')

// 写 ICO 文件
const icoBuffers = []
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)   // reserved
header.writeUInt16LE(1, 2)   // type: ico
header.writeUInt16LE(sizes.length, 4)  // count
icoBuffers.push(header)

const entrySize = 16
let dataOffset = 6 + entrySize * sizes.length
for (let i = 0; i < sizes.length; i++) {
  const entry = Buffer.alloc(entrySize)
  const w = sizes[i] === 256 ? 0 : sizes[i]
  const h = sizes[i] === 256 ? 0 : sizes[i]
  entry.writeUInt8(w, 0)
  entry.writeUInt8(h, 1)
  entry.writeUInt8(0, 2)
  entry.writeUInt8(0, 3)
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(pngBuffers[i].length, 8)
  entry.writeUInt32LE(dataOffset, 12)
  dataOffset += pngBuffers[i].length
  icoBuffers.push(entry)
}
for (const buf of pngBuffers) icoBuffers.push(buf)

fs.writeFileSync(path.join(ROOT, 'jarvis.ico'), Buffer.concat(icoBuffers))
console.log('ICO created: jarvis.ico')
