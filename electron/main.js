/**
 * Electron 主进程
 *
 * 架构：
 *   - 所有用户配置统一放在项目根目录的 config/ 下
 *   - 主进程动态加载 agents/<activeAgent>/agent.js
 *   - 渲染进程通过统一的 IPC 接口通信，不感知具体 Agent 实现
 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

// ── 配置文件管理 ──────────────────────────────────────────────────────────────
// 所有用户配置统一放在 config/ 目录，重启自动读取，支持持久化

const AGENTS_DIR = path.join(__dirname, '..', 'agents')
// Jarvis 应用根目录，固定不受 process.cwd() 变化影响
const APP_DIR = path.resolve(__dirname, '..')
const CONFIG_DIR = path.join(APP_DIR, 'config')

function getAgentConfigFile(agentId) {
  return path.join(CONFIG_DIR, 'agent.json')
}

function loadConfig(agentId) {
  const id = agentId || 'claude-cc'
  const configFile = getAgentConfigFile(id)
  try {
    if (fs.existsSync(configFile))
      return JSON.parse(fs.readFileSync(configFile, 'utf-8'))
  } catch (e) { console.error('读取配置失败:', e.message) }
  return {}
}

function saveConfig(updates, agentId) {
  const id = agentId || 'claude-cc'
  const configFile = getAgentConfigFile(id)
  const existing = loadConfig(id)
  const merged = { ...existing, ...updates }
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(configFile, JSON.stringify(merged, null, 2), 'utf-8')
  return merged
}

function getApiKey(agentId) {
  const config = loadConfig(agentId)
  return (
    config.apiKey ||
    config.env?.ANTHROPIC_API_KEY ||
    config.env?.ANTHROPIC_AUTH_TOKEN ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    ''
  )
}

function getBaseUrl(agentId) {
  const config = loadConfig(agentId)
  return config.env?.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || ''
}

// ── Agent 加载 ────────────────────────────────────────────────────────────────
// agents/ 目录下每个子文件夹都是一个 Agent 插件

/** 扫描 agents/ 目录，返回所有可用 Agent 的名称列表 */
function listAgents() {
  try {
    return fs.readdirSync(AGENTS_DIR).filter(d =>
      fs.existsSync(path.join(AGENTS_DIR, d, 'agent.mjs')) ||
      fs.existsSync(path.join(AGENTS_DIR, d, 'agent.js'))
    )
  } catch { return [] }
}

/** 动态加载指定 Agent 模块（ESM），返回模块导出 */
async function loadAgent(agentId) {
  // 优先找 .mjs，回退到 .js
  const mjsPath = path.join(AGENTS_DIR, agentId, 'agent.mjs')
  const jsPath  = path.join(AGENTS_DIR, agentId, 'agent.js')
  const agentPath = fs.existsSync(mjsPath) ? mjsPath : jsPath
  if (!fs.existsSync(agentPath)) throw new Error(`Agent 不存在: ${agentId}`)
  return import(`file://${agentPath}`)
}

// ── 窗口创建 ──────────────────────────────────────────────────────────────────
let win

function createWindow() {
  win = new BrowserWindow({
    width: 960, height: 680,
    minWidth: 640, minHeight: 480,
    frame: false,
    resizable: true,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // 开发时加载 Vite dev server，生产时加载打包后的 index.html
  const isDev = !app.isPackaged
  if (isDev) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

app.whenReady().then(async () => {
  // 先加载 memory-store，确保窗口加载时 store 已就绪
  try {
    const store = await import(`file://${path.join(AGENTS_DIR, 'claude-cc', 'memory-store.mjs')}`)
    memoryStoreCache.set('claude-cc', store)
  } catch (err) {
    console.error('memory-store 加载失败:', err.message)
  }
  createWindow()
  setTimeout(connectBridgeWS, 2000)
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// ── 窗口控制 ──────────────────────────────────────────────────────────────────
ipcMain.on('minimize-window', () => win.minimize())
ipcMain.on('close-window',    () => win.close())

// ── 配置读写 ──────────────────────────────────────────────────────────────────
ipcMain.handle('get-config', () => {
  // 先读 activeAgent，再用对应 Agent 的配置文件
  const globalConfig = loadConfig('claude-cc')
  const agentId = globalConfig.activeAgent || 'claude-cc'
  const config = loadConfig(agentId)
  const apiKey = getApiKey(agentId)
  const configFile = getAgentConfigFile(agentId)
  return {
    model: config.model || config.env?.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    hasApiKey: !!apiKey,
    apiKeyPreview: apiKey ? apiKey.slice(0, 8) + '…' : '',
    configPath: configFile,
    activeAgent: agentId,
    availableAgents: listAgents(),
  }
})

ipcMain.handle('save-config', (_, updates) => {
  const config = loadConfig('claude-cc')
  const agentId = config.activeAgent || 'claude-cc'
  saveConfig(updates, agentId)
  return { ok: true, configPath: getAgentConfigFile(agentId) }
})

// 读取配置文件原始 JSON（供弹窗编辑器展示）
ipcMain.handle('read-config-raw', () => {
  const config = loadConfig('claude-cc')
  const agentId = config.activeAgent || 'claude-cc'
  const configFile = getAgentConfigFile(agentId)
  try {
    if (fs.existsSync(configFile))
      return { text: fs.readFileSync(configFile, 'utf-8'), path: configFile }
  } catch {}
  return { text: JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '' }, model: 'claude-sonnet-5-5' }, null, 2), path: configFile }
})

// 保存配置文件原始 JSON
ipcMain.handle('save-config-raw', (_, text) => {
  try {
    JSON.parse(text)
    const config = loadConfig('claude-cc')
    const agentId = config.activeAgent || 'claude-cc'
    const configFile = getAgentConfigFile(agentId)
    fs.writeFileSync(configFile, text, 'utf-8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ── Agent 元数据（模型列表等）────────────────────────────────────────────────
ipcMain.handle('get-agent-meta', async (_, agentId) => {
  const id = agentId || loadConfig('claude-cc').activeAgent || 'claude-cc'
  try {
    const mod = await loadAgent(id)
    return {
      name: mod.name,
      description: mod.description,
      models: mod.models,
      permissionModes: mod.permissionModes,
    }
  } catch (err) {
    return { error: err.message }
  }
})

// ── 发送消息 ──────────────────────────────────────────────────────────────────
ipcMain.handle('send-message', async (event, { prompt, model, permissionMode, sessionId, isMain }) => {
  const agentId = loadConfig('claude-cc').activeAgent || 'claude-cc'
  const apiKey = getApiKey(agentId)
  if (!apiKey) {
    return { text: `未配置 API Key。请编辑 config/agent.json，添加 env.ANTHROPIC_AUTH_TOKEN 或 env.ANTHROPIC_API_KEY。`, cost: 0, turns: 0, isError: true }
  }

  const config = loadConfig(agentId)
  const resolvedModel = model || config.model || config.env?.ANTHROPIC_MODEL || 'claude-sonnet-5-5'
  const baseUrl = getBaseUrl(agentId)
  const cwd = APP_DIR

  // 读取会话工作目录（用于权限控制）
  const store = memoryStoreCache.get(agentId)
  const workDirs = store && sessionId ? store.getSessionWorkDirs(cwd, sessionId) : []

  let agent
  try {
    agent = await loadAgent(agentId)
  } catch (err) {
    return { text: `加载 Agent 失败: ${err.message}`, cost: 0, turns: 0, isError: true }
  }

  // 主会话：从 store 取真实 sessionId，确保每次都能续接上一次的会话
  let resumeSessionId = sessionId || null
  if (isMain && store) {
    const mainSession = store.getOrCreateMainSession(cwd)
    if (mainSession?.sessionId) resumeSessionId = mainSession.sessionId
  }
  // 新建会话（没有 sessionId 且非主会话）：强制不续接任何会话
  // 普通会话（有 sessionId）：直接用 sessionId 续接
  const forceNew = !isMain && !sessionId

  for await (const event_ of agent.run(prompt, {
    model: resolvedModel,
    permissionMode,
    apiKey,
    baseUrl,
    cwd,
    isMain: !!isMain,
    workDirs,
    resumeSessionId,
    forceNew,
  })) {
    if (event_.type === 'tool') {
      event.sender.send('stream-tool', { name: event_.name, input: event_.input })
    } else if (event_.type === 'text') {
      event.sender.send('stream-text', { text: event_.text })
    } else if (event_.type === 'memory') {
      event.sender.send('memory-event', event_)
    } else if (event_.type === 'result') {
      // 主会话首次发消息后，把 SDK 分配的真实 sessionId 持久化到 index
      if (isMain && event_.sessionId && store) {
        store.setMainSessionId(cwd, event_.sessionId)
      }
      return event_
    }
  }

  return { text: '', cost: 0, turns: 0, isError: true }
})

// ── 记忆管理 IPC ──────────────────────────────────────────────────────────────

ipcMain.handle('archive-session', async (_, { cwd: sessionCwd }) => {
  const agentId = loadConfig('claude-cc').activeAgent || 'claude-cc'
  const store = memoryStoreCache.get(agentId)
  if (!store) return { ok: false, error: 'store not ready' }
  const cwd = sessionCwd || APP_DIR

  // 读取会话消息用于摘要
  const current = store.readCurrentSession(cwd)
  if (!current) return { ok: false, error: 'no current session' }

  const messages = current.sessionId ? store.readSessionMessages(cwd, current.sessionId) : []

  // 执行归档
  const archived = store.archiveSession(cwd)
  if (!archived) return { ok: false, error: 'archive failed' }

  // 后台生成摘要并写入长期记忆
  if (messages.length > 1) {
    setImmediate(async () => {
      try {
        const config = loadConfig(agentId)
        const apiKey = getApiKey(agentId)
        const baseUrl = getBaseUrl(agentId)
        const model = config.model || config.env?.ANTHROPIC_MODEL || 'claude-sonnet-5-5'
        if (!apiKey) return

        const { default: Anthropic } = await import('@anthropic-ai/sdk')
        const client = new Anthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) })

        const convoText = messages
          .filter(m => m.type === 'user' || m.type === 'assistant')
          .slice(-30)  // 最多取最近 30 条
          .map(m => `${m.type === 'user' ? '用户' : 'Jarvis'}: ${m.text?.slice(0, 300)}`)
          .join('\n')

        const resp = await client.messages.create({
          model,
          max_tokens: 300,
          messages: [{
            role: 'user',
            content: `请用 1-2 句话总结这次会话的主要内容和结果：\n\n${convoText}\n\n直接输出摘要，不要加前缀。`,
          }],
        })

        const summary = resp.content.find(b => b.type === 'text')?.text?.trim()
        if (summary) {
          store.appendMemoryEntry({
            content: `会话摘要（${new Date(archived.archivedAt).toLocaleDateString('zh-CN')}）：${summary}`,
            type: 'session_summary',
            refs: [],
            cwd,
          })
        }
      } catch (err) {
        console.error('[archive] 摘要生成失败:', err.message)
      }
    })
  }

  return { ok: true, session: archived }
})

ipcMain.handle('get-session-info', (_, { cwd: sessionCwd }) => {
  const agentId = loadConfig('claude-cc').activeAgent || 'claude-cc'
  const store = memoryStoreCache.get(agentId)
  if (!store) return { sessions: [] }
  const cwd = sessionCwd || APP_DIR
  return { sessions: store.listAllSessions(cwd) }
})

// 新建会话：取消当前普通会话的 isCurrent，下次 run() 自动创建新 session
ipcMain.handle('new-session', (_, { cwd: sessionCwd }) => {
  const agentId = loadConfig('claude-cc').activeAgent || 'claude-cc'
  const store = memoryStoreCache.get(agentId)
  if (!store) return { ok: false, error: 'store not ready' }
  const cwd = sessionCwd || APP_DIR
  // 取消非主会话的 current 状态（不归档，只是"不再 current"）
  const current = store.readCurrentSession(cwd)
  if (current && !current.isMain) {
    // switchSession 切到一个不存在的 ID，等效于清空 current
    store.clearCurrentSession(cwd)
  }
  return { ok: true }
})

// 切换到指定会话
ipcMain.handle('resume-session', (_, { cwd: sessionCwd, sessionId }) => {
  const agentId = loadConfig('claude-cc').activeAgent || 'claude-cc'
  const store = memoryStoreCache.get(agentId)
  if (!store) return { ok: false, error: 'store not ready' }
  const cwd = sessionCwd || APP_DIR
  const session = store.switchSession(cwd, sessionId)
  return { ok: true, sessionId, session }
})

// 更新会话名称
ipcMain.handle('update-session-name', (_, { cwd: sessionCwd, sessionId, name }) => {
  const agentId = loadConfig('claude-cc').activeAgent || 'claude-cc'
  const store = memoryStoreCache.get(agentId)
  if (!store) return
  store.updateSessionName(sessionCwd || APP_DIR, sessionId, name)
})

// ── 工作空间 IPC ──────────────────────────────────────────────────────────────

ipcMain.handle('get-workspace-dirs', () => {
  const agentId = loadConfig('claude-cc').activeAgent || 'claude-cc'
  const store = memoryStoreCache.get(agentId)
  if (!store) return []
  return store.readWorkspaceDirs()
})

// 文件选择器：选择目录，加入总工作空间，同时关联到指定会话
ipcMain.handle('pick-workspace-dir', async (_, { cwd: sessionCwd, sessionId, isMain }) => {
  const result = await dialog.showOpenDialog(win, {
    title: '选择工作目录',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || !result.filePaths.length) return { canceled: true }

  const dir = result.filePaths[0]
  const agentId = loadConfig('claude-cc').activeAgent || 'claude-cc'
  const store = memoryStoreCache.get(agentId)
  if (!store) return { canceled: true }

  const cwd = sessionCwd || APP_DIR
  store.addWorkspaceDir(dir)

  if (isMain) {
    // 主会话：直接用 isMain 标记更新，不依赖 sessionId
    store.addWorkDirToMain(cwd, dir)
  } else if (sessionId) {
    const current = store.getSessionWorkDirs(cwd, sessionId)
    if (!current.includes(dir)) {
      store.updateSessionWorkDirs(cwd, sessionId, [...current, dir])
    }
  }

  return { canceled: false, dir }
})

// 从会话移除某个工作目录（不从总工作空间删除）
ipcMain.handle('remove-session-workdir', (_, { cwd: sessionCwd, sessionId, dir, isMain }) => {
  const agentId = loadConfig('claude-cc').activeAgent || 'claude-cc'
  const store = memoryStoreCache.get(agentId)
  if (!store) return
  const cwd = sessionCwd || APP_DIR
  if (isMain) {
    store.removeWorkDirFromMain(cwd, dir)
  } else {
    const current = store.getSessionWorkDirs(cwd, sessionId)
    store.updateSessionWorkDirs(cwd, sessionId, current.filter(d => d !== dir))
  }
})

// ── 主会话 IPC ────────────────────────────────────────────────────────────────

// 设置会话的激活工作目录
ipcMain.handle('set-active-workdir', (_, { sessionId, dir, isMain }) => {
  const agentId = loadConfig('claude-cc').activeAgent || 'claude-cc'
  const store = memoryStoreCache.get(agentId)
  if (!store) return
  store.setSessionActiveWorkdir(APP_DIR, sessionId, dir, isMain)
})

// 获取会话的激活工作目录（没设置时返回 null，前端再 fallback 到默认）
ipcMain.handle('get-active-workdir', (_, { sessionId, isMain }) => {
  const agentId = loadConfig('claude-cc').activeAgent || 'claude-cc'
  const store = memoryStoreCache.get(agentId)
  if (!store) return null
  return store.getSessionActiveWorkdir(APP_DIR, sessionId, isMain)
})

ipcMain.handle('get-main-session', (_, { cwd: sessionCwd }) => {
  const agentId = loadConfig('claude-cc').activeAgent || 'claude-cc'
  const store = memoryStoreCache.get(agentId)
  if (!store) return null
  return store.getOrCreateMainSession(sessionCwd || APP_DIR)
})

// 追加消息到磁盘（渲染进程每次追加消息时调用）
ipcMain.handle('append-session-message', (_, { cwd: sessionCwd, sessionId, record }) => {
  const agentId = loadConfig('claude-cc').activeAgent || 'claude-cc'
  const store = memoryStoreCache.get(agentId)
  if (!store) return
  const cwd = sessionCwd || APP_DIR
  store.appendSessionMessage(cwd, sessionId, record)
})

// 读取某个会话的完整消息历史
ipcMain.handle('read-session-messages', (_, { cwd: sessionCwd, sessionId }) => {
  const agentId = loadConfig('claude-cc').activeAgent || 'claude-cc'
  const store = memoryStoreCache.get(agentId)
  if (!store) return []
  const cwd = sessionCwd || APP_DIR
  return store.readSessionMessages(cwd, sessionId)
})

// ── Bridge adapter 会话 IPC ──────────────────────────────────────────────────
// 读取各外部 adapter 的锚会话列表（用于侧边栏分区显示）

function loadBridgeConfig() {
  const cfgPath = path.join(CONFIG_DIR, 'bridge.json')
  try { return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) } catch { return null }
}

// 返回所有已启用的外部 adapter 及其锚会话列表
ipcMain.handle('get-bridge-sessions', async () => {
  const agentId = loadConfig('claude-cc').activeAgent || 'claude-cc'
  const store = memoryStoreCache.get(agentId)
  if (!store) return []

  const bridgeCfg = loadBridgeConfig()
  if (!bridgeCfg?.adapters) return []

  const result = []
  for (const [adapterId, adapterCfg] of Object.entries(bridgeCfg.adapters)) {
    if (!adapterCfg.enabled) continue
    // 路径与 Bridge Server anchor-session.mjs 保持一致（小写盘符）
    let adapterCwd = path.join(__dirname, '..', 'bridge', 'sessions', adapterId)
    // Windows 上统一小写盘符，避免与 Bridge Server 生成的路径大小写不一致
    adapterCwd = adapterCwd.replace(/^[A-Z]:/, m => m.toLowerCase())
    const sessions = store.listAllSessions(adapterCwd)
    result.push({ adapterId, adapterCwd, sessions })
  }
  return result
})

// 读取某 adapter 锚会话的消息历史
ipcMain.handle('read-bridge-session-messages', (_, { adapterId, sessionId }) => {
  const agentId = loadConfig('claude-cc').activeAgent || 'claude-cc'
  const store = memoryStoreCache.get(agentId)
  if (!store) return []
  let adapterCwd = path.join(__dirname, '..', 'bridge', 'sessions', adapterId)
  adapterCwd = adapterCwd.replace(/^[A-Z]:/, m => m.toLowerCase())
  return store.readSessionMessages(adapterCwd, sessionId)
})

// 同步加载 memory-store（CJS 不能直接 import ESM，用缓存）
const memoryStoreCache = new Map()
function loadMemoryStore(agentId) {
  if (memoryStoreCache.has(agentId)) return memoryStoreCache.get(agentId)
  // memory-store 是 ESM，需要在 app.whenReady 后预加载
  return null  // 在 app.whenReady 中异步初始化
}

// ── Bridge Server WebSocket 客户端 ───────────────────────────────────────────
// 连接 Bridge Server 的广播频道（WS 7780），把外部消息事件转发给渲染进程。
// Bridge Server 由 Task Scheduler 自动启动，Electron 只做订阅者。

let bridgeWs = null
let bridgeReconnectTimer = null

function connectBridgeWS() {
  const { WebSocket: WS } = require('ws')
  bridgeWs = new WS('ws://localhost:7780')
  let firstConnect = !bridgeReconnectTimer  // 首次连接（不是重连）

  bridgeWs.on('open', () => {
    if (firstConnect) console.log('[bridge-ws] connected')
    if (bridgeReconnectTimer) { clearTimeout(bridgeReconnectTimer); bridgeReconnectTimer = null }
  })

  bridgeWs.on('message', (data) => {
    try {
      const event = JSON.parse(data)
      // 处理特殊控制事件
      if (event.type === 'reload-renderer') {
        // 让渲染进程在当前轮次结束后再重载，避免打断正在进行的 AI 处理
        win?.webContents.send('bridge-event', { type: 'reload-renderer' })
        return
      }
      if (event.type === 'relaunch-electron') {
        app.relaunch()
        app.exit(0)
        return
      }
      win?.webContents.send('bridge-event', event)
    } catch {}
  })

  bridgeWs.on('error', () => {
    // Bridge Server 未启动或还没准备好，静默处理
  })

  bridgeWs.on('close', () => {
    bridgeWs = null
    // 断开后 5 秒重试
    bridgeReconnectTimer = setTimeout(connectBridgeWS, 5000)
  })
}

app.on('will-quit', () => {
  if (bridgeReconnectTimer) clearTimeout(bridgeReconnectTimer)
  bridgeWs?.close()
})
