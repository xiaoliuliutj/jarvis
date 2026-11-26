/**
 * Owner token：owner 权限的唯一凭证。
 *
 * 文件：userdata/app-adapter/owner-token.txt（0600，不上传、不打印）
 * 用途：
 *   - App / Web：请求头 X-Owner-Token 或 query ownerToken
 *   - 微信兜底（方案 A）：适配器服务端读取并代持，仅对绑定为 owner 的微信账号注入
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { ROOT } from './paths.mjs'

const OWNER_TOKEN_FILE = path.join(ROOT, 'userdata', 'app-adapter', 'owner-token.txt')

export function readOwnerToken() {
  try {
    if (!fs.existsSync(OWNER_TOKEN_FILE)) return ''
    return fs.readFileSync(OWNER_TOKEN_FILE, 'utf-8').trim()
  } catch {
    return ''
  }
}

export function hasOwnerToken() {
  return !!readOwnerToken()
}

export function verifyOwnerToken(provided) {
  const expected = readOwnerToken()
  const value = String(provided || '')
  if (!expected || !value) return false
  const a = crypto.createHash('sha256').update(value).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}
