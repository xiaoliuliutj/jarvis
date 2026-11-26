/**
 * Android 原生 provider。
 *
 * 只负责把已启用的 Android 外接工具挂成一个 android_native MCP server；
 * 具体哪个工具可用由 MCP server 自己按 per-user tools.json 注册。
 * 内部 token 只注入这个 provider server，不注入普通用户工具。
 */

import fs from 'fs'
import path from 'path'
import { SYSTEM_TOOLS_DIR } from '../paths.mjs'

const SERVER_PATH = path.join(SYSTEM_TOOLS_DIR, 'android_native', 'index.mjs')

export function build(definitions = [], ctx = {}) {
  const defs = definitions.filter(def => (
    def.provider === 'android-native'
    && def.kind === 'tool'
    && def.available
  ))
  if (!defs.length) return {}
  if (!fs.existsSync(SERVER_PATH)) return {}

  const bridgeEnv = ctx.androidEnv || {}
  if (!bridgeEnv.JARVIS_BRIDGE_INTERNAL_URL || !bridgeEnv.JARVIS_INTERNAL_TOKEN) {
    // Electron 主进程没有 app adapter，不加载原生工具。
    return {}
  }

  const serverName = defs[0]?.impl?.server || 'android_native'
  return {
    [serverName]: {
      command: 'node',
      args: [SERVER_PATH],
      env: {
        ...(ctx.env || {}),
        ...bridgeEnv,
      },
    },
  }
}
