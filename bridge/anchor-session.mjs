/**
 * anchor-session.mjs
 *
 * 为每个 adapter 维护专属 cwd。
 * 利用 memory-store 的 cwdHash 机制，不同 cwd = 完全独立的会话空间，
 * 无需 switchSession，与 Electron 的 cwd=E:\Jarvis 天然隔离。
 */

import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url))
const SESSIONS_ROOT = path.join(BRIDGE_DIR, 'sessions')

/**
 * 返回某 adapter 的专属 cwd。
 * agent.run() 以此为 cwd，会话 index.json 落盘在 memory-store 对应的 cwdHash 目录下。
 * 路径统一小写盘符，避免 Windows 大小写导致 cwdHash 不一致。
 */
export function getAdapterCwd(adapterId) {
  const p = path.join(SESSIONS_ROOT, adapterId)
  // Windows 盘符统一小写（e:\ 和 E:\ 的 cwdHash 不同）
  return p.replace(/^[A-Z]:/, m => m.toLowerCase())
}

/**
 * 确保 adapter 的专属 cwd 目录存在（agent.run 前调一次）。
 */
export function ensureAdapterCwdDir(adapterId) {
  fs.mkdirSync(getAdapterCwd(adapterId), { recursive: true })
}
