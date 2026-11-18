import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import http from 'http'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(import.meta.dirname, '../../..')
const BRIDGE_HTTP = 'http://localhost:7779'

function bridgePost(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(BRIDGE_HTTP + pathname, { method: 'POST' }, res => {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', () => resolve(JSON.parse(d || '{}')))
    })
    req.on('error', reject)
    req.end()
  })
}

function bridgeGet(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(BRIDGE_HTTP + pathname, { method: 'GET', timeout: 1000 }, res => {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', () => {
        try { resolve(JSON.parse(d || '{}')) } catch (err) { reject(err) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}

/** Bridge 重启后等它重新监听；避免“指令成功但新进程没起来”。 */
async function waitForBridgeHealth(timeoutMs = 8000) {
  const startedAt = Date.now()
  await new Promise(r => setTimeout(r, 1200)) // 旧进程 500ms 后退出，给新进程留启动时间
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const health = await bridgeGet('/health')
      if (health?.ok) return true
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

/** 重启前静态检查；失败时不重启，把错误交给模型修。 */
async function runPreflight(noBuild = false) {
  const args = [path.join(ROOT, 'scripts', 'restart-preflight.mjs')]
  if (noBuild) args.push('--no-build')
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: ROOT,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { ok: true, text: (stdout + stderr).trim() }
  } catch (err) {
    const text = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n').trim()
    return { ok: false, text: text.slice(0, 3000) }
  }
}

async function checkedRestart({ skipChecks, noBuild, request, successText, verify }) {
  if (!skipChecks) {
    const check = await runPreflight(noBuild)
    if (!check.ok) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `❌ 重启前检查失败，未重启。修好后重试：\n\n${check.text}`,
        }],
      }
    }
  }

  try {
    const result = await request()
    if (verify && !(await verify())) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `⚠️ 重启指令已发送，但服务未在预期时间内恢复。请查看 bridge/bridge.err.log。\n${JSON.stringify(result)}`,
        }],
      }
    }
    return { content: [{ type: 'text', text: `${successText}\n${JSON.stringify(result)}` }] }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `❌ 失败：${err.message}（Bridge Server 是否在运行？）` }] }
  }
}

const server = new McpServer({ name: 'restart', version: '1.1.0' })

server.tool(
  'restart__renderer',
  '刷新 Electron React 渲染层。适用于只修改了 src/ 下的前端文件，不影响会话、Bridge 和主进程。',
  {},
  async () => {
    try {
      await bridgePost('/reload-renderer')
      return { content: [{ type: 'text', text: '✅ 渲染层刷新指令已发送。' }] }
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `❌ 失败：${err.message}（Bridge Server 是否在运行？）` }] }
    }
  }
)

server.tool(
  'restart__bridge',
  '重启 Bridge Server（bridge/ 或 core/）。会短暂中断外部用户会话；主会话和 Electron 不受影响。默认先做静态检查。',
  {
    skipChecks: z.boolean().optional().describe('跳过语法/构建检查，仅用于检查本身不可用时的应急重启'),
  },
  async ({ skipChecks = false } = {}) => {
    return checkedRestart({
      skipChecks,
      noBuild: true,
      request: () => bridgePost('/restart-bridge'),
      successText: '✅ Bridge Server 已重启并通过健康检查。',
      verify: waitForBridgeHealth,
    })
  }
)

server.tool(
  'restart__electron',
  '重启 Electron。重启会等待当前主会话回合结束、消息落盘后执行；Vite 由 supervisor 保持运行。默认先做静态检查。force 会立即中断当前回合，只用于回合卡死。自行 detach 的常驻后台进程不会被等待。',
  {
    skipChecks: z.boolean().optional().describe('跳过语法/构建检查，仅用于检查本身不可用时的应急重启'),
    force: z.boolean().optional().describe('立即重启，不等待当前回合结束'),
  },
  async ({ skipChecks = false, force = false } = {}) => {
    return checkedRestart({
      skipChecks,
      noBuild: false,
      request: () => bridgePost(`/relaunch-electron${force ? '?force=1' : ''}`),
      successText: force
        ? '✅ 已请求立即重启 Electron（当前回合可能被中断）。'
        : '✅ 已请求重启 Electron，将在当前主会话回合结束后执行。',
    })
  }
)

server.tool(
  'restart__all',
  '同时重启 Bridge 和 Electron。适用于修改了 core/ 且两端都引用的情况。默认先做静态检查；Electron 仍会等待当前主回合结束。force 会立即中断当前回合。',
  {
    skipChecks: z.boolean().optional().describe('跳过语法/构建检查，仅用于检查本身不可用时的应急重启'),
    force: z.boolean().optional().describe('立即重启 Electron，不等待当前回合结束'),
  },
  async ({ skipChecks = false, force = false } = {}) => {
    return checkedRestart({
      skipChecks,
      noBuild: false,
      request: () => bridgePost(`/restart-all${force ? '?force=1' : ''}`),
      successText: force
        ? '✅ Bridge 即将重启；Electron 立即重启，当前回合可能被中断。'
        : '✅ Bridge 即将重启，Electron 将在当前主会话回合结束后重启。',
    })
  }
)

await server.connect(new StdioServerTransport())
