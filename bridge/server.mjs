/**
 * Bridge Server
 *
 * 职责：
 *   - 接收外部 adapter 的消息
 *   - 把外部用户映射成 principal
 *   - 交给每用户调度器 + ConversationService
 *   - 通过 WebSocket 广播事件给 Electron
 *   - 执行非 main 用户的定时任务
 *
 * 端口只绑定 127.0.0.1；不对外网开放。
 */

import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer, request as httpRequest } from 'http'
import { spawn } from 'child_process'
import path from 'path'
import { ROOT } from '../core/paths.mjs'
import { loadBridgeConfig } from '../core/config.mjs'
import { resolvePrincipal, listPrincipals, getPrimaryAccount } from '../core/principals.mjs'
import { ensureUser, getCurrentSession } from '../core/user-store.mjs'
import { runTurn } from '../core/conversation.mjs'
import { Scheduler } from '../core/scheduler.mjs'
import { startCronManager } from '../core/cron.mjs'
import { loadAdapters } from '../core/adapters.mjs'

const config = loadBridgeConfig()
const HTTP_PORT = config.httpPort ?? 7779
const WS_PORT = config.wsPort ?? 7780
const HOST = '127.0.0.1'

// ── WebSocket 广播 ────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ host: HOST, port: WS_PORT })

function broadcast(event) {
  const data = JSON.stringify(event)
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data)
  }
}

setInterval(() => {
  for (const ws of wss.clients) if (ws.readyState === 1) ws.ping()
}, 25_000).unref()

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'status', ...getStatus() }))
})

// ── Adapter 加载 ──────────────────────────────────────────────────────────────

const adapters = await loadAdapters()

// ── 调度器 ────────────────────────────────────────────────────────────────────

const scheduler = new Scheduler({
  concurrency: config.scheduler?.userConcurrency ?? 2,
  onEvent: (event) => broadcast(event),
})

// ── 入站消息 ──────────────────────────────────────────────────────────────────

function sendReply(principalId, sourceType, accountId, externalUserId, result) {
  const adapter = adapters[sourceType]
  if (!adapter) {
    console.error(`[bridge] 未知 adapter: ${sourceType}`)
    return
  }
  if (!result.text) return
  adapter.send(externalUserId, result.text, { accountId }).catch(err => {
    console.error(`[bridge] 回复发送失败 (${principalId}):`, err.message)
  })
}

export function routeIncoming({
  sourceType,
  accountId = 'default',
  externalUserId,
  text,
  attachments = [],
  timestamp = new Date().toISOString(),
}) {
  const principal = resolvePrincipal({ sourceType, accountId, externalUserId })
  ensureUser(principal.id)
  const current = getCurrentSession(principal.id)

  // 让 PC 端实时看到用户发来的消息；source 只用于 UI/路由
  broadcast({
    type: 'incoming',
    sourceType,
    accountId,
    principalId: principal.id,
    displayName: principal.displayName,
    sessionId: current?.sessionId || null,
    payload: { from: externalUserId, text, attachments, timestamp },
  })

  scheduler.enqueue(principal.id, async () => {
    let result
    try {
      result = await runTurn({
        principalId: principal.id,
        prompt: text,
        emit: (event) => broadcast({
          ...event,
          sourceType,
          accountId,
          displayName: principal.displayName,
        }),
      })
    } catch (err) {
      console.error(`[bridge] ${principal.id} 运行失败:`, err)
      result = { text: '服务暂时不可用，请稍后再试。', isError: true }
    }

    // 成功或失败都给用户一条回复；失败时的文案已在 conversation 里对普通用户脱敏
    if (result.text) sendReply(principal.id, sourceType, accountId, externalUserId, result)
    if (result.isError) {
      broadcast({
        type: 'error',
        sourceType,
        accountId,
        principalId: principal.id,
        sessionId: result.sessionId || null,
        text: result.text,
      })
    }
  })

  return { ok: true, principalId: principal.id }
}

// ── 用户 Cron（main 的 cron 在 Electron 里跑） ───────────────────────────────

const cron = startCronManager({
  // main 的 cron 在 Electron 进程里跑；这里动态覆盖所有非 main 用户
  principalFilter: (p) => p.id !== 'pc-main',
  onEvent: (event) => broadcast(event),
  enqueue: (principalId, fn) => scheduler.enqueue(principalId, fn),
  runTask: (principal, task) => runTurn({
    principalId: principal.id,
    prompt: task.prompt,
    source: 'cron',
    emit: (event) => broadcast({
      ...event,
      sourceType: getPrimaryAccount(principal)?.sourceType,
      displayName: principal.displayName,
    }),
  }),
  deliver: async (principal, task, result) => {
    if (result.isError) return
    const account = getPrimaryAccount(principal)
    if (!account) {
      console.warn(`[cron] ${principal.id} 没有可发送的账号`)
      return
    }
    const adapter = adapters[account.sourceType]
    if (!adapter) return
    await adapter.send(account.externalUserId, result.text, { accountId: account.accountId })
    broadcast({ type: 'cron_result', principalId: principal.id, taskId: task.id, text: result.text, sessionId: result.sessionId })
  },
})

// ── 启动 adapter ──────────────────────────────────────────────────────────────

for (const [adapterId, adapterConf] of Object.entries(config.adapters ?? {})) {
  if (!adapterConf.enabled) continue
  const adapter = adapters[adapterId]
  if (!adapter) {
    console.warn(`[bridge] 未找到 adapter 模块：${adapterId}`)
    continue
  }
  const accountId = adapterConf.account || 'default'
  adapter.start((payload) => routeIncoming({
    sourceType: adapterId,
    accountId,
    externalUserId: payload.from,
    text: payload.text,
    attachments: payload.attachments,
    timestamp: payload.timestamp,
  }), { accountId }).catch(err => {
    console.error(`[bridge] adapter ${adapterId} 启动失败:`, err)
  })
  console.log(`[bridge] adapter started: ${adapterId} (account: ${accountId})`)
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json())

function getStatus() {
  return {
    scheduler: scheduler.getStatus(),
    principals: listPrincipals().map(p => ({ id: p.id, role: p.role, displayName: p.displayName })),
  }
}

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }))
app.get('/status', (_req, res) => res.json(getStatus()))

app.post('/message', (req, res) => {
  const { adapterId, accountId = 'default', from, text, attachments } = req.body ?? {}
  if (!adapterId || !from || text == null) {
    return res.status(400).json({ ok: false, error: 'adapterId, from, text 均为必填' })
  }
  if (!config.adapters?.[adapterId]) {
    return res.status(400).json({ ok: false, error: `未知 adapterId: ${adapterId}` })
  }
  const result = routeIncoming({
    sourceType: adapterId,
    accountId,
    externalUserId: from,
    text,
    attachments: attachments ?? [],
  })
  res.json(result)
})

app.post('/reload-renderer', (_req, res) => {
  broadcast({ type: 'reload-renderer' })
  res.json({ ok: true })
})

// 开发模式由 scripts/dev-supervisor.mjs 托管 Vite + Electron。
// 优先让 supervisor 只重启 Electron；没有 supervisor（打包模式）时回退到 app.relaunch。
function postSupervisor(pathname) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: 7781,
      path: pathname,
      method: 'POST',
      timeout: 1500,
    }, res => {
      res.resume()
      res.on('end', () => resolve())
    })
    req.on('timeout', () => req.destroy(new Error('supervisor timeout')))
    req.on('error', reject)
    req.end()
  })
}

app.post('/relaunch-electron', async (_req, res) => {
  try {
    await postSupervisor('/restart-electron')
    res.json({ ok: true, mode: 'supervisor' })
  } catch {
    broadcast({ type: 'relaunch-electron' })
    res.json({ ok: true, mode: 'electron' })
  }
})

app.post('/restart-bridge', (_req, res) => {
  res.json({ ok: true, message: 'Bridge Server 将在 500ms 后重启' })
  setTimeout(() => {
    console.log('[bridge] 收到重启指令，正在重启...')
    const child = spawn('node', [path.join(ROOT, 'bridge', 'server.mjs')], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CLAUDECODE: '' },
    })
    child.unref()
    process.exit(0)
  }, 500)
})

const server = createServer(app)
server.listen(HTTP_PORT, HOST, () => {
  console.log(`[bridge] HTTP  listening on ${HOST}:${HTTP_PORT}`)
  console.log(`[bridge] WS    listening on ${HOST}:${WS_PORT}`)
  console.log(JSON.stringify({ type: 'ready', httpPort: HTTP_PORT, wsPort: WS_PORT }))
})

server.on('error', (err) => {
  console.error('[bridge] server error:', err.message)
  process.exit(1)
})

// ── 退出 ──────────────────────────────────────────────────────────────────────

function shutdown() {
  console.log('[bridge] shutting down...')
  cron.stop()
  for (const adapter of Object.values(adapters)) adapter.stop?.()
  server.close()
  wss.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
