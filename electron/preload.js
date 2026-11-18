/**
 * 预加载脚本：渲染进程与主进程的唯一桥。
 *
 * 新架构只暴露：
 *   - 主会话发送/流事件
 *   - 主会话历史
 *   - 用户（principal）会话只读列表/历史
 *   - Bridge 实时事件
 *   - main cron 事件
 */

const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback) {
  const handler = (_event, data) => callback(data)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('jarvis', {
  // 主会话
  sendMessage: ({ prompt, sessionId }) => ipcRenderer.invoke('send-message', { prompt, sessionId }),
  onStreamText: (cb) => subscribe('stream-text', cb),
  onStreamTool: (cb) => subscribe('stream-tool', cb),
  onMemoryEvent: (cb) => subscribe('memory-event', cb),

  getMainSession: () => ipcRenderer.invoke('get-main-session'),
  getSessionInfo: () => ipcRenderer.invoke('get-session-info'),
  readSessionMessages: (sessionId) => ipcRenderer.invoke('read-session-messages', { sessionId }),

  // 配置 / agent 元数据（不暴露凭证）
  getConfig: () => ipcRenderer.invoke('get-config'),
  getAgentMeta: () => ipcRenderer.invoke('get-agent-meta'),

  // 用户会话（只读）
  getUserSessions: () => ipcRenderer.invoke('get-user-sessions'),
  readUserSessionMessages: (principalId, sessionId) =>
    ipcRenderer.invoke('read-user-session-messages', { principalId, sessionId }),

  // Bridge 实时事件 / main cron / main 日程提醒
  onBridgeEvent: (cb) => subscribe('bridge-event', cb),
  onCronResult: (cb) => subscribe('cron-result', cb),
  onCronEvent: (cb) => subscribe('cron-event', cb),
  onScheduleReminder: (cb) => subscribe('schedule-reminder', cb),

  // 窗口
  minimize: () => ipcRenderer.send('minimize-window'),
  close: () => ipcRenderer.send('close-window'),
})
