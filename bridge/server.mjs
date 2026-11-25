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
import { ROOT, PC_MAIN_ID } from '../core/paths.mjs'
import { loadBridgeConfig } from '../core/config.mjs'
import { resolvePrincipal, listPrincipals, getPrimaryAccount } from '../core/principals.mjs'
import { ensureUser, getCurrentSession, readPersona, lastUserMessageAt } from '../core/user-store.mjs'
import { generateInterimNotice } from '../core/interim-notice.mjs'
import { runTurn } from '../core/conversation.mjs'
import { Scheduler } from '../core/scheduler.mjs'
import { startCronManager } from '../core/cron.mjs'
import { startScheduleManager } from '../core/schedule.mjs'
import { formatScheduleReminder } from '../core/schedule-store.mjs'
import { orderDeliveryAccounts } from '../core/delivery.mjs'
import { handleIncomingOnboarding } from '../core/onboarding.mjs'
import { loadAdapters } from '../core/adapters.mjs'
import { ensureFileDirs, prepareInbound, listOutboxFiles, takeOutboxBatch, markOutboxSent, isImageFile } from '../core/files.mjs'
import { logInfo, logWarn, logError } from '../core/logger.mjs'

const config = loadBridgeConfig()
const HTTP_PORT = config.httpPort ?? 7779
const WS_PORT = config.wsPort ?? 7780
const HOST = '127.0.0.1'

// 非主会话：超过这个时间还没最终回复，先发一句「正在处理」提示
const INTERIM_NOTICE_DELAY_MS = 10_000

// 单回合最多发送的文件数：微信 iLink 对单次入站消息的回复数量有限制，
// 一次发太多会触发 ret:-2 prepare failed，多出的文件留到下一回合。
const MAX_OUTBOX_FILES_PER_TURN = 6

// 用户最后互动时间（用于空闲触发任务，例如「长时间没见就无聊」）；Bridge 启动时间作为初始基线
const bridgeStartedAt = Date.now()
const lastActivity = new Map()

function getLastActivityFor(principalId) {
  if (lastActivity.has(principalId)) return lastActivity.get(principalId)
  // Bridge 刚重启、内存里没有：从会话记录里恢复最后一条用户消息时间
  const fromSessions = lastUserMessageAt(principalId)
  if (fromSessions) {
    lastActivity.set(principalId, fromSessions)
    return fromSessions
  }
  return bridgeStartedAt
}

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

async function sendText(principalId, sourceType, accountId, externalUserId, text, replyTo = null) {
  const adapter = adapters[sourceType]
  if (!adapter) throw new Error(`未知 adapter: ${sourceType}`)
  await adapter.send(replyTo || externalUserId, text, { accountId })
}

async function sendReply(principalId, sourceType, accountId, externalUserId, result, replyTo = null) {
  if (!result.text) return
  try {
    await sendText(principalId, sourceType, accountId, externalUserId, result.text, replyTo)
  } catch (err) {
    logError('reply.fail', err.message, { principalId, sourceType })
  }
}

/**
 * 回合结束后投递发件箱：把 outbox 里的文件逐个发送，成功后归档到 sent/。
 * adapter 未实现 sendFile 时静默跳过。
 */
async function deliverOutbox(principalId, sourceType, accountId, externalUserId, replyTo = null) {
  const adapter = adapters[sourceType]
  if (!adapter?.sendFile) return
  const target = replyTo || externalUserId

  let files = []
  try {
    files = listOutboxFiles(principalId)
  } catch (err) {
    logError('outbox.read.fail', err.message, { principalId })
    return
  }
  if (!files.length) return

  // 限制单回合发送数量，避免触发微信回复条数限制（ret:-2 prepare failed）
  const { batch, remaining } = takeOutboxBatch(files, MAX_OUTBOX_FILES_PER_TURN)
  if (remaining > 0) {
    logWarn('outbox.defer', `本轮发送 ${batch.length} 个，剩余 ${remaining} 个留待下一回合`, {
      principalId,
      total: files.length,
    })
    broadcast({ type: 'outbox_defer', principalId, sent: batch.length, remaining })
  }

  for (const f of batch) {
    try {
      // 图片走图片消息通道（微信里直接显示为图片），其余走文件通道
      const useImage = isImageFile(f.name) && typeof adapter.sendImage === 'function'
      const sendOne = useImage ? adapter.sendImage : adapter.sendFile
      await sendOne.call(adapter, target, f.path, { accountId, fileName: f.name })
      markOutboxSent(principalId, f.path)
      broadcast({ type: 'outbound_file', principalId, fileName: f.name, ok: true, kind: useImage ? 'image' : 'file' })
      logInfo('file.sent', f.name, { principalId, kind: useImage ? 'image' : 'file' })
    } catch (err) {
      logError('file.fail', err.message, { principalId, file: f.name })
      broadcast({ type: 'outbound_file', principalId, fileName: f.name, ok: false, error: err.message })
    }
  }
}

/**
 * 选择一个可用的投递账号：App 在线时优先 App，否则回退到其他渠道（微信）。
 */
function pickDeliveryAccount(principal) {
  for (const account of orderDeliveryAccounts(principal)) {
    const adapter = adapters[account.sourceType]
    if (!adapter?.send) continue
    if (account.sourceType === 'app' && typeof adapter.isOnline === 'function' && !adapter.isOnline(account.externalUserId)) {
      continue
    }
    return account
  }
  return null
}

/**
 * 按「App 优先、其他渠道兜底」发送文本，返回实际使用的账号。
 * 某个渠道发送失败会自动尝试下一个渠道。
 */
async function sendToPrincipal(principal, text) {
  for (const account of orderDeliveryAccounts(principal)) {
    const adapter = adapters[account.sourceType]
    if (!adapter?.send) continue
    if (account.sourceType === 'app' && typeof adapter.isOnline === 'function' && !adapter.isOnline(account.externalUserId)) {
      continue
    }
    try {
      await adapter.send(account.externalUserId, text, { accountId: account.accountId })
      return account
    } catch (err) {
      logWarn('deliver.fail', err.message, { principalId: principal.id, sourceType: account.sourceType })
    }
  }
  return null
}

export function routeIncoming({
  sourceType,
  accountId = 'default',
  externalUserId,
  replyTo = null,
  text,
  attachments = [],
  timestamp = new Date().toISOString(),
  owner = false,
}) {
  const principal = resolvePrincipal({ sourceType, accountId, externalUserId })
  ensureUser(principal.id)
  lastActivity.set(principal.id, Date.now())
  const current = getCurrentSession(principal.id)

  logInfo('message.in', '', {
    principalId: principal.id,
    sourceType,
    textLen: String(text || '').length,
    attachments: attachments?.length || 0,
    owner: !!owner,
  })

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
    sendText(principal.id, sourceType, accountId, externalUserId, onboarding.reply, replyTo).catch(err => {
      console.error(`[onboarding] ${principal.id} 发送引导失败:`, err.message)
    })
    return { ok: true, principalId: principal.id, onboarding: true }
  }

  scheduler.enqueue(principal.id, async () => {
    let result
    let replyDone = false
    let interimTimer = null

    // 非主会话：10 秒内没有最终回复时，先发一句符合人设的「正在处理」
    if (principal.id !== PC_MAIN_ID) {
      interimTimer = setTimeout(async () => {
        if (replyDone) return
        try {
          const persona = readPersona(principal.id)
          const notice = await generateInterimNotice({ persona, displayName: principal.displayName })
          if (replyDone) return
          await sendText(principal.id, sourceType, accountId, externalUserId, notice, replyTo)
          console.log(`[bridge] 已发送「正在处理」提示 (${principal.id}): ${notice}`)
        } catch (err) {
          console.warn(`[bridge] 「正在处理」提示发送失败 (${principal.id}):`, err.message)
        }
      }, INTERIM_NOTICE_DELAY_MS)
    }

    const turnStarted = Date.now()
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
          roleOverride: owner ? 'owner' : null,
          emit: (event) => broadcast({
            ...event,
            sourceType,
            accountId,
            displayName: principal.displayName,
          }),
        })
      }
    } catch (err) {
      logError('turn.fail', err?.message || String(err), { principalId: principal.id })
      result = { text: '服务暂时不可用，请稍后再试。', isError: true }
    }

    logInfo('turn.done', '', {
      principalId: principal.id,
      sourceType,
      ms: Date.now() - turnStarted,
      isError: !!result?.isError,
      cost: result?.cost ?? 0,
      turns: result?.turns ?? 0,
    })

    // 最终回复开始发送：停掉「正在处理」计时器
    replyDone = true
    if (interimTimer) clearTimeout(interimTimer)

    // 成功或失败都给用户一条回复；失败时的文案已在 conversation 里对普通用户脱敏
    await sendReply(principal.id, sourceType, accountId, externalUserId, result, replyTo)
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
    await deliverOutbox(principal.id, sourceType, accountId, externalUserId, replyTo)
  })

  return { ok: true, principalId: principal.id }
}

// ── 用户 Cron（main 的 cron 在 Electron 里跑） ───────────────────────────────

const cron = startCronManager({
  // main 的 cron 在 Electron 进程里跑；这里动态覆盖所有非 main 用户
  principalFilter: (p) => p.id !== 'pc-main',
  onEvent: (event) => broadcast(event),
  enqueue: (principalId, fn) => scheduler.enqueue(principalId, fn),
  getLastActivity: getLastActivityFor,
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
    // [SILENT]：夜间等场景下不打扰用户（结果一般已写入报告文件）
    if (!result.text || result.text.includes('[SILENT]')) {
      logInfo('cron.silent', '', { principalId: principal.id, taskId: task.id })
      return
    }
    // App 在线时优先发到 App，否则回退到微信等主账号
    const account = await sendToPrincipal(principal, result.text)
    if (!account) {
      logWarn('cron.no-account', '', { principalId: principal.id, taskId: task.id })
      return
    }
    logInfo('cron.deliver', '', { principalId: principal.id, taskId: task.id, sourceType: account.sourceType })
    await deliverOutbox(principal.id, account.sourceType, account.accountId, account.externalUserId)
    broadcast({ type: 'cron_result', principalId: principal.id, taskId: task.id, text: result.text, sessionId: result.sessionId })
  },
})

// ── 用户日程提醒（main 的日程在 Electron 里跑） ─────────────────────────────

const schedule = startScheduleManager({
  principalFilter: (p) => p.id !== 'pc-main',
  enqueue: (principalId, fn) => scheduler.enqueue(principalId, fn),
  deliver: async (principal, item) => {
    const target = pickDeliveryAccount(principal) || getPrimaryAccount(principal)
    if (!target) throw new Error('没有可发送的账号')

    // 用当前用户的人设生成提醒文案；模型不可用时退回模板
    let text = formatScheduleReminder(item)
    try {
      const result = await runTurn({
        principalId: principal.id,
        prompt: `【日程提醒】现在是用户设置的日程提醒时间，请用符合你人设的语气给用户发一条简短的提醒。\n日程：${item.title}\n${item.notes ? `备注：${item.notes}\n` : ''}要求：口语化、简短（1-3 句）、保持你的人设，不用 Markdown。`,
        source: 'cron',
        emit: (event) => broadcast({
          ...event,
          principalId: principal.id,
          sourceType: target.sourceType,
          displayName: principal.displayName,
        }),
      })
      if (result?.text && !result.isError) text = result.text
    } catch (err) {
      logWarn('schedule.persona.fail', err.message, { principalId: principal.id })
    }

    // App 在线时优先发到 App，否则回退到微信等主账号
    const sent = await sendToPrincipal(principal, text)
    if (!sent) throw new Error('提醒发送失败：没有可用渠道')
    logInfo('schedule.remind', item.title || '', { principalId: principal.id, sourceType: sent.sourceType })
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
      replyTo: payload.replyTo || null,
      text: payload.text,
      attachments: payload.attachments,
      timestamp: payload.timestamp,
      owner: payload.owner === true,
    }), { accountId }).catch(err => {
      logError('adapter.fail', err.message, { adapterId, accountId })
    })
    logInfo('adapter.start', '', { adapterId, accountId })
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
