/**
 * Adapter 自动发现。
 *
 * bridge/adapters/<source>.mjs 需要导出：
 *   id: string
 *   start(onMessage, opts): Promise<void>
 *   send(externalUserId, text, opts): Promise<void>
 *   stop?(): void
 *
 * 新增数据源只需要在这个目录新增文件，不再修改 server.mjs。
 */

import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { ROOT } from './paths.mjs'

const ADAPTERS_DIR = path.join(ROOT, 'bridge', 'adapters')

export async function loadAdapters() {
  const adapters = {}
  for (const file of fs.readdirSync(ADAPTERS_DIR)) {
    if (!file.endsWith('.mjs') || file.startsWith('_')) continue
    const mod = await import(pathToFileURL(path.join(ADAPTERS_DIR, file)).href)
    if (!mod.id || typeof mod.start !== 'function' || typeof mod.send !== 'function') {
      throw new Error(`adapter ${file} 缺少 id/start/send 导出`)
    }
    adapters[mod.id] = mod
  }
  return adapters
}
