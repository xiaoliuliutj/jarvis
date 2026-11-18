/**
 * bridge/server.mjs
 *
 * Bridge Server 主进程。
 *   HTTP  7779 — adapter 推消息进来，管理 API
 *   WebSocket 7780 — 广播事件流（工具调用、结果、状态变化）
 *
 * 启动：node bridge/server.mjs
 * （在 Claude Code 会话里启动时需先 unset CLAUDECODE）
 */

import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { init as initAdapterManager, routeMessage, getStatus } from './adapter-manager.mjs'
import { initCronManager, startCronManager, stopCronManager, startInactivityWatcher } from './cron-manager.mjs'
import * as weixinAdapter from './adapters/weixin.mjs'

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.join(BRIDGE_DIR, '..', 'config', 'bridge.json')

// ── 配置加载 ──────────────────────────────────────────────────────────────────

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
}

const config = loadConfig()
const HTTP_PORT = config.httpPort ?? 7779
const WS_PORT   = config.wsPort   ?? 7780

// ── WebSocket 广播 ────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: WS_PORT })

// 每 25 秒 ping 所有客户端，防止 NAT/防火墙掐掉空闲 TCP 连接
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.ping()
  }
}, 25000)

function broadcast(event) {
  const data = JSON.stringify(event)
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) {
      client.send(data)
    }
  }
}

wss.on('connection', (ws) => {
  // 新客户端连接时推当前状态
  ws.send(JSON.stringify({ type: 'status', ...getStatus() }))
})

wss.on('error', (err) => {
  console.error('[bridge] WebSocket error:', err.message)
})

// ── Adapter 注册 ──────────────────────────────────────────────────────────────

const ADAPTER_MODULES = {
  weixin: weixinAdapter,
}

// 初始化 adapter-manager，注入 broadcast 和 adapter send 映射
initAdapterManager({
  broadcast,
  adapters: ADAPTER_MODULES,
  config,
})

// ── Cron 管理器初始化 ──────────────────────────────────────────────────────────
// runAgent: 让 cron 任务走和普通消息一样的 adapter-manager 路径
// 但不走队列（直接运行），因为 cron 是系统主动触发，不需要排队

import { runAdapterDirect } from './adapter-manager.mjs'

initCronManager({
  adapters: ADAPTER_MODULES,
  runAgent: (adapterId, prompt) => runAdapterDirect(adapterId, {
    from: '__cron__',
    text: prompt,
    timestamp: new Date().toISOString(),
  }),
  broadcast,
})
startCronManager()
startInactivityWatcher()

// 启动所有 enabled 的 adapter
for (const [adapterId, adapterConf] of Object.entries(config.adapters ?? {})) {
  if (!adapterConf.enabled) continue
  const mod = ADAPTER_MODULES[adapterId]
  if (!mod) {
    console.warn(`[bridge] 未找到 adapter 模块：${adapterId}`)
    continue
  }
  mod.start((payload) => {
    routeMessage(adapterId, { ...payload, timestamp: payload.timestamp ?? new Date().toISOString() })
  }).catch(err => {
    console.error(`[bridge] adapter ${adapterId} start 失败:`, err.message)
  })
  console.log(`[bridge] adapter started: ${adapterId}`)
}

// ── HTTP 服务 ─────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json())

/** 存活检查 */
app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() })
})

/** 当前状态 */
app.get('/status', (_req, res) => {
  res.json(getStatus())
})

/**
 * 推入消息
 * Body: { adapterId: string, from: string, text: string, attachments?: any[] }
 * 立即返回 { ok, messageId, status:'running'|'queued' }
 * 结果异步通过 WebSocket 7780 广播
 */
app.post('/message', (req, res) => {
  const { adapterId, from, text, attachments } = req.body ?? {}

  if (!adapterId || !from || text == null) {
    return res.status(400).json({ ok: false, error: 'adapterId, from, text 均为必填' })
  }

  if (!config.adapters?.[adapterId]) {
    return res.status(400).json({ ok: false, error: `未知 adapterId: ${adapterId}` })
  }

  const payload = { from, text, attachments: attachments ?? [], timestamp: new Date().toISOString() }
  broadcast({ type: 'incoming', adapterId, payload })

  const { messageId, status } = routeMessage(adapterId, payload)
  res.json({ ok: true, messageId, status })
})

/** 触发 Electron 渲染层刷新（通过 WS 广播） */
app.post('/reload-renderer', (_req, res) => {
  broadcast({ type: 'reload-renderer' })
  res.json({ ok: true })
})

/** 触发 Electron 完整重启（通过 WS 广播） */
app.post('/relaunch-electron', (_req, res) => {
  broadcast({ type: 'relaunch-electron' })
  res.json({ ok: true })
})

/** Bridge Server 自重启（先返回响应，再延迟重启，避免杀死 MCP 子进程） */
app.post('/restart-bridge', (_req, res) => {
  res.json({ ok: true, message: 'Bridge Server 将在 500ms 后重启' })
  setTimeout(() => {
    console.log('[bridge] 收到重启指令，正在重启...')
    import('child_process').then(({ spawn }) => {
      const child = spawn(
        'node',
        ['E:\\Jarvis\\bridge\\server.mjs'],
        {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, CLAUDECODE: '' },
          shell: false,
        }
      )
      child.unref()
      process.exit(0)
    })
  }, 500)
})
app.post('/adapters/:id/activate', (req, res) => {
  const { id } = req.params
  if (!config.adapters?.[id]) return res.status(404).json({ ok: false, error: '未知 adapter' })
  // 发一条空消息触发激活（激活逻辑在 routeMessage 里）
  res.json({ ok: true, note: '通过发送消息触发激活' })
})

const server = createServer(app)
server.listen(HTTP_PORT, () => {
  console.log(`[bridge] HTTP  listening on :${HTTP_PORT}`)
  console.log(`[bridge] WS    listening on :${WS_PORT}`)
  // 以 JSON 行输出就绪信号，供父进程（Electron spawn）检测
  console.log(JSON.stringify({ type: 'ready', httpPort: HTTP_PORT, wsPort: WS_PORT }))
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[bridge] 端口 ${HTTP_PORT} 已被占用，请先停止占用该端口的进程`)
  } else {
    console.error('[bridge] HTTP server error:', err.message)
  }
  process.exit(1)
})

// ── 优雅退出 ──────────────────────────────────────────────────────────────────

function shutdown() {
  console.log('[bridge] shutting down...')
  clearInterval(heartbeatInterval)
  stopCronManager()
  for (const mod of Object.values(ADAPTER_MODULES)) {
    mod.stop?.()
  }
  server.close()
  wss.close()
  process.exit(0)
}

process.on('SIGINT',  shutdown)
process.on('SIGTERM', shutdown)
