/**
 * 工具实现 provider 注册表。
 *
 * 统一工具定义只描述“是什么”，这里按 impl.type 选择“怎么执行”：
 *   local-mcp      -> 本地 stdio MCP server（Jarvis 工具）
 *   android-native -> Bridge + App 原生通道
 *   mcp / http     -> 接口占位
 */

import * as localMcp from './local-mcp.mjs'
import * as androidNative from './android-native.mjs'
import * as mcp from './mcp.mjs'
import * as http from './http.mjs'

const PROVIDERS = new Map([
  ['local-mcp', localMcp],
  ['android-native', androidNative],
  ['mcp', mcp],
  ['http', http],
])

export function getProvider(type) {
  return PROVIDERS.get(type) || null
}

export function listProviderTypes() {
  return [...PROVIDERS.keys()]
}

/**
 * @param {Array} definitions 已按用户启停/权限过滤后的统一工具定义
 * @param {object} ctx { env, androidEnv, principal }
 * @returns {Record<string, object>} mcpServers 配置
 */
export function buildProviderMcpServers(definitions = [], ctx = {}) {
  const groups = new Map()
  for (const definition of definitions) {
    const type = definition?.impl?.type || definition?.provider
    if (!PROVIDERS.has(type)) continue
    if (!groups.has(type)) groups.set(type, [])
    groups.get(type).push(definition)
  }

  const servers = {}
  for (const [type, subset] of groups) {
    const provider = PROVIDERS.get(type)
    const built = provider.build(subset, ctx) || {}
    for (const [name, config] of Object.entries(built)) {
      if (servers[name]) throw new Error(`MCP server 名称冲突：${name}`)
      servers[name] = config
    }
  }
  return servers
}
