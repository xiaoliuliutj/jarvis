/**
 * App 账号体系：
 *   - 注册：昵称 + 账号 + 密码
 *   - 账号唯一；昵称、密码不做唯一性限制
 *   - 注册生成 accountId，后端用它匹配账号
 *   - ownerId 单独配置，默认空；不参与 owner 权限判定
 *   - owner 权限只由 owner token 决定
 *
 * 存储：userdata/_auth/users.json（0600，Agent 文件工具不可访问）
 * - 密码只存 scrypt hash + salt
 * - tokenId 是登录凭证，目前不过期
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { USERDATA_DIR, PRINCIPALS_FILE, ensureDir } from './paths.mjs'
import { resolvePrincipal, getPrincipal } from './principals.mjs'

const AUTH_DIR = path.join(USERDATA_DIR, '_auth')
const USERS_FILE = path.join(AUTH_DIR, 'users.json')

function readUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return { version: 1, users: {} }
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'))
    const normalized = { version: 1, users: (data.users && typeof data.users === 'object') ? data.users : {} }
    if (migrateUsers(normalized)) writeUsers(normalized)
    return normalized
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

function normalizeAccount(account) {
  const value = String(account || '').trim()
  if (!value) throw new Error('请填写账号')
  if (value.length > 64) throw new Error('账号最长 64 位')
  if (/[\x00-\x1f]/.test(value)) throw new Error('账号不能包含控制字符')
  return value
}

function normalizeNickname(nickname) {
  const value = String(nickname || '').trim()
  if (!value) throw new Error('请填写昵称')
  if (value.length > 64) throw new Error('昵称最长 64 位')
  if (/[\x00-\x1f]/.test(value)) throw new Error('昵称不能包含控制字符')
  return value
}

function normalizePassword(password) {
  const value = String(password || '')
  if (!value) throw new Error('请填写密码')
  if (value.length > 256) throw new Error('密码最长 256 位')
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

function newAccountId(existingIds = new Set()) {
  for (;;) {
    const id = `u_${crypto.randomBytes(12).toString('hex')}`
    if (!existingIds.has(id)) return id
  }
}

function publicUser(user) {
  return {
    account: user.account || user.username || '',
    username: user.account || user.username || '', // 兼容旧前端
    nickname: user.nickname || user.account || user.username || '',
    accountId: user.accountId || '',
    ownerId: user.ownerId || '',
    principalId: user.principalId || '',
    role: 'user', // 账号角色固定 user；owner 由 owner token 决定
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

/** 老用户数据补齐 account/nickname/accountId/ownerId，不改变已有 principalId。 */
function migrateUsers(data) {
  let changed = false
  const ids = new Set(
    Object.values(data.users)
      .map(user => user.accountId)
      .filter(Boolean),
  )
  for (const [key, user] of Object.entries(data.users)) {
    const account = user.account || user.username || key
    if (user.account !== account) { user.account = account; changed = true }
    if (user.username !== account) { user.username = account; changed = true }
    if (!user.nickname) {
      let nickname = account
      try { nickname = getPrincipal(user.principalId)?.displayName || account } catch {}
      user.nickname = nickname
      changed = true
    }
    if (!user.accountId) {
      const id = newAccountId(ids)
      ids.add(id)
      user.accountId = id
      changed = true
    }
    if (user.ownerId === undefined) { user.ownerId = ''; changed = true }
    if (!user.tokenId) { user.tokenId = crypto.randomBytes(24).toString('hex'); changed = true }
  }
  return changed
}

/**
 * ownerId 是单独配置的数据归属字段，默认空：
 *   - 空：账号使用自己的 principal
 *   - 非空：指向某个 owner principal id 或 owner 账号的 accountId，
 *           账号挂到该 owner 的 principal（共用会话/历史）
 * 注意：ownerId 不参与 owner 权限判定，owner 权限只由 owner token 决定。
 */
function resolveOwnerPrincipal(ownerId, users) {
  const value = String(ownerId || '').trim()
  if (!value) return null
  const direct = getPrincipal(value)
  if (direct) return direct
  const owner = Object.values(users).find(user => user.accountId === value)
  if (owner?.principalId) return getPrincipal(owner.principalId)
  return null
}

function principalForAccount(accountId, ownerId, users) {
  const ownerPrincipal = resolveOwnerPrincipal(ownerId, users)
  if (ownerPrincipal) return ownerPrincipal
  return resolvePrincipal({
    sourceType: 'app',
    accountId: 'default',
    externalUserId: `account:${accountId}`,
  })
}

export function register(input, passwordArg) {
  const isObject = input && typeof input === 'object'
  const nickname = normalizeNickname(isObject ? input.nickname : input)
  const account = normalizeAccount(isObject ? input.account : input)
  const password = normalizePassword(isObject ? input.password : passwordArg)
  const key = account.toLowerCase()
  const data = readUsers()
  if (data.users[key]) throw new Error('账号已存在')
  if (Object.values(data.users).some(user => String(user.account || '').toLowerCase() === key)) {
    throw new Error('账号已存在')
  }

  const ids = new Set(Object.values(data.users).map(user => user.accountId).filter(Boolean))
  const accountId = newAccountId(ids)
  const principal = principalForAccount(accountId, '', data.users)
  setPrincipalDisplayName(principal.id, nickname)

  const salt = crypto.randomBytes(16).toString('hex')
  const user = {
    account,
    username: account, // 兼容旧字段
    key,
    nickname,
    salt,
    hash: hashPassword(password, salt),
    accountId,
    ownerId: '',
    principalId: principal.id,
    tokenId: crypto.randomBytes(24).toString('hex'),
    role: 'user',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  data.users[key] = user
  writeUsers(data)
  return { ...publicUser(user), tokenId: user.tokenId }
}

export function login(account, password) {
  const name = String(account || '').trim()
  const key = name.toLowerCase()
  const data = readUsers()
  const user = data.users[key]
  if (!user) throw new Error('账号或密码不正确')
  const hash = hashPassword(String(password || ''), user.salt)
  const expected = Buffer.from(user.hash, 'hex')
  const provided = Buffer.from(hash, 'hex')
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new Error('账号或密码不正确')
  }
  return { ...publicUser(user), tokenId: user.tokenId }
}

/** 重置密码（供 owner token 恢复入口使用）。 */
export function setPassword(accountOrAccountId, password) {
  const value = String(accountOrAccountId || '').trim()
  const key = value.toLowerCase()
  const safePassword = normalizePassword(password)
  const data = readUsers()
  const user = data.users[key]
    || Object.values(data.users).find(item => item.accountId === value)
  if (!user) throw new Error('账号不存在')
  const salt = crypto.randomBytes(16).toString('hex')
  user.salt = salt
  user.hash = hashPassword(safePassword, salt)
  user.updatedAt = new Date().toISOString()
  writeUsers(data)
  return publicUser(user)
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

export function getUser(account) {
  const key = String(account || '').trim().toLowerCase()
  const user = readUsers().users[key]
  return user ? publicUser(user) : null
}

export function getUserByAccountId(accountId) {
  const id = String(accountId || '').trim()
  if (!id) return null
  const user = Object.values(readUsers().users).find(item => item.accountId === id)
  return user ? publicUser(user) : null
}

/** 只返回公开字段，不含密码 hash / tokenId。 */
export function listUsersPublic() {
  return Object.values(readUsers().users)
    .map(publicUser)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
}

/**
 * 单独配置 ownerId（默认空）。
 * ownerId 可以是 owner principal id，也可以是 owner 账号的 accountId。
 * 设置后该账号的 principal 会切到 owner 的 principal（共用会话）。
 */
export function setOwnerId(accountOrAccountId, ownerId = '') {
  const value = String(accountOrAccountId || '').trim()
  if (!value) throw new Error('账号不能为空')
  const data = readUsers()
  const key = value.toLowerCase()
  const user = data.users[key]
    || Object.values(data.users).find(item => item.accountId === value)
  if (!user) throw new Error('账号不存在')
  const nextOwnerId = String(ownerId || '').trim()
  const principal = nextOwnerId
    ? resolveOwnerPrincipal(nextOwnerId, data.users)
    : resolvePrincipal({
        sourceType: 'app',
        accountId: 'default',
        externalUserId: `account:${user.accountId}`,
      })
  if (!principal) throw new Error('ownerId 对应的 owner 不存在')
  user.ownerId = nextOwnerId
  user.principalId = principal.id
  user.updatedAt = new Date().toISOString()
  writeUsers(data)
  return publicUser(user)
}

/**
 * 把登录账号挂到已有 principal（用于历史迁移）。
 */
export function linkUserPrincipal(account, principalId) {
  const key = String(account || '').trim().toLowerCase()
  const target = String(principalId || '').trim()
  if (!key || !target) throw new Error('账号和 principalId 不能为空')
  if (!getPrincipal(target)) throw new Error(`未知 principal: ${target}`)
  const data = readUsers()
  const user = data.users[key]
  if (!user) throw new Error('账号不存在')
  user.principalId = target
  user.updatedAt = new Date().toISOString()
  writeUsers(data)
  return publicUser(user)
}

export function authDir() {
  return AUTH_DIR
}
