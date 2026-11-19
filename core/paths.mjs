/**
 * 全局路径定义。
 *
 * 目录约定（与 REQUIREMENTS.md 对齐）：
 *   config/           用户配置（实际文件不入库）
 *   userdata/         每个 principal 的会话/记忆/工作区/人设/cron，不入库
 *   userdata/tools/   用户创建的工具，所有用户共享加载
 *   agents/tools/     系统工具，所有用户可用，只有 maintainer/owner 可改
 *   agents/memory|sessions/  历史遗留的全局记忆/会话，已停用但保留
 */

import path from 'path'
import fs from 'fs'

export const ROOT = path.resolve(import.meta.dirname, '..')

export const CONFIG_DIR = path.join(ROOT, 'config')
export const USERDATA_DIR = path.join(ROOT, 'userdata')
export const USER_TOOLS_DIR = path.join(USERDATA_DIR, 'tools')
export const SYSTEM_TOOLS_DIR = path.join(ROOT, 'agents', 'tools')
export const RELOAD_SIGNAL_FILE = path.join(SYSTEM_TOOLS_DIR, '_reload.signal')

export const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials.json')
export const AGENT_CONFIG_FILE = path.join(CONFIG_DIR, 'agent.json')
export const BRIDGE_CONFIG_FILE = path.join(CONFIG_DIR, 'bridge.json')
export const RULES_FILE = path.join(CONFIG_DIR, 'rules.md')
export const PRINCIPALS_FILE = path.join(CONFIG_DIR, 'principals.json')

export const PC_MAIN_ID = 'pc-main'

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/** child 是否等于 parent 或位于 parent 之下（均解析为绝对路径） */
export function isInside(parent, child) {
  const p = path.resolve(parent)
  const c = path.resolve(child)
  return c === p || c.startsWith(p + path.sep)
}

export function principalDir(principalId) {
  return path.join(USERDATA_DIR, principalId)
}

export function sessionsDir(principalId) {
  return path.join(principalDir(principalId), 'sessions')
}

export function workspaceDir(principalId) {
  return path.join(principalDir(principalId), 'workspace')
}

export function memoryFile(principalId) {
  return path.join(principalDir(principalId), 'memory', 'long-term.jsonl')
}

export function personaFile(principalId) {
  return path.join(principalDir(principalId), 'persona.md')
}

export function cronsFile(principalId) {
  return path.join(principalDir(principalId), 'crons.json')
}

export function schedulesFile(principalId) {
  return path.join(principalDir(principalId), 'schedules.json')
}

export function onboardingFile(principalId) {
  return path.join(principalDir(principalId), 'onboarding.json')
}

export function filesDir(principalId) {
  return path.join(principalDir(principalId), 'files')
}

export function inboxDir(principalId) {
  return path.join(filesDir(principalId), 'inbox')
}

export function outboxDir(principalId) {
  return path.join(filesDir(principalId), 'outbox')
}

export function sentDir(principalId) {
  return path.join(outboxDir(principalId), 'sent')
}

export function screenshotsDir(principalId) {
  return path.join(filesDir(principalId), 'screenshots')
}

/** 表情库（抽象图/表情包收藏，永久保留） */
export function stickerDir(principalId) {
  return path.join(principalDir(principalId), 'stickers')
}

export function stickerIndexFile(principalId) {
  return path.join(stickerDir(principalId), 'index.json')
}

/** 家庭共享表情库（所有用户可读；只有主人/主会话或被授权者能写入） */
export function sharedStickerDir() {
  return path.join(USERDATA_DIR, 'shared-stickers')
}

export function sharedStickerIndexFile() {
  return path.join(sharedStickerDir(), 'index.json')
}
