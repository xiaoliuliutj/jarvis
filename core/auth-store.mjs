/**
 * App 简单账号体系：用户名 + 密码，用户名唯一。
 *
 * 存储：userdata/_auth/users.json（0600，Agent 文件工具不可访问）
 * - 密码只存 scrypt hash + salt
 * - 每个用户自动分配一个 tokenId（App 访问令牌）
 * - 用户名去重不区分大小写
 *
 * tokenId 是凭证：只在注册/登录响应里返回，不打印、不写日志。
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { USERDATA_DIR, PRINCIPALS_FILE, ensureDir } from './paths.mjs'
import { resolvePrincipal } from './principals.mjs'

const AUTH_DIR = path.join(USERDATA_DIR, '_auth')
const USERS_FILE = path.join(AUTH_DIR, 'users.json')
const USERNAME_RE = /^[A-Za-z0-9_一-龥.-]{2,24}$/

function readUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return { version: 1, users: {} }
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'))
    return { version: 1, users: (data.users && typeof data.users === 'object') ? data.users : {} }
  } catch {
    return { version: 1, users: {} }
  }
}

function writeUsers(data) {
  ensureDir(AUTH_DIR)
  const tmp = `${USERS_FILE}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmp, USERS_FILE)
}

function normalizeUsername(username) {
  const value = String(username || '').trim()
  if (!USERNAME_RE.test(value)) {
    throw new Error('用户名需 2-24 位，只能包含中英文、数字、下划线、点或短横线')
  }
  return value
}

function normalizePassword(password) {
  const value = String(password || '')
  if (value.length < 6 || value.length > 128) {
    throw new Error('密码长度需 6-128 位')
  }
  return value
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex')
}

function sameSecret(left, right) {
  const a = crypto.createHash('sha256').update(String(left || '')).digest()
  const b = crypto.createHash('sha256').update(String(right || '')).digest()
  return crypto.timingSafeEqual(a, b)
}

function publicUser(user) {
  return {
    username: user.username,
    principalId: user.principalId,
    role: user.role || 'user',
    createdAt: user.createdAt || null,
  }
}

function setPrincipalDisplayName(principalId, displayName) {
  try {
    const registry = JSON.parse(fs.readFileSync(PRINCIPALS_FILE, 'utf-8'))
    if (registry[principalId]) {
      registry[principalId].displayName = displayName
      fs.writeFileSync(PRINCIPALS_FILE, JSON.stringify(registry, null, 2), 'utf-8')
    }
  } catch {}
}

export function register(username, password) {
  const displayName = normalizeUsername(username)
  const safePassword = normalizePassword(password)
  const key = displayName.toLowerCase()
  const data = readUsers()
  if (data.users[key]) throw new Error('用户名已存在')
  if (Object.values(data.users).some(user => user.username === displayName)) {
    throw new Error('用户名已存在')
  }

  const salt = crypto.randomBytes(16).toString('hex')
  const tokenId = crypto.randomBytes(24).toString('hex')
  const principal = resolvePrincipal({
    sourceType: 'app',
    accountId: 'default',
    externalUserId: `login:${key}`,
  })
  setPrincipalDisplayName(principal.id, displayName)

  const user = {
    username: displayName,
    key,
    salt,
    hash: hashPassword(safePassword, salt),
    tokenId,
    principalId: principal.id,
    role: 'user',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  data.users[key] = user
  writeUsers(data)
  return { ...publicUser(user), tokenId }
}

export function login(username, password) {
  const name = String(username || '').trim()
  const key = name.toLowerCase()
  const data = readUsers()
  const user = data.users[key]
  if (!user) throw new Error('用户名或密码不正确')
  const hash = hashPassword(String(password || ''), user.salt)
  const expected = Buffer.from(user.hash, 'hex')
  const provided = Buffer.from(hash, 'hex')
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new Error('用户名或密码不正确')
  }
  return { ...publicUser(user), tokenId: user.tokenId }
}

export function findByToken(token) {
  const provided = String(token || '')
  if (!provided) return null
  const data = readUsers()
  for (const user of Object.values(data.users)) {
    if (sameSecret(provided, user.tokenId)) {
      return publicUser(user)
    }
  }
  return null
}

export function getUser(username) {
  const key = String(username || '').trim().toLowerCase()
  const user = readUsers().users[key]
  return user ? publicUser(user) : null
}

export function authDir() {
  return AUTH_DIR
}
