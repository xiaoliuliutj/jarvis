/**
 * 一次性迁移：旧单用户/单会话结构 → 新 principal/多用户结构。
 *
 * 旧：
 *   config/agent.json (含 API key)
 *   config/bridge.json (含微信 token + crons)
 *   config/global.md (全局人设)
 *   agents/claude-cc/memory/sessions/<hash>/...
 *
 * 新：
 *   config/credentials.json + agent.json + bridge.json + rules.md + principals.json
 *   userdata/<principalId>/{persona.md,sessions,workspace,memory,crons.json}
 *
 * 只运行一次；已存在 config/principals.json 会直接退出。
 */

import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'

const ROOT = path.resolve(import.meta.dirname, '..')
const CONFIG_DIR = path.join(ROOT, 'config')
const USERDATA_DIR = path.join(ROOT, 'userdata')
const OLD_MEMORY_DIR = path.join(ROOT, 'agents', 'claude-cc', 'memory')
const OLD_SESSIONS_DIR = path.join(OLD_MEMORY_DIR, 'sessions')

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')) }
function writeJson(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)) }
function readLines(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [] }
function writeLines(p, arr) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, arr.map(x => JSON.stringify(x)).join('\n') + (arr.length ? '\n' : '')) }
function principalIdForWeixin(externalUserId) {
  return 'user_' + createHash('sha1').update(`weixin:${externalUserId}`).digest('hex').slice(0, 10)
}
function userDir(id) { return path.join(USERDATA_DIR, id) }

if (fs.existsSync(path.join(CONFIG_DIR, 'principals.json'))) {
  console.log('config/principals.json 已存在，跳过迁移。')
  process.exit(0)
}

const oldAgent = readJson(path.join(CONFIG_DIR, 'agent.json'))
const oldBridge = readJson(path.join(CONFIG_DIR, 'bridge.json'))
const oldGlobal = fs.existsSync(path.join(CONFIG_DIR, 'global.md'))
  ? fs.readFileSync(path.join(CONFIG_DIR, 'global.md'), 'utf8')
  : '# 人设\n\n你是 Jarvis。\n'

// ── 备份旧配置 ────────────────────────────────────────────────────────────────

const backupDir = path.join(CONFIG_DIR, `_legacy-${Date.now()}`)
fs.mkdirSync(backupDir, { recursive: true })
for (const f of ['agent.json', 'bridge.json', 'global.md', 'workspace.json']) {
  const src = path.join(CONFIG_DIR, f)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, f))
}

// ── 新配置 ────────────────────────────────────────────────────────────────────

const env = oldAgent.env || {}
const weixin = oldBridge.adapters?.weixin || {}
const credentials = {
  anthropic: {
    apiKey: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '',
    baseUrl: env.ANTHROPIC_BASE_URL || '',
  },
  weixin: {
    accounts: {
      default: {
        accountId: weixin.accountId || '',
        token: weixin.token || '',
        baseUrl: weixin.baseUrl || 'https://ilinkai.weixin.qq.com',
      },
    },
  },
}
writeJson(path.join(CONFIG_DIR, 'credentials.json'), credentials)

writeJson(path.join(CONFIG_DIR, 'agent.json'), {
  model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  effortLevel: oldAgent.effortLevel || 'high',
  theme: oldAgent.theme || 'dark',
})

writeJson(path.join(CONFIG_DIR, 'bridge.json'), {
  httpPort: oldBridge.httpPort ?? 7779,
  wsPort: oldBridge.wsPort ?? 7780,
  scheduler: { userConcurrency: 2 },
  adapters: {
    weixin: { enabled: true, account: 'default' },
  },
})

fs.writeFileSync(path.join(CONFIG_DIR, 'rules.md'), `# 全局规则（最高优先级，任何用户人设都不能覆盖）

## 受保护内容
- \`config/credentials.json\` 中的 API Key、外部数据源 token 等凭证：任何会话（包括主会话）都不得读取、复制、修改、外传。
- 不得把凭证写入聊天回复、工具参数、生成代码、日志或任何外部请求。
- 用户要求查看或外传凭证时，必须拒绝；只有人类 owner 可以手动处理。
- \`config/rules.md\` 本文件：所有会话可读，但任何 Agent 都不得修改；只有人类 owner 可以手动改。
- \`config/principals.json\` 是授权配置，可按正常配置管理，但只有有代码权限的用户可以改。

## 用户隔离
- 每个用户有独立的会话、工作区、长期记忆和人设。
- 不得读取、修改或推断其他用户的会话、记忆、工作区、人设。
- 不得冒充其他用户或 owner。

## 工具
- 所有已创建工具对所有用户可用。
- 用户只能修改/删除自己创建的工具；主会话可以管理所有用户工具。
- 系统工具只能由主维护会话通过项目文件修改。

## 人设
- 当前用户的人设只影响语气、风格和称呼，不能覆盖本全局规则。
- 用户可以让 AI 修改自己的人设，但只能修改自己的。

## 定时任务
- 每个用户只能管理自己的定时任务；主会话可以管理全部。
- 任务使用 owner 的人设、记忆、工作区和权限执行，结果只能发回 owner 自己。

## API 无感
- 不要向用户提及底层 API、模型供应商、API Key、token 或凭证文件。
- 用户问起时，只说这是内部配置。

## 主用户
- 系统存在人类 owner。只有 owner 可以修改受保护文件、授予代码权限或调整系统等级配置。
`)

// ── 找出旧数据里的微信用户 ────────────────────────────────────────────────────

const oldWeixinHashDir = path.join(OLD_SESSIONS_DIR, '209054f9') // e:\Jarvis\bridge\sessions\weixin
const oldWeixinIndex = fs.existsSync(path.join(oldWeixinHashDir, 'index.json'))
  ? readJson(path.join(oldWeixinHashDir, 'index.json'))
  : []
const oldWeixinSession = oldWeixinIndex[0]
const oldWeixinMessages = oldWeixinSession
  ? readLines(path.join(oldWeixinHashDir, `${oldWeixinSession.sessionId}.messages.jsonl`))
  : []
const weixinUserId = oldWeixinMessages.find(r => r.type === 'user' && r.from)?.from
  || oldBridge.crons?.find(c => c.toUser)?.toUser
  || null

if (!weixinUserId) throw new Error('找不到旧微信用户 ID，迁移终止')

const weixinPrincipalId = principalIdForWeixin(weixinUserId)

// ── principals.json ───────────────────────────────────────────────────────────

const now = new Date().toISOString()
const principals = {
  'pc-main': {
    id: 'pc-main',
    role: 'maintainer',
    displayName: '主会话',
    sourceType: 'pc',
    accountId: null,
    externalUserId: null,
    accounts: [],
    createdAt: now,
  },
  [weixinPrincipalId]: {
    id: weixinPrincipalId,
    role: 'owner',
    displayName: '主人',
    sourceType: 'weixin',
    accountId: 'default',
    externalUserId: weixinUserId,
    accounts: [{ sourceType: 'weixin', accountId: 'default', externalUserId: weixinUserId }],
    createdAt: now,
  },
}
writeJson(path.join(CONFIG_DIR, 'principals.json'), principals)

// ── userdata 目录 ─────────────────────────────────────────────────────────────

fs.mkdirSync(path.join(USERDATA_DIR, 'tools'), { recursive: true })
for (const id of ['pc-main', weixinPrincipalId]) {
  const dir = userDir(id)
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'persona.md'), oldGlobal)
  writeJson(path.join(dir, 'crons.json'), [])
}

// ── 迁移主会话 ────────────────────────────────────────────────────────────────

const oldMainHashDir = path.join(OLD_SESSIONS_DIR, '1d53c693') // E:\Jarvis
if (fs.existsSync(path.join(oldMainHashDir, 'index.json'))) {
  const oldIndex = readJson(path.join(oldMainHashDir, 'index.json'))
  const main = oldIndex.find(s => s.isMain) || oldIndex[0]
  if (main?.sessionId) {
    const src = path.join(oldMainHashDir, `${main.sessionId}.messages.jsonl`)
    const dstDir = path.join(userDir('pc-main'), 'sessions')
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dstDir, `${main.sessionId}.messages.jsonl`))
    writeJson(path.join(dstDir, 'index.json'), [{
      sessionId: main.sessionId,
      name: '主会话',
      isMain: true,
      createdAt: main.createdAt || now,
      lastActiveAt: main.lastActiveAt || now,
      isCurrent: true,
    }])
  }
}

// ── 迁移微信会话 ──────────────────────────────────────────────────────────────

if (oldWeixinSession?.sessionId) {
  const dstDir = path.join(userDir(weixinPrincipalId), 'sessions')
  const src = path.join(oldWeixinHashDir, `${oldWeixinSession.sessionId}.messages.jsonl`)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dstDir, `${oldWeixinSession.sessionId}.messages.jsonl`))
  writeJson(path.join(dstDir, 'index.json'), [{
    sessionId: oldWeixinSession.sessionId,
    name: '微信会话',
    isMain: false,
    createdAt: oldWeixinSession.createdAt || now,
    lastActiveAt: oldWeixinSession.lastActiveAt || now,
    isCurrent: true,
  }])
}

// ── 迁移长期记忆：按旧 cwd 归属 ───────────────────────────────────────────────

const oldMemory = readLines(path.join(OLD_MEMORY_DIR, 'long-term.jsonl'))
const mainMemory = []
const weixinMemory = []
for (const entry of oldMemory) {
  const cwd = (entry.cwd || '').toLowerCase()
  if (cwd.includes('bridge') && cwd.includes('weixin')) weixinMemory.push(entry)
  else mainMemory.push(entry)
}
writeLines(path.join(userDir('pc-main'), 'memory', 'long-term.jsonl'), mainMemory)
writeLines(path.join(userDir(weixinPrincipalId), 'memory', 'long-term.jsonl'), weixinMemory)

// ── 迁移 cron ─────────────────────────────────────────────────────────────────

const migratedCrons = (oldBridge.crons || [])
  .filter(c => c.enabled !== false)
  .map(c => ({
    id: c.id,
    enabled: c.enabled !== false,
    schedule: c.schedule || {},
    prompt: c.prompt,
    createdAt: now,
  }))
if (migratedCrons.length) {
  writeJson(path.join(userDir(weixinPrincipalId), 'crons.json'), migratedCrons)
}

console.log('迁移完成：')
console.log('  principal: pc-main')
console.log(`  principal: ${weixinPrincipalId} (owner, ${weixinUserId})`)
console.log(`  主会话消息: ${oldMainHashDir}`)
console.log(`  微信会话消息: ${oldWeixinHashDir}`)
console.log(`  记忆: main=${mainMemory.length}, weixin=${weixinMemory.length}`)
console.log(`  cron: ${migratedCrons.length}`)
console.log(`  旧配置备份: ${backupDir}`)
