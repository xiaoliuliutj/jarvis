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
import fs from 'fs'
import path from 'path'
import { ROOT } from '../core/paths.mjs'
import { loadBridgeConfig } from '../core/config.mjs'
import { resolvePrincipal, listPrincipals, getPrimaryAccount } from '../core/principals.mjs'
import { ensureUser, getCurrentSession } from '../core/user-store.mjs'
import { runTurn } from '../core/conversation.mjs'
import { Scheduler } from '../core/scheduler.mjs'
import { startCronManager } from '../core/cron.mjs'
import { startScheduleManager } from '../core/schedule.mjs'
import { formatScheduleReminder } from '../core/schedule-store.mjs'
import { handleIncomingOnboarding } from '../core/onboarding.mjs'
import { loadAdapters } from '../core/adapters.mjs'
import { ensureFileDirs, prepareInbound, listOutboxFiles, markOutboxSent } from '../core/files.mjs'

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

async function sendText(principalId, sourceType, accountId, externalUserId, text) {
  const adapter = adapters[sourceType]
  if (!adapter) throw new Error(`未知 adapter: ${sourceType}`)
  await adapter.send(externalUserId, text, { accountId })
}

async function sendReply(principalId, sourceType, accountId, externalUserId, result) {
  if (!result.text) return
  try {
    await sendText(principalId, sourceType, accountId, externalUserId, result.text)
  } catch (err) {
    console.error(`[bridge] 回复发送失败 (${principalId}):`, err.message)
  }
}

/**
 * 回合结束后投递发件箱：把 outbox 里的文件逐个发送，成功后归档到 sent/。
 * adapter 未实现 sendFile 时静默跳过。
 */
async function deliverOutbox(principalId, sourceType, accountId, externalUserId) {
  const adapter = adapters[sourceType]
  if (!adapter?.sendFile) return

  let files = []
  try {
    files = listOutboxFiles(principalId)
  } catch (err) {
    console.error(`[bridge] 读取发件箱失败 (${principalId}):`, err.message)
    return
  }
  if (!files.length) return

  for (const f of files) {
    try {
      await adapter.sendFile(externalUserId, f.path, { accountId, fileName: f.name })
      markOutboxSent(principalId, f.path)
      broadcast({ type: 'outbound_file', principalId, fileName: f.name, ok: true })
      console.log(`[bridge] 文件已发送 (${principalId}): ${f.name}`)
    } catch (err) {
      console.error(`[bridge] 文件发送失败 (${principalId}/${f.name}):`, err.message)
      broadcast({ type: 'outbound_file', principalId, fileName: f.name, ok: false, error: err.message })
    }
  }
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
    payload: {
      from: externalUserId,
      text,
      // 只广播元信息，不把二进制内容发到 WS
      attachments: (attachments || []).map(a => ({
        kind: a.kind || 'file',
        fileName: a.fileName || '',
        size: Buffer.isBuffer(a.buffer) ? a.buffer.length : (a.size ?? 0),
      })),
      timestamp,
    },
  })

  // 新用户先做风格引导，不进入模型
  const onboarding = handleIncomingOnboarding({
    principalId: principal.id,
    isNew: !!principal.isNew,
    text,
  })
  if (onboarding.handled) {
    sendText(principal.id, sourceType, accountId, externalUserId, onboarding.reply).catch(err => {
      console.error(`[onboarding] ${principal.id} 发送引导失败:`, err.message)
    })
    return { ok: true, principalId: principal.id, onboarding: true }
  }

  scheduler.enqueue(principal.id, async () => {
    let result
    try {
      ensureFileDirs(principal.id)
      // 附件落盘 + 解析预览，拼进 prompt
      const attachmentBlock = attachments?.length
        ? await prepareInbound(principal.id, attachments)
        : ''
      const prompt = [text, attachmentBlock].filter(Boolean).join('\n\n')

      if (!prompt) {
        result = { text: '', cost: 0, turns: 0, isError: false, sessionId: current?.sessionId || null }
      } else {
        result = await runTurn({
          principalId: principal.id,
          prompt,
          emit: (event) => broadcast({
            ...event,
            sourceType,
            accountId,
            displayName: principal.displayName,
          }),
        })
      }
    } catch (err) {
      console.error(`[bridge] ${principal.id} 运行失败:`, err)
      result = { text: '服务暂时不可用，请稍后再试。', isError: true }
    }

    // 成功或失败都给用户一条回复；失败时的文案已在 conversation 里对普通用户脱敏
    await sendReply(principal.id, sourceType, accountId, externalUserId, result)
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

    // 回合结束后投递发件箱
    await deliverOutbox(principal.id, sourceType, accountId, externalUserId)
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
    await deliverOutbox(principal.id, account.sourceType, account.accountId, account.externalUserId)
    broadcast({ type: 'cron_result', principalId: principal.id, taskId: task.id, text: result.text, sessionId: result.sessionId })
  },
})

// ── 用户日程提醒（main 的日程在 Electron 里跑） ─────────────────────────────

const schedule = startScheduleManager({
  principalFilter: (p) => p.id !== 'pc-main',
  enqueue: (principalId, fn) => scheduler.enqueue(principalId, fn),
  deliver: async (principal, item) => {
    const account = getPrimaryAccount(principal)
    if (!account) throw new Error('没有可发送的账号')
    await sendText(
      principal.id,
      account.sourceType,
      account.accountId,
      account.externalUserId,
      formatScheduleReminder(item)
    )
  },
  onEvent: (event) => {
    if (event.type === 'schedule_reminder') {
      console.log(`[schedule] 提醒已发送: ${event.principalId}`)
    }
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
  const accountKeys = Array.isArray(adapterConf.accounts) && adapterConf.accounts.length
    ? [...new Set(adapterConf.accounts)]
    : [adapterConf.account || 'default']

  for (const accountId of accountKeys) {
    adapter.start((payload) => routeIncoming({
      sourceType: adapterId,
      accountId,
      externalUserId: payload.from,
      text: payload.text,
      attachments: payload.attachments,
      timestamp: payload.timestamp,
    }), { accountId }).catch(err => {
      console.error(`[bridge] adapter ${adapterId} (${accountId}) 启动失败:`, err.message)
    })
    console.log(`[bridge] adapter started: ${adapterId} (account: ${accountId})`)
  }
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

app.post('/relaunch-electron', async (req, res) => {
  const force = req.query.force === '1'

  // Electron 在线时交给它调度：当前主会话回合结束后再重启。
  if (wss.clients.size > 0) {
    broadcast({ type: 'relaunch-electron', force })
    res.json({ ok: true, mode: 'electron', force })
    return
  }

  // PC UI 没连接（例如窗口已关）时，直接让 supervisor 拉起来。
  try {
    await postSupervisor('/restart-electron')
    res.json({ ok: true, mode: 'supervisor' })
  } catch {
    res.json({ ok: false, error: 'Electron 未连接，supervisor 也不可用' })
  }
})

function restartBridgeProcess(delayMs = 500) {
  setTimeout(() => {
    console.log('[bridge] 收到重启指令，正在重启...')

    // 自动重启也要继续写日志；stdio:'ignore' 会导致新进程完全失联。
    const logFile = path.join(ROOT, 'bridge', 'bridge.log')
    const errFile = path.join(ROOT, 'bridge', 'bridge.err.log')
    const outFd = fs.openSync(logFile, 'a')
    const errFd = fs.openSync(errFile, 'a')

    const child = spawn('node', [path.join(ROOT, 'bridge', 'server.mjs')], {
      detached: true,
      stdio: ['ignore', outFd, errFd],
      env: { ...process.env, CLAUDECODE: '' },
    })
    child.unref()
    fs.closeSync(outFd)
    fs.closeSync(errFd)
    process.exit(0)
  }, delayMs)
}

app.post('/restart-bridge', (_req, res) => {
  res.json({ ok: true, message: 'Bridge Server 将在 500ms 后重启' })
  restartBridgeProcess()
})

// 同时重启 Bridge 和 Electron。Electron 仍走回合感知的重启队列。
app.post('/restart-all', (req, res) => {
  const force = req.query.force === '1'
  if (wss.clients.size > 0) {
    broadcast({ type: 'relaunch-electron', force })
  } else {
    void postSupervisor('/restart-electron').catch(() => {})
  }
  res.json({ ok: true, message: 'Bridge 即将重启；Electron 将在当前回合结束后重启' })
  restartBridgeProcess(700)
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
  schedule.stop()
  for (const adapter of Object.values(adapters)) adapter.stop?.()
  server.close()
  wss.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
