/**
 * Principal 注册表。
 *
 * principal 是 Jarvis 里的“用户身份”，与数据源解耦：
 *   - pc-main：唯一主维护会话
 *   - 外部用户：sourceType + accountId + externalUserId → principalId
 *
 * sourceType/accountId/externalUserId 只用于路由；模型 prompt 只使用 displayName。
 */

import fs from 'fs'
import { createHash } from 'crypto'
import { PRINCIPALS_FILE, PC_MAIN_ID } from './paths.mjs'

function readRegistry() {
  return JSON.parse(fs.readFileSync(PRINCIPALS_FILE, 'utf-8'))
}

function writeRegistry(registry) {
  fs.writeFileSync(PRINCIPALS_FILE, JSON.stringify(registry, null, 2), 'utf-8')
}

function capabilitiesForRole(role) {
  return {
    editJarvisCode: role === 'maintainer' || role === 'owner',
    // 全局模型/全局 API 属于特权能力；普通用户默认必须配置自己的 Key。
    // 需要让某个普通用户使用全局模型时，可在 principals.json 显式加
    // "capabilities": { "useGlobalModel": true }。
    useGlobalModel: role === 'maintainer' || role === 'owner',
  }
}

function normalize(entry) {
  return {
    ...entry,
    capabilities: { ...capabilitiesForRole(entry.role), ...(entry.capabilities || {}) },
  }
}

export function listPrincipals() {
  return Object.values(readRegistry()).map(normalize)
}

export function getPrincipal(principalId) {
  const entry = readRegistry()[principalId]
  if (!entry) throw new Error(`未知 principal: ${principalId}`)
  return normalize(entry)
}

export function isPrivileged(principal) {
  return principal.role === 'maintainer' || principal.role === 'owner'
}

/** externalUserId 可能包含 @ / . / -，统一生成文件系统安全的 principalId */
function makePrincipalId(sourceType, externalUserId) {
  // principalId 会出现在用户工作区路径中，不能带 source 名称，
  // 否则模型会从路径猜出用户来自微信/QQ。
  const hash = createHash('sha1').update(`${sourceType}:${externalUserId}`).digest('hex').slice(0, 10)
  return `user_${hash}`
}

/**
 * 根据入站消息解析 principal。
 * 未登记的家人账号会自动创建为普通 user；需要代码权限时手动改 principals.json。
 * 返回值额外带 isNew（不写入 principals.json），供新用户风格引导使用。
 */
export function resolvePrincipal({ sourceType, accountId = 'default', externalUserId }) {
  const registry = readRegistry()
  const matchesAccount = (account) => account
    && account.sourceType === sourceType
    && (account.accountId || 'default') === accountId
    && account.externalUserId === externalUserId

  // 1) 优先匹配 principal 的顶层字段（历史配置）
  // 2) 再匹配 accounts 数组（同一用户多渠道：微信 / App / 未来其他端）
  const existing = Object.values(registry).find(
    p => matchesAccount({ sourceType: p.sourceType, accountId: p.accountId, externalUserId: p.externalUserId })
      || (Array.isArray(p.accounts) && p.accounts.some(matchesAccount))
  )
  if (existing) return { ...normalize(existing), isNew: false }

  const id = makePrincipalId(sourceType, externalUserId)
  const entry = {
    id,
    role: 'user',
    // 不能用 externalUserId 作为 displayName：它可能包含 wechat/qq 等来源信息。
    // 人类可以在 principals.json 里改成真实称呼。
    displayName: `用户${id.slice(-4)}`,
    sourceType,
    accountId,
    externalUserId,
    accounts: [{ sourceType, accountId, externalUserId }],
    createdAt: new Date().toISOString(),
  }
  registry[id] = entry
  writeRegistry(registry)
  console.log(`[principals] 自动创建用户 ${id} (${sourceType}:${externalUserId})`)
  return { ...normalize(entry), isNew: true }
}

/** 更新 principal（例如把家人提升为 owner）。 */
export function updatePrincipal(principalId, updates) {
  const registry = readRegistry()
  if (!registry[principalId]) throw new Error(`未知 principal: ${principalId}`)
  registry[principalId] = { ...registry[principalId], ...updates }
  writeRegistry(registry)
  return normalize(registry[principalId])
}

export function getPrimaryAccount(principal) {
  return principal.accounts?.[0] || null
}

export { PC_MAIN_ID }
