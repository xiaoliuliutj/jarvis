/**
 * 配置读取。
 *
 * config/agent.json 直接兼容 Claude Code 的 settings.json 格式：
 *   {
 *     "env": {
 *       "ANTHROPIC_BASE_URL": "...",
 *       "ANTHROPIC_AUTH_TOKEN": "...",
 *       "ANTHROPIC_MODEL": "...",
 *       "CLAUDE_CODE_EFFORT_LEVEL": "max"
 *     },
 *     "effortLevel": "high",
 *     "model": "opus"
 *   }
 *
 * 也兼容旧的 { model, apiKey, baseUrl } 写法。
 * config/credentials.json 仍作为 fallback，并保存微信 token。
 *
 * 含 token 的 agent.json / credentials.json 只允许主进程和 Bridge 读取；
 * Agent 的 Read/Write/Edit 等文件工具会被 core/permissions.mjs 拒绝。
 */

import fs from 'fs'
import {
  AGENT_CONFIG_FILE,
  BRIDGE_CONFIG_FILE,
  CREDENTIALS_FILE,
  RULES_FILE,
} from './paths.mjs'

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

export function loadAgentSettings() {
  return readJson(AGENT_CONFIG_FILE)
}

export function loadBridgeConfig() {
  return readJson(BRIDGE_CONFIG_FILE)
}

export function loadCredentials() {
  return readJson(CREDENTIALS_FILE)
}

// 模型别名 → Claude Code 使用的默认模型环境变量
const MODEL_ALIAS_ENV = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
}

// 顶层直接写 ANTHROPIC_* / CLAUDE_CODE_* 的键也当作环境变量
const ENV_KEY_RE = /^(?:ANTHROPIC|CLAUDE_CODE)_[A-Z0-9_]+$/

function setEnv(env, key, value) {
  if (value === undefined || value === null || value === '') return
  env[key] = String(value)
}

/**
 * 把 Claude Code settings 格式转成子进程环境变量。
 * settings.env 优先于顶层同名键；顶层 effortLevel / autoCompactWindow 作为补充。
 */
export function buildAgentEnv(settings = {}) {
  const env = {}

  for (const [key, value] of Object.entries(settings)) {
    if (ENV_KEY_RE.test(key)) setEnv(env, key, value)
  }
  for (const [key, value] of Object.entries(settings.env || {})) {
    setEnv(env, key, value)
  }

  if (!env.CLAUDE_CODE_EFFORT_LEVEL) setEnv(env, 'CLAUDE_CODE_EFFORT_LEVEL', settings.effortLevel)
  if (!env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) {
    setEnv(env, 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', settings.autoCompactWindow)
  }

  return env
}

/**
 * 取实际模型名。
 * ANTHROPIC_MODEL 优先；否则解析 opus/sonnet/haiku 别名到对应的 DEFAULT_* 变量。
 */
export function resolveModel(settings = {}) {
  const env = buildAgentEnv(settings)
  if (env.ANTHROPIC_MODEL) return env.ANTHROPIC_MODEL

  const requested = settings.model || env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-5-5'
  const aliasEnv = MODEL_ALIAS_ENV[String(requested).toLowerCase()]
  return aliasEnv && env[aliasEnv] ? env[aliasEnv] : requested
}

/**
 * 凭证解析顺序：settings.env > 旧 agent 字段 > credentials.json
 * authMode 决定注入哪个环境变量：AUTH_TOKEN 走 Bearer，API_KEY 走 x-api-key；
 * 旧配置没有 env 时两者都注入，保持原有代理兼容性。
 */
export function resolveAnthropicCredentials(settings = {}, credentials = {}) {
  const env = buildAgentEnv(settings)
  const authMode = env.ANTHROPIC_AUTH_TOKEN
    ? 'auth_token'
    : env.ANTHROPIC_API_KEY
      ? 'api_key'
      : 'both'

  return {
    apiKey: env.ANTHROPIC_AUTH_TOKEN
      || env.ANTHROPIC_API_KEY
      || settings.apiKey
      || credentials?.anthropic?.apiKey
      || '',
    baseUrl: env.ANTHROPIC_BASE_URL
      || settings.baseUrl
      || credentials?.anthropic?.baseUrl
      || '',
    authMode,
  }
}

/** 模型调用凭证。API Key 不进入 prompt/UI，只注入 Agent 子进程环境。 */
export function getAnthropicCredentials() {
  return resolveAnthropicCredentials(loadAgentSettings(), loadCredentials())
}

/** 微信账号凭证；当前一个 adapter 一个默认账号，多账号时用 accountId 区分。 */
export function getWeixinAccount(accountId = 'default') {
  const creds = loadCredentials()
  return creds.weixin?.accounts?.[accountId] || null
}

export function getModel() {
  return resolveModel(loadAgentSettings())
}

/** 传给 Agent SDK 的额外环境变量（模型别名、effort、compact window 等）。 */
export function getAgentEnv() {
  return buildAgentEnv(loadAgentSettings())
}

export function readRules() {
  return fs.readFileSync(RULES_FILE, 'utf-8')
}
