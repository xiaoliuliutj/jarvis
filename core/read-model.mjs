/**
 * 会话只读模型（查询侧）。
 *
 * 把 messages.jsonl 的原始记录映射成 App 展示用的 UI 消息，并缓存映射结果。
 * - 原始行缓存由 core/user-store.mjs 负责（按 size+mtime 失效，写路径增量更新）
 * - 这里用 WeakMap 以「一次解析产出的 rows 数组」为 key 缓存映射结果，
 *   写路径替换数组后会自动 miss 并重算，不会返回过期视图
 * - 供 bridge 查询接口和 query worker 共用，保证两边的展示逻辑一致
 */

import fs from 'fs'
import path from 'path'
import { sessionsDir } from './paths.mjs'
import { readMessages } from './user-store.mjs'
import { isSilentText } from './text-filter.mjs'

const uiCache = new WeakMap()

// ── 尾部快照 ────────────────────────────────────────────────────────────────
// App 打开时只需要最后 120 条；把最近 200 条 UI 消息缓存成单独文件，
// 冷启动/重启后直接读快照（几百 KB），不用解析整个 messages.jsonl（几 MB）。
const SNAP_VERSION = 1
const SNAP_MAX = 200
const SNAP_THROTTLE_MS = 10_000
const lastSnapWrite = new Map()

function messagesFileOf(principalId, sessionId) {
  return path.join(sessionsDir(principalId), `${sessionId}.messages.jsonl`)
}

function snapshotFileOf(principalId, sessionId) {
  return path.join(sessionsDir(principalId), `${sessionId}.ui-snapshot.json`)
}

function statMessages(file) {
  try { return fs.statSync(file) } catch { return null }
}

function readSnapshot(principalId, sessionId, stat) {
  if (!stat) return null
  try {
    const data = JSON.parse(fs.readFileSync(snapshotFileOf(principalId, sessionId), 'utf-8'))
    if (data?.v !== SNAP_VERSION) return null
    if (data.stamp?.size !== stat.size || data.stamp?.mtimeMs !== stat.mtimeMs) return null
    if (!Array.isArray(data.messages) || !Number.isFinite(data.total)) return null
    return data
  } catch {
    return null
  }
}

function scheduleSnapshotWrite(principalId, sessionId, stat, total, messages) {
  const file = snapshotFileOf(principalId, sessionId)
  const now = Date.now()
  if (now - (lastSnapWrite.get(file) || 0) < SNAP_THROTTLE_MS) return
  lastSnapWrite.set(file, now)
  const payload = JSON.stringify({
    v: SNAP_VERSION,
    stamp: { size: stat.size, mtimeMs: stat.mtimeMs },
    total,
    messages: messages.slice(-SNAP_MAX),
    savedAt: new Date().toISOString(),
  })
  const tmp = `${file}.tmp-${process.pid}`
  fs.promises.writeFile(tmp, payload, 'utf-8')
    .then(() => fs.promises.rename(tmp, file))
    .catch(() => {})
}

function mapRow(r) {
  if (r.type === 'file' && r.fileId) {
    return {
      id: r.id,
      seq: r.seq,
      role: 'bot',
      file: {
        id: r.fileId,
        name: r.fileName,
        kind: r.kind || 'file',
        isImage: !!r.isImage,
        size: r.size,
      },
      ts: r.timestamp || '',
    }
  }
  if (r.type === 'user' && ((typeof r.text === 'string' && r.text.trim()) || (Array.isArray(r.attachments) && r.attachments.length))) {
    return {
      id: r.id,
      seq: r.seq,
      role: 'user',
      text: typeof r.text === 'string' ? r.text : '',
      attachments: (r.attachments || []).map(a => ({
        mediaId: a.id,
        fileName: a.fileName,
        name: a.fileName,
        kind: a.kind || 'file',
        mime: a.mime || '',
        size: a.size,
      })),
      ts: r.timestamp || '',
    }
  }
  if (r.type === 'assistant' && typeof r.text === 'string' && r.text.trim()) {
    const trimmed = r.text.trim()
    // 历史 silent 控制标记不要当正文展示；正常聊天里提到 silent 不受影响。
    if (r.source === 'cron' && isSilentText(trimmed)) return null
    if (/^[\[【(（]\s*silent\b[^\]】)）]*[\]】)）]$/i.test(trimmed)) return null
    return {
      id: r.id,
      seq: r.seq,
      role: 'bot',
      text: r.text,
      ts: r.timestamp || '',
    }
  }
  return null
}

/** 整个会话的 UI 消息列表（只读）。 */
export function getUiMessages(principalId, sessionId) {
  const rows = readMessages(principalId, sessionId)
  const cached = uiCache.get(rows)
  if (cached) return cached
  const messages = []
  for (const row of rows) {
    const mapped = mapRow(row)
    if (mapped) messages.push(mapped)
  }
  uiCache.set(rows, messages)
  return messages
}

/** 最新 limit 条（对应 /api/v1/session/current）。优先读尾部快照。 */
export function tailUiMessages(principalId, sessionId, limit = 120, readCursor = 0) {
  const file = messagesFileOf(principalId, sessionId)
  const stat = statMessages(file)
  if (!stat) {
    return { messages: [], total: 0, oldestSeq: 0, hasMore: false, unread: 0 }
  }
  const snap = readSnapshot(principalId, sessionId, stat)
  const firstSeq = snap?.messages?.[0]?.seq ?? Number.POSITIVE_INFINITY
  if (snap && readCursor >= firstSeq) {
    const messages = snap.messages.slice(-limit)
    return {
      messages,
      total: snap.total,
      oldestSeq: messages.length ? messages[0].seq : 0,
      hasMore: snap.total > messages.length,
      unread: snap.messages.filter(m => m.seq >= readCursor).length,
    }
  }
  const all = getUiMessages(principalId, sessionId)
  const after = statMessages(file)
  if (after && after.size === stat.size && after.mtimeMs === stat.mtimeMs) {
    scheduleSnapshotWrite(principalId, sessionId, after, all.length, all)
  }
  const messages = all.slice(-limit)
  return {
    messages,
    total: all.length,
    oldestSeq: messages.length ? messages[0].seq : 0,
    hasMore: all.length > messages.length,
    unread: all.filter(m => m.seq >= readCursor).length,
  }
}

/** 指定 seq 之前的 limit 条（对应 /api/v1/session/history）。before 为空表示从最新开始。 */
export function beforeUiMessages(principalId, sessionId, before, limit = 120) {
  const all = getUiMessages(principalId, sessionId)
  const cut = before == null || !Number.isFinite(Number(before))
    ? all.length
    : Math.max(0, Number(before))
  const eligible = all.filter(m => m.seq < cut)
  const messages = eligible.slice(-limit)
  return {
    messages,
    hasMore: eligible.length > messages.length,
    oldestSeq: messages.length ? messages[0].seq : cut,
  }
}

/** seq >= after 的增量（对应 /api/v1/sync）。范围内可走尾部快照。 */
export function afterUiMessages(principalId, sessionId, after = 0, limit = 100, readCursor = 0) {
  const file = messagesFileOf(principalId, sessionId)
  const stat = statMessages(file)
  const snap = readSnapshot(principalId, sessionId, stat)
  const firstSeq = snap?.messages?.[0]?.seq ?? Number.POSITIVE_INFINITY
  if (snap && after >= firstSeq && readCursor >= firstSeq) {
    const messages = snap.messages.filter(m => m.seq >= after).slice(0, limit)
    return {
      messages,
      cursor: messages.length ? messages[messages.length - 1].seq + 1 : after,
      lastSeq: snap.total,
      unread: snap.messages.filter(m => m.seq >= readCursor).length,
    }
  }
  const all = getUiMessages(principalId, sessionId)
  const messages = all.filter(m => m.seq >= after).slice(0, limit)
  return {
    messages,
    cursor: messages.length ? messages[messages.length - 1].seq + 1 : after,
    lastSeq: all.length,
    unread: all.filter(m => m.seq >= readCursor).length,
  }
}

/** 已读游标信息（对应 POST /api/v1/read）。requestedCursor 为空表示标记全部已读。 */
export function uiReadInfo(principalId, sessionId, requestedCursor) {
  const file = messagesFileOf(principalId, sessionId)
  const stat = statMessages(file)
  const snap = readSnapshot(principalId, sessionId, stat)
  if (snap && Array.isArray(snap.messages) && snap.messages.length) {
    const firstSeq = snap.messages[0].seq
    const latestCursor = snap.messages[snap.messages.length - 1].seq + 1
    const requested = requestedCursor == null ? latestCursor : Number(requestedCursor)
    const readCursor = Math.min(latestCursor, Math.max(0, Number.isFinite(requested) ? requested : latestCursor))
    if (readCursor >= firstSeq) {
      return {
        readCursor,
        unread: snap.messages.filter(m => m.seq >= readCursor).length,
      }
    }
  }
  const all = getUiMessages(principalId, sessionId)
  const latestCursor = all.length ? all[all.length - 1].seq + 1 : 0
  const requested = requestedCursor == null ? latestCursor : Number(requestedCursor)
  const readCursor = Math.min(latestCursor, Math.max(0, Number.isFinite(requested) ? requested : latestCursor))
  return {
    readCursor,
    unread: all.filter(m => m.seq >= readCursor).length,
  }
}

/** 旧接口 /api/history：只要用户与助手的文本消息。 */
export function historyTexts(principalId, sessionId, limit = 80) {
  return readMessages(principalId, sessionId)
    .filter(r => (r.type === 'user' || r.type === 'assistant') && typeof r.text === 'string' && r.text.trim())
    .slice(-limit)
    .map(r => ({
      role: r.type === 'user' ? 'user' : 'bot',
      text: r.text,
      ts: r.timestamp || '',
    }))
}
