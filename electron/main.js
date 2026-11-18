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
const { pathToFileURL } = require('url')

const APP_DIR = path.resolve(__dirname, '..')
const PC_MAIN_ID = 'pc-main'

let core = null
let mainCron = null
let win = null

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
    backgroundColor: '#f4f7f2',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const isDev = !app.isPackaged
  if (isDev) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(APP_DIR, 'dist', 'index.html'))
  }
}

// ── main cron ────────────────────────────────────────────────────────────────
// main 的定时任务在 Electron 内执行，和主会话共用 main lane / 同一把 principal 锁。

function startMainCron() {
  mainCron = core.cron.startCronManager({
    principalIds: [PC_MAIN_ID],
    runTask: (principal, task) => core.conversation.runTurn({
      principalId: principal.id,
      prompt: task.prompt,
      source: 'cron',
      emit: (event) => win?.webContents.send('cron-event', event),
    }),
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

// ── 启动 ──────────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await initCore()
  createWindow()
  startMainCron()
  connectBridgeWS()
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// ── 窗口控制 ──────────────────────────────────────────────────────────────────

ipcMain.on('minimize-window', () => win?.minimize())
ipcMain.on('close-window', () => win?.close())

// ── 主会话 IPC ────────────────────────────────────────────────────────────────

ipcMain.handle('send-message', async (event, { prompt, sessionId }) => {
  return core.conversation.runTurn({
    principalId: PC_MAIN_ID,
    prompt,
    sessionId: sessionId || null,
    emit: (ev) => {
      if (ev.type === 'text') event.sender.send('stream-text', ev)
      else if (ev.type === 'tool') event.sender.send('stream-tool', ev)
      else if (ev.type === 'memory') event.sender.send('memory-event', ev)
    },
  })
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
  activeAgent: 'claude-cc',
  availableAgents: ['claude-cc'],
}))

ipcMain.handle('get-agent-meta', async () => {
  const mod = await import(pathToFileURL(path.join(APP_DIR, 'agents', 'claude-cc', 'agent.mjs')).href)
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
      app.relaunch()
      app.exit(0)
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
  if (bridgeReconnectTimer) clearTimeout(bridgeReconnectTimer)
  bridgeWs?.close()
})
