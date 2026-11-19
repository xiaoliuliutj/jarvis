/**
 * 结构化日志。
 *
 * 输出：logs/YYYY-MM-DD.jsonl（每天一个文件，JSONL，每行一条）
 *   条目结构：{ ts, level, event, message, ...meta }
 *   同时输出一行到控制台，保持终端可见性。
 *
 * 每晚自检任务会扫描这些日志；保留 30 天，自动清理更早的文件。
 *
 * 用法：
 *   import { logInfo, logWarn, logError } from '../core/logger.mjs'
 *   logInfo('message.in', '', { principalId, sourceType })
 *   logError('reply.fail', err.message, { principalId })
 */

import fs from 'fs'
import path from 'path'
import { logsDir, ensureDir } from './paths.mjs'

const KEEP_DAYS = 30
let lastPruneDay = ''

function dayStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function dayFile(d = new Date()) {
  return path.join(logsDir(), `${dayStamp(d)}.jsonl`)
}

/** 每天最多清理一次过期日志 */
function pruneOldLogs() {
  const today = dayStamp()
  if (lastPruneDay === today) return
  lastPruneDay = today
  try {
    const dir = logsDir()
    if (!fs.existsSync(dir)) return
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const p = path.join(dir, name)
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p)
      } catch {}
    }
  } catch {}
}

export function logEvent(level, event, message = '', meta = {}) {
  try {
    ensureDir(logsDir())
    pruneOldLogs()
    const entry = {
      ts: new Date().toISOString(),
      level,
      event,
      message: String(message ?? '').slice(0, 500),
      ...meta,
    }
    fs.appendFileSync(dayFile(), JSON.stringify(entry) + '\n', 'utf-8')
  } catch {
    // 日志失败不影响主流程
  }
  const line = `[${level}] ${event}${message ? ': ' + message : ''}`
  if (level === 'error') console.error(line)
  else console.log(line)
}

export function logInfo(event, message = '', meta = {}) {
  logEvent('info', event, message, meta)
}

export function logWarn(event, message = '', meta = {}) {
  logEvent('warn', event, message, meta)
}

export function logError(event, message = '', meta = {}) {
  logEvent('error', event, message, meta)
}
