/**
 * 表情库（抽象图 / 表情包收藏）。
 *
 * 每个 principal 独立一份，永久保留（不参与截图/收件箱的自动清理）：
 *   userdata/<principalId>/stickers/            图片文件
 *   userdata/<principalId>/stickers/index.json  元数据索引
 *
 * 索引条目：
 *   { id, file, caption, scene, prompt, tags, source, sizeBytes, createdAt }
 */

import fs from 'fs'
import path from 'path'
import { stickerDir, stickerIndexFile, ensureDir } from './paths.mjs'

const MAX_LIBRARY_IMAGES = 500

function nowId() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  const rand = Math.random().toString(36).slice(2, 6)
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rand}`
}

function readIndex(principalId) {
  try {
    const file = stickerIndexFile(principalId)
    if (!fs.existsSync(file)) return []
    const list = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function writeIndex(principalId, list) {
  ensureDir(stickerDir(principalId))
  fs.writeFileSync(stickerIndexFile(principalId), JSON.stringify(list, null, 2), 'utf-8')
}

/**
 * 保存一张图片到表情库。
 * @param {string} principalId
 * @param {Buffer} buffer
 * @param {{caption?: string, scene?: string, prompt?: string, tags?: string[], source?: string, ext?: string}} meta
 * @returns {{id, file, caption, scene, tags, createdAt, sizeBytes}}
 */
export function saveSticker(principalId, buffer, meta = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('保存表情失败：图片为空')
  ensureDir(stickerDir(principalId))

  const id = nowId()
  const ext = meta.ext || '.png'
  const file = path.join(stickerDir(principalId), `sb_${id}${ext}`)
  fs.writeFileSync(file, buffer)

  const entry = {
    id,
    file: `sb_${id}${ext}`,
    caption: meta.caption || '',
    scene: meta.scene || '',
    prompt: (meta.prompt || '').slice(0, 500),
    tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 10) : [],
    source: meta.source || 'generate',
    sizeBytes: buffer.length,
    createdAt: new Date().toISOString(),
  }

  const list = readIndex(principalId)
  list.unshift(entry)
  // 数量上限：超出删最旧的（文件和索引一起）
  while (list.length > MAX_LIBRARY_IMAGES) {
    const dropped = list.pop()
    try { fs.unlinkSync(path.join(stickerDir(principalId), dropped.file)) } catch {}
  }
  writeIndex(principalId, list)
  return entry
}

/**
 * 列出/搜索表情库。
 * @param {string} principalId
 * @param {{query?: string, limit?: number}} opts
 */
export function listStickers(principalId, { query = '', limit = 20 } = {}) {
  const q = String(query || '').toLowerCase().trim()
  let list = readIndex(principalId)
  if (q) {
    list = list.filter(e =>
      [e.caption, e.scene, e.prompt, (e.tags || []).join(' ')].join(' ').toLowerCase().includes(q)
    )
  }
  return list.slice(0, Math.max(1, Math.min(100, limit)))
}

/** 按 id 取一条（含绝对路径） */
export function getSticker(principalId, id) {
  const entry = readIndex(principalId).find(e => e.id === id)
  if (!entry) return null
  const absPath = path.join(stickerDir(principalId), entry.file)
  if (!fs.existsSync(absPath)) return null
  return { ...entry, path: absPath }
}

export function stickerStats(principalId) {
  const list = readIndex(principalId)
  return { count: list.length }
}
