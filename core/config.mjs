/**
 * 配置读取。
 *
 * 敏感信息只放在 config/credentials.json：
 *   - Agent 的 Read/Write/Edit 等文件工具会被 core/permissions.mjs 拒绝
 *   - 只有主进程 / Bridge 进程读取
 * 非敏感配置放 config/agent.json、config/bridge.json。
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

/** 模型调用凭证。API Key 不进入 prompt/UI，只注入 Agent 子进程环境。 */
export function getAnthropicCredentials() {
  const creds = loadCredentials()
  return {
    apiKey: creds.anthropic?.apiKey || '',
    baseUrl: creds.anthropic?.baseUrl || '',
  }
}

/** 微信账号凭证；当前一个 adapter 一个默认账号，多账号时用 accountId 区分。 */
export function getWeixinAccount(accountId = 'default') {
  const creds = loadCredentials()
  return creds.weixin?.accounts?.[accountId] || null
}

export function getModel() {
  return loadAgentSettings().model || 'claude-sonnet-5-5'
}

export function readRules() {
  return fs.readFileSync(RULES_FILE, 'utf-8')
}
