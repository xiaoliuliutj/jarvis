/**
 * local-mcp provider：现有 agents/tools + userdata/tools 的 stdio MCP server。
 */

import fs from 'fs'

export function build(definitions = [], ctx = {}) {
  const servers = {}
  for (const def of definitions) {
    if (def.provider !== 'local-mcp' || def.kind !== 'tool' || !def.available) continue
    const indexFile = def.impl?.path
    if (!indexFile || !fs.existsSync(indexFile)) continue
    const serverName = def.impl?.server || def.id
    if (servers[serverName]) {
      throw new Error(`工具名冲突：${serverName}`)
    }
    servers[serverName] = {
      command: 'node',
      args: [indexFile],
      env: ctx.env || {},
    }
  }
  return servers
}
