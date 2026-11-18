/**
 * 预加载脚本 —— 在主进程与渲染进程之间建立安全桥接
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('jarvis', {
  // 发送消息到 Claude，返回 Promise<{text, cost, turns, isError}>
  sendMessage: (prompt, model, permissionMode, sessionId, isMain) =>
    ipcRenderer.invoke('send-message', { prompt, model, permissionMode, sessionId, isMain }),

  // 注册工具调用流回调，返回取消订阅函数
  onStreamTool: (callback) => {
    const handler = (_, data) => callback(data)
    ipcRenderer.on('stream-tool', handler)
    return () => ipcRenderer.removeListener('stream-tool', handler)
  },

  // 注册中间文本流回调
  onStreamText: (callback) => {
    const handler = (_, data) => callback(data)
    ipcRenderer.on('stream-text', handler)
    return () => ipcRenderer.removeListener('stream-text', handler)
  },

  // 注册最终结果回调
  onResult: (callback) => {
    const handler = (_, data) => callback(data)
    ipcRenderer.on('result', handler)
    return () => ipcRenderer.removeListener('result', handler)
  },

  // 配置读写
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (updates) => ipcRenderer.invoke('save-config', updates),
  readConfigRaw: () => ipcRenderer.invoke('read-config-raw'),
  saveConfigRaw: (text) => ipcRenderer.invoke('save-config-raw', text),

  // Agent 元数据（模型列表、权限模式等）
  getAgentMeta: (agentId) => ipcRenderer.invoke('get-agent-meta', agentId),

  // 记忆与会话管理
  archiveSession: (cwd) => ipcRenderer.invoke('archive-session', { cwd }),
  newSession: (cwd) => ipcRenderer.invoke('new-session', { cwd }),
  resumeSession: (cwd, sessionId) => ipcRenderer.invoke('resume-session', { cwd, sessionId }),
  getSessionInfo: (cwd) => ipcRenderer.invoke('get-session-info', { cwd }),
  updateSessionName: (sessionId, name) => ipcRenderer.invoke('update-session-name', { sessionId, name }),
  appendSessionMessage: (sessionId, record) => ipcRenderer.invoke('append-session-message', { sessionId, record }),
  readSessionMessages: (sessionId) => ipcRenderer.invoke('read-session-messages', { sessionId }),

  // 工作空间
  getWorkspaceDirs: () => ipcRenderer.invoke('get-workspace-dirs'),
  pickWorkspaceDir: (sessionId, isMain) => ipcRenderer.invoke('pick-workspace-dir', { sessionId, isMain }),
  removeSessionWorkdir: (sessionId, dir, isMain) => ipcRenderer.invoke('remove-session-workdir', { sessionId, dir, isMain }),
  setActiveWorkdir: (sessionId, dir, isMain) => ipcRenderer.invoke('set-active-workdir', { sessionId, dir, isMain }),
  getActiveWorkdir: (sessionId, isMain) => ipcRenderer.invoke('get-active-workdir', { sessionId, isMain }),

  // 主会话
  getMainSession: (opts) => ipcRenderer.invoke('get-main-session', opts || {}),
  onMemoryEvent: (cb) => {
    const h = (_, data) => cb(data)
    ipcRenderer.on('memory-event', h)
    return () => ipcRenderer.removeListener('memory-event', h)
  },
  onSessionStale: (cb) => {
    const h = (_, data) => cb(data)
    ipcRenderer.on('session-stale', h)
    return () => ipcRenderer.removeListener('session-stale', h)
  },

  // 窗口控制
  minimize: () => ipcRenderer.send('minimize-window'),
  close:    () => ipcRenderer.send('close-window'),

  // Bridge Server 外部消息事件
  onBridgeEvent: (cb) => {
    const h = (_, data) => cb(data)
    ipcRenderer.on('bridge-event', h)
    return () => ipcRenderer.removeListener('bridge-event', h)
  },

  // Bridge adapter 会话（侧边栏分区用）
  getBridgeSessions: () => ipcRenderer.invoke('get-bridge-sessions'),
  readBridgeSessionMessages: (adapterId, sessionId) =>
    ipcRenderer.invoke('read-bridge-session-messages', { adapterId, sessionId }),
})
