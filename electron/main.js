/**
 * Electron 主进程
 *
 * 主会话是唯一的 maintainer，独占 main lane（本进程）。
 * 用户会话在 Bridge 进程里跑；这里只读用户会话列表/消息给 PC UI 展示。
 *
 * 所有 Agent 逻辑都通过 core/* 模块；这里只做窗口、IPC、Bridge WS。
 */

const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const http = require('http')
const fs = require('fs')
const { pathToFileURL } = require('url')

const APP_DIR = path.resolve(__dirname, '..')
const PC_MAIN_ID = 'pc-main'

let core = null
let mainCron = null
let mainSchedule = null
let win = null

// ── 单实例锁 ──────────────────────────────────────────────────────────────────
// 两个 Electron 实例共用 %APPDATA%/jarvis 会争用 Cache/GPUCache 目录，
// 表现为 "Unable to move the cache: 拒绝访问 (0x5)"。确保只有一个实例。
//
// 重启兜底路径（app.relaunch）下旧实例可能还在退出，此时短暂重试而不是直接退出。

const RELAUNCH_RETRY_FLAG = '--jarvis-relaunch-retry'

async function acquireSingleInstanceLock() {
  if (app.requestSingleInstanceLock()) return true
  if (!process.argv.includes(RELAUNCH_RETRY_FLAG)) return false
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 200))
    if (app.requestSingleInstanceLock()) {
      console.log('[main] 重启竞态解除，获得单实例锁')
      return true
    }
  }
  return false
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
})

// ── 重启调度 ──────────────────────────────────────────────────────────────────
// 重启请求会等到当前主会话回合结束、消息落盘后再执行，避免打断工具/命令。

let activeMainTurns = 0
let pendingRelaunch = false
let pendingRelaunchTimer = null
let relaunching = false

// 回合卡死时的兜底：10 分钟后强制重启。正常回合应远小于这个时间。
const RELAUNCH_WAIT_MS = 10 * 60 * 1000

function postSupervisor(pathname) {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1',
      port: 7781,
      path: pathname,
      method: 'POST',
      timeout: 1500,
    }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300))
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
    req.end()
  })
}

async function performRelaunch() {
  if (relaunching) return
  relaunching = true
  const ok = await postSupervisor('/restart-electron')
  if (!ok) {
    // 打包模式或 supervisor 不在：回退到 Electron 自带的 relaunch
    // 带上重试标记，让新实例在旧实例退出期间短暂等待单实例锁
    app.relaunch({ args: process.argv.slice(1).concat([RELAUNCH_RETRY_FLAG]) })
    app.exit(0)
  }
}

function clearPendingRelaunchTimer() {
  if (pendingRelaunchTimer) {
    clearTimeout(pendingRelaunchTimer)
    pendingRelaunchTimer = null
  }
}

function requestRelaunch({ force = false } = {}) {
  if (relaunching) return

  if (force) {
    clearPendingRelaunchTimer()
    if (activeMainTurns > 0) {
      console.warn('[main] 强制重启，当前回合会被中断')
    }
    pendingRelaunch = false
    void performRelaunch()
    return
  }

  if (activeMainTurns > 0) {
    pendingRelaunch = true
    if (!pendingRelaunchTimer) {
      pendingRelaunchTimer = setTimeout(() => {
        pendingRelaunchTimer = null
        if (!pendingRelaunch) return
        console.warn('[main] 重启等待超过 10 分钟，强制重启')
        pendingRelaunch = false
        void performRelaunch()
      }, RELAUNCH_WAIT_MS)
    }
    console.log('[main] 重启请求已挂起，等待当前回合结束')
    return
  }

  clearPendingRelaunchTimer()
  pendingRelaunch = false
  void performRelaunch()
}

async function withMainTurn(fn) {
  activeMainTurns += 1
  try {
    return await fn()
  } finally {
    activeMainTurns -= 1
    if (activeMainTurns === 0 && pendingRelaunch) {
      pendingRelaunch = false
      clearPendingRelaunchTimer()
      console.log('[main] 当前回合已结束，执行挂起的重启')
      void performRelaunch()
    }
  }
}

// ── core 模块加载 ─────────────────────────────────────────────────────────────
// core 是 ESM；Electron 主进程是 CJS，用动态 import 加载。

async function initCore() {
  const imp = (rel) => import(pathToFileURL(path.join(APP_DIR, rel)).href)
  core = {
    paths: await imp('core/paths.mjs'),
    config: await imp('core/config.mjs'),
    store: await imp('core/user-store.mjs'),
    principals: await imp('core/principals.mjs'),
    conversation: await imp('core/conversation.mjs'),
    cron: await imp('core/cron.mjs'),
    schedule: await imp('core/schedule.mjs'),
  }
}

// ── 窗口 ──────────────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 640,
    minHeight: 480,
    frame: false,
    resizable: true,
    backgroundColor: '#f7faf6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  loadRenderer()
}

function viteIsRunning() {
  return new Promise(resolve => {
    const req = http.get({ host: 'localhost', port: 5173, path: '/', timeout: 800 }, res => {
      res.resume()
      resolve(res.statusCode >= 200 && res.statusCode < 500)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

/**
 * 开发模式优先连 Vite；如果直接 `npm start`/`electron .` 而 Vite 没开，
 * 就回退到 dist/index.html，避免只看到一个白窗口。
 */
async function loadRenderer() {
  if (!win) return

  if (!app.isPackaged && await viteIsRunning()) {
    win.loadURL('http://localhost:5173')
    if (process.env.JARVIS_DEVTOOLS === '1') win.webContents.openDevTools()
    return
  }

  const distFile = path.join(APP_DIR, 'dist', 'index.html')
  if (fs.existsSync(distFile)) {
    console.log('[main] Vite 未运行，加载 dist/index.html')
    win.loadFile(distFile)
    return
  }

  console.error('[main] Vite 未运行且 dist/index.html 不存在；请先 npm run dev 或 npm run build')
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<html><body style="font-family:Segoe UI,Microsoft YaHei;padding:40px;color:#1b2b22;background:#f7faf6">' +
    '<h2>Jarvis 前端未启动</h2>' +
    '<p>Vite 没有运行，dist/index.html 也不存在。</p>' +
    '<p>开发模式请运行 <code>npm run dev</code>。</p>' +
    '</body></html>'
  ))
}

// ── main cron ────────────────────────────────────────────────────────────────
// main 的定时任务在 Electron 内执行，和主会话共用 main lane / 同一把 principal 锁。

function startMainCron() {
  mainCron = core.cron.startCronManager({
    principalIds: [PC_MAIN_ID],
    runTask: (principal, task) => withMainTurn(() => core.conversation.runTurn({
      principalId: principal.id,
      prompt: task.prompt,
      source: 'cron',
      taskLabel: task.id || '定时任务',
      emit: (event) => win?.webContents.send('cron-event', event),
    })),
    deliver: async (principal, task, result) => {
      win?.webContents.send('cron-result', {
        principalId: principal.id,
        taskId: task.id,
        text: result.text,
        sessionId: result.sessionId,
        isError: result.isError,
      })
    },
    // main 只有一条 lane，promise 链由 ConversationService 的 principal 锁保证
    enqueue: (_id, fn) => fn(),
    onEvent: (event) => win?.webContents.send('cron-event', event),
  })
}

// ── main 日程提醒 ─────────────────────────────────────────────────────────────
// 外部用户日程在 Bridge 里发回自己的账号；main 日程只推送到 PC UI。

function startMainSchedule() {
  mainSchedule = core.schedule.startScheduleManager({
    principalIds: [PC_MAIN_ID],
    enqueue: (_id, fn) => fn(),
    deliver: async (principal, item) => {
      console.log(`[schedule] main reminder: ${item.title}`)
      win?.webContents.send('schedule-reminder', {
        principalId: principal.id,
        schedule: item,
      })
    },
  })
}

// ── 启动 ──────────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // 先拿单实例锁，避免和残留实例争用缓存目录
  if (!(await acquireSingleInstanceLock())) {
    console.log('[main] 已有实例在运行，退出')
    app.exit(0)
    return
  }

  await initCore()
  createWindow()
  startMainCron()
  startMainSchedule()
  connectBridgeWS()
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// ── 窗口控制 ──────────────────────────────────────────────────────────────────

ipcMain.on('minimize-window', () => win?.minimize())
ipcMain.on('close-window', () => win?.close())

// ── 主会话 IPC ────────────────────────────────────────────────────────────────

ipcMain.handle('send-message', async (event, { prompt, sessionId }) => {
  return withMainTurn(() => core.conversation.runTurn({
    principalId: PC_MAIN_ID,
    prompt,
    sessionId: sessionId || null,
    emit: (ev) => {
      if (ev.type === 'text') event.sender.send('stream-text', ev)
      else if (ev.type === 'tool') event.sender.send('stream-tool', ev)
      else if (ev.type === 'memory') event.sender.send('memory-event', ev)
    },
  }))
})

ipcMain.handle('get-main-session', () => core.store.getCurrentSession(PC_MAIN_ID))

ipcMain.handle('get-session-info', () => ({
  sessions: core.store.listSessions(PC_MAIN_ID),
}))

ipcMain.handle('read-session-messages', (_event, { sessionId }) =>
  core.store.readMessages(PC_MAIN_ID, sessionId)
)

// 用户会话：PC UI 只读展示
ipcMain.handle('get-user-sessions', () => {
  return core.principals.listPrincipals()
    .filter(p => p.id !== PC_MAIN_ID)
    .map(p => ({
      principalId: p.id,
      displayName: p.displayName,
      role: p.role,
      sessions: core.store.listSessions(p.id),
    }))
})

ipcMain.handle('read-user-session-messages', (_event, { principalId, sessionId }) =>
  core.store.readMessages(principalId, sessionId)
)

// 配置：只暴露模型等非敏感信息；凭证不进入 UI
ipcMain.handle('get-config', () => ({
  model: core.config.getModel(),
  activeAgent: 'jarvis',
  availableAgents: ['jarvis'],
}))

ipcMain.handle('get-agent-meta', async () => {
  const mod = await import(pathToFileURL(path.join(APP_DIR, 'agents', 'agent.mjs')).href)
  return {
    name: mod.name,
    description: mod.description,
    models: mod.models,
    permissionModes: mod.permissionModes,
  }
})

// ── Bridge WS ────────────────────────────────────────────────────────────────
// Bridge 只在本机；事件带 principalId/sessionId，前端按用户/会话过滤。

let bridgeWs = null
let bridgeReconnectTimer = null

function connectBridgeWS() {
  const { WebSocket: WS } = require('ws')
  bridgeWs = new WS('ws://127.0.0.1:7780')

  bridgeWs.on('open', () => {
    if (bridgeReconnectTimer) {
      clearTimeout(bridgeReconnectTimer)
      bridgeReconnectTimer = null
    }
  })

  bridgeWs.on('message', (data) => {
    const event = JSON.parse(data)
    if (event.type === 'relaunch-electron') {
      requestRelaunch({ force: !!event.force })
      return
    }
    win?.webContents.send('bridge-event', event)
  })

  // Bridge 可能还没启动；连接错误不弹出未处理异常，等 close 重连
  bridgeWs.on('error', () => {})

  bridgeWs.on('close', () => {
    bridgeWs = null
    bridgeReconnectTimer = setTimeout(connectBridgeWS, 5000)
  })
}

app.on('will-quit', () => {
  mainCron?.stop()
  mainSchedule?.stop()
  if (bridgeReconnectTimer) clearTimeout(bridgeReconnectTimer)
  bridgeWs?.close()
})
