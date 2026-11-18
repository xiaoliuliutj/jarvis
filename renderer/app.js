/**
 * Jarvis 渲染进程逻辑
 */

const $ = (sel) => document.querySelector(sel)
const messages = $('#messages')
const input = $('#input')
const btnSend = $('#btn-send')
const settingsPanel = $('#settings-panel')

let busy = false
let totalCost = 0
let totalTurns = 0

// ── 会话消息存储 ──────────────────────────────────────────────────────────────
// 每个 sessionId 对应一个 { role, text, type }[] 数组
// 切换会话时清空 DOM，重新渲染目标会话的消息

const sessionMessages = new Map()   // Map<sessionId, MessageRecord[]>
let currentSessionId = '__new__'    // 当前活跃会话 ID

/** 保存当前 DOM 消息到 sessionMessages */
function saveCurrentMessages() {
  // 消息已经在追加时同步记录，不需要从 DOM 反读
}

/** 切换到指定会话，清空 DOM 并重新渲染 */
async function switchToSession(sessionId) {
  const isSameSession = currentSessionId === sessionId
  currentSessionId = sessionId
  messages.innerHTML = ''

  if (!sessionId.startsWith('__new__')) {
    if (!isSameSession || !sessionMessages.has(sessionId)) {
      // 切换到不同会话，或内存里没有：从磁盘加载
      const diskHistory = await window.jarvis.readSessionMessages(sessionId)
      if (diskHistory && diskHistory.length > 0) {
        sessionMessages.set(sessionId, diskHistory)
      }
    }
    // 同一会话且内存有数据：直接用内存（内存是最新的）
  }

  const history = sessionMessages.get(sessionId) || []
  let hi = 0
  while (hi < history.length) {
    const rec = history[hi]
    if (rec.type === 'user') {
      _renderUserBubble(rec.text)
      hi++
    } else if (rec.type === 'tool' || rec.type === 'thinking') {
      // 收集连续的 tool/thinking 记录
      const toolRecs = []
      while (hi < history.length && (history[hi].type === 'tool' || history[hi].type === 'thinking')) {
        toolRecs.push(history[hi])
        hi++
      }

      // 检查后面是否紧跟 assistant
      const nextIsAssistant = hi < history.length && history[hi].type === 'assistant'

      if (nextIsAssistant) {
        // 后面是 assistant，保存工具记录供下一步使用
        lastToolRecs = toolRecs
      } else {
        // 后面不是 assistant，直接显示为折叠块
        const toolCount = toolRecs.filter(r => r.type === 'tool').length
        const details = document.createElement('details')
        details.className = 'thinking-details'
        const summary = document.createElement('summary')
        summary.className = 'thinking-summary'
        summary.textContent = `${toolCount} 个工具调用`
        details.appendChild(summary)
        for (const tr of toolRecs) {
          if (tr.type === 'tool') {
            const el = document.createElement('div')
            el.className = 'tool-tag'
            const args = JSON.stringify(tr.input ?? {})
            const preview = args.length > 90 ? args.slice(0, 90) + '…' : args
            el.textContent = `${tr.name}(${preview})`
            details.appendChild(el)
          } else if (tr.type === 'thinking') {
            const el = document.createElement('div')
            el.className = 'msg msg-assistant'
            el.style.fontSize = '12.5px'
            el.style.opacity = '0.8'
            el.textContent = tr.text
            details.appendChild(el)
          }
        }
        messages.appendChild(details)
      }
    } else if (rec.type === 'assistant') {
      _renderAssistantBubble(rec.text)
      hi++
    } else if (rec.type === 'error') {
      _renderErrorBubble(rec.text)
      hi++
    } else if (rec.type === 'system') {
      _renderSystemNote(rec.text)
      hi++
    } else {
      hi++
    }
  }
  scrollDown()
}

/** 记录一条消息到当前会话历史（内存 + 磁盘） */
function recordMessage(rec) {
  if (!sessionMessages.has(currentSessionId)) sessionMessages.set(currentSessionId, [])
  sessionMessages.get(currentSessionId).push(rec)
  // 只有真实 session ID（非临时 __new__ ID）才写磁盘
  if (!currentSessionId.startsWith('__new__')) {
    window.jarvis.appendSessionMessage(currentSessionId, rec).catch(() => {})
  }
}

// ── DOM 渲染原语（不记录，只渲染） ────────────────────────────────────────────

function _renderUserBubble(text) {
  // 外层容器（flex）
  const wrapper = document.createElement('div')
  wrapper.className = 'msg-wrapper msg-wrapper-user'

  // 用户名称标签
  const nameEl = document.createElement('div')
  nameEl.className = 'msg-name'
  nameEl.textContent = 'User'
  wrapper.appendChild(nameEl)

  // 气泡
  const bubble = document.createElement('div')
  bubble.className = 'msg msg-user'
  bubble.textContent = text
  wrapper.appendChild(bubble)

  messages.appendChild(wrapper)
}

function _renderAssistantBubble(text) {
  // 外层容器（flex）
  const wrapper = document.createElement('div')
  wrapper.className = 'msg-wrapper msg-wrapper-assistant'

  // AI 名称标签
  const nameEl = document.createElement('div')
  nameEl.className = 'msg-name'
  nameEl.textContent = 'Jarvis'
  wrapper.appendChild(nameEl)

  // 添加工具折叠块（名字下方）
  // 优先级：lastToolRecs（来自历史）> lastToolTags（来自实时）
  if ((lastToolRecs && lastToolRecs.length > 0) || (lastToolTags && lastToolTags.length > 0)) {
    let toolsToShow = lastToolRecs && lastToolRecs.length > 0 ? lastToolRecs : []

    if (toolsToShow.length === 0 && lastToolTags && lastToolTags.length > 0) {
      // 从 lastToolTags 创建工具记录
      for (const tag of lastToolTags) {
        toolsToShow.push({ type: 'tool', name: '(tool)', input: {} })
      }
    }

    const toolCount = toolsToShow.filter(r => r.type === 'tool').length
    if (toolCount > 0 || toolsToShow.some(r => r.type === 'thinking')) {
      const details = document.createElement('details')
      details.className = 'thinking-details'
      const summary = document.createElement('summary')
      summary.className = 'thinking-summary'
      summary.textContent = `${toolCount} 个工具调用`
      details.appendChild(summary)

      for (const tr of toolsToShow) {
        if (tr.type === 'tool') {
          const el = document.createElement('div')
          el.className = 'tool-tag'
          const args = JSON.stringify(tr.input ?? {})
          const preview = args.length > 90 ? args.slice(0, 90) + '…' : args
          el.textContent = `${tr.name}(${preview})`
          details.appendChild(el)
        } else if (tr.type === 'thinking') {
          const el = document.createElement('div')
          el.className = 'msg msg-assistant'
          el.style.fontSize = '12.5px'
          el.style.opacity = '0.8'
          el.textContent = tr.text
          details.appendChild(el)
        }
      }
      wrapper.appendChild(details)
    }

    lastToolRecs = []
    lastToolTags = []
  }

  // 气泡
  const bubble = document.createElement('div')
  bubble.className = 'msg msg-assistant'
  bubble.textContent = text
  wrapper.appendChild(bubble)

  messages.appendChild(wrapper)
}

function _renderErrorBubble(text) {
  const wrapper = document.createElement('div')
  wrapper.className = 'msg-wrapper msg-wrapper-error'

  const nameEl = document.createElement('div')
  nameEl.className = 'msg-name'
  nameEl.textContent = 'Error'
  wrapper.appendChild(nameEl)

  const bubble = document.createElement('div')
  bubble.className = 'msg msg-error'
  bubble.textContent = text
  wrapper.appendChild(bubble)

  messages.appendChild(wrapper)
}

function _renderSystemNote(text) {
  const note = document.createElement('div')
  note.className = 'msg msg-system-note'
  note.textContent = text
  messages.appendChild(note)
}

function appendUserMessage(text) {
  recordMessage({ type: 'user', text })
  _renderUserBubble(text)
  scrollDown()
}

function appendAssistantMessage(text) {
  recordMessage({ type: 'assistant', text })
  _renderAssistantBubble(text)
  scrollDown()
}

function appendToolTag(name, input) {
  lastToolTags.push({ name, input })
  recordMessage({ type: 'tool', name, input })
}

function appendThinkingText(text) {
  recordMessage({ type: 'thinking', text })
}

function appendErrorMessage(text) {
  recordMessage({ type: 'error', text })
  _renderErrorBubble(text)
  scrollDown()
}

function appendSystemMessage(text) {
  recordMessage({ type: 'system', text })
  _renderSystemNote(text)
  scrollDown()
}

// ── 工具变量 ────────────────────────────────────────────────────────────────────

let lastToolRecs = []
let lastToolTags = []

function scrollDown() {
  const chatArea = document.getElementById('chat-area')
  if (chatArea) {
    setTimeout(() => {
      chatArea.scrollTop = chatArea.scrollHeight
    }, 0)
  }
}

// ── 权限管理 ────────────────────────────────────────────────────────────────────

let currentAdapterReadonly = false
let currentAdapterId = null

function setReadonlyMode(readonly, adapterId) {
  currentAdapterReadonly = readonly
  currentAdapterId = adapterId
  input.disabled = readonly
  btnSend.disabled = readonly
  const hint = document.getElementById('readonly-hint')
  if (hint) hint.style.display = readonly ? '' : 'none'
  if (hint && readonly) {
    const icons = { weixin: '💬', qq: '🐧', email: '📧' }
    const icon = icons[adapterId] ?? '🔗'
    hint.textContent = `${icon} 该会话只能通过 ${adapterId} 回复`
  }
}

// ── PC 端事件监听 ────────────────────────────────────────────────────────────────

let isMainSession = false

window.jarvis.onStreamText((data) => {
  const chatArea = document.getElementById('chat-area')
  if (!document.querySelector('.msg-streaming')) {
    const el = document.createElement('div')
    el.className = 'msg msg-assistant msg-streaming'
    messages.appendChild(el)
  }
  const streamEl = document.querySelector('.msg-streaming')
  streamEl.textContent += data.text
  chatArea.scrollTop = chatArea.scrollHeight
})

window.jarvis.onStreamTool((data) => {
  appendToolTag(data.name, data.input)
})

window.jarvis.onResult((result) => {
  if (result.sessionId && currentSessionId.startsWith('__new__')) {
    sessionMessages.delete(currentSessionId)
    currentSessionId = result.sessionId
  }

  const streamEl = document.querySelector('.msg-streaming')
  if (streamEl) {
    streamEl.textContent = ''
    streamEl.remove()
  }

  appendAssistantMessage(result.text)
  if (result.cost) totalCost += result.cost
  if (result.turns) totalTurns += result.turns
})

// ── Bridge 端事件监听 ────────────────────────────────────────────────────────────

window.jarvis.onBridgeEvent?.((event) => {
  const { adapterId, type, payload, name, input, text, messageId, from, timestamp, ...rest } = event

  if (type === 'incoming') {
    const wrapper = document.createElement('div')
    wrapper.className = 'msg-wrapper msg-wrapper-user'
    const nameEl = document.createElement('div')
    nameEl.className = 'msg-name'
    nameEl.textContent = `${adapterId.toUpperCase()}`
    wrapper.appendChild(nameEl)
    const bubble = document.createElement('div')
    bubble.className = 'msg msg-user'
    bubble.textContent = payload?.text ?? ''
    wrapper.appendChild(bubble)
    messages.appendChild(wrapper)
    recordMessage({ type: 'user', text: payload?.text ?? '', from: payload?.from ?? adapterId })
    scrollDown()
  } else if (type === 'tool') {
    appendToolTag(name, input)
  } else if (type === 'result') {
    const wrapper = document.createElement('div')
    wrapper.className = 'msg-wrapper msg-wrapper-assistant'
    const nameEl = document.createElement('div')
    nameEl.className = 'msg-name'
    nameEl.textContent = 'Jarvis'
    wrapper.appendChild(nameEl)
    const bubble = document.createElement('div')
    bubble.className = 'msg msg-assistant'
    bubble.textContent = text ?? ''
    wrapper.appendChild(bubble)
    messages.appendChild(wrapper)
    recordMessage({ type: 'assistant', text: text ?? '' })
    if (rest.cost) totalCost += rest.cost
    if (rest.turns) totalTurns += rest.turns
    scrollDown()
  }
})

// ── 输入处理 ──────────────────────────────────────────────────────────────────

async function send() {
  if (busy || currentAdapterReadonly) return
  busy = true

  const text = input.value.trim()
  if (!text) {
    busy = false
    return
  }

  input.value = ''
  input.style.height = 'auto'

  appendUserMessage(text)

  try {
    lastToolTags = []
    lastToolRecs = []
    const result = await window.jarvis.sendMessage(text, getSelectedModel(), getPermissionMode(), currentSessionId, isMainSession)
    busy = false
  } catch (err) {
    appendErrorMessage(`❌ ${err.message}`)
    busy = false
  }
}

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  } else if (e.key === 'Enter' && e.shiftKey) {
    // Shift+Enter 换行
  } else {
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 120) + 'px'
  }
})

btnSend.addEventListener('click', send)

// ── 会话侧边栏 ──────────────────────────────────────────────────────────────────

const SESSION_SIDEBAR_LIMIT = 5
let showAllSessions = false
let showArchivedSessions = false

async function refreshSessionList() {
  try {
    const info = await window.jarvis.getSessionInfo()
    const sessions = info?.sessions ?? []
    const container = document.getElementById('session-list')
    if (!container) return

    container.innerHTML = ''

    const bridgeAdapters = window.jarvis.getBridgeSessions
      ? await window.jarvis.getBridgeSessions()
      : []

    const fmt = (iso) => iso
      ? new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : ''

    const mainSessions = sessions.filter(s => s.isMain)
    const activeSessions = sessions.filter(s => !s.isMain && s.isCurrent)
    const idleSessions = sessions.filter(s => !s.isMain && !s.isCurrent && !s.archivedAt)
    const archivedSessions = sessions.filter(s => !s.isMain && !s.isCurrent && !!s.archivedAt)

    const renderEntry = (s, { readonly = false, adapterId = null, sourceLabel = null } = {}) => {
      const isActive = readonly && adapterId
        ? (currentAdapterId === adapterId && currentSessionId === (s.sessionId || `__bridge__${adapterId}`))
        : (s.isCurrent || s.isMain)

      const item = document.createElement('div')
      item.className = `session-entry ${isActive ? 'active' : ''}`
      if (readonly) item.classList.add('readonly-session')
      if (s.isMain) item.classList.add('main-session')
      if (s.archivedAt) item.classList.add('archived-session')

      // 左侧圆点
      const dot = document.createElement('div')
      dot.className = 'session-entry-dot'
      item.appendChild(dot)

      // 中间信息区
      const info = document.createElement('div')
      info.className = 'session-entry-info'

      const name = document.createElement('div')
      name.className = 'session-entry-name'
      name.textContent = (sourceLabel ? `${sourceLabel} ` : '') + (s.name || '新会话')
      info.appendChild(name)

      const time = document.createElement('div')
      time.className = 'session-entry-time'
      time.textContent = fmt(s.lastActiveAt)
      info.appendChild(time)

      item.appendChild(info)

      // 右侧操作按钮（悬停显示）
      if (!readonly && !s.isMain && s.isCurrent) {
        const actions = document.createElement('div')
        actions.className = 'session-entry-actions'
        const archiveBtn = document.createElement('button')
        archiveBtn.className = 'btn-archive-icon'
        archiveBtn.title = '归档'
        archiveBtn.textContent = '🗂'
        archiveBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          window.jarvis.archiveSession(s.sessionId).catch(console.error)
          refreshSessionList().catch(console.error)
        })
        actions.appendChild(archiveBtn)
        item.appendChild(actions)
      }

      item.addEventListener('click', async () => {
        if (readonly && adapterId) {
          currentAdapterId = adapterId
          currentSessionId = s.sessionId || `__bridge__${adapterId}`
          setReadonlyMode(true, adapterId)

          if (s.sessionId) {
            const history = await window.jarvis.readBridgeSessionMessages(adapterId, s.sessionId)
            messages.innerHTML = ''

            for (const rec of history) {
              if (rec.type === 'user') {
                _renderBridgeIncoming(adapterId, rec.from || adapterId, rec.text)
              } else if (rec.type === 'assistant') {
                _renderBridgeResult(adapterId, rec.text)
              }
            }
            scrollDown()
          }
          await refreshSessionList()
        } else {
          currentSessionId = s.sessionId
          isMainSession = s.isMain
          setReadonlyMode(false, null)
          await switchToSession(s.sessionId)
          await refreshSessionList()
        }
      })

      return item
    }

    if (mainSessions.length > 0) {
      for (const s of mainSessions) {
        container.appendChild(renderEntry(s))
      }
    }

    if (activeSessions.length > 0) {
      for (const s of activeSessions) {
        container.appendChild(renderEntry(s))
      }
    }

    if (idleSessions.length > 0) {
      const limited = showAllSessions ? idleSessions : idleSessions.slice(0, SESSION_SIDEBAR_LIMIT)
      for (const s of limited) {
        container.appendChild(renderEntry(s))
      }

      if (!showAllSessions && idleSessions.length > SESSION_SIDEBAR_LIMIT) {
        const more = document.createElement('div')
        more.className = 'session-more'
        more.textContent = `↓ 还有 ${idleSessions.length - SESSION_SIDEBAR_LIMIT} 个会话`
        more.addEventListener('click', async () => {
          showAllSessions = true
          await refreshSessionList()
        })
        container.appendChild(more)
      }
    }

    const ADAPTER_ICONS = { weixin: '💬', qq: '🐧', email: '📧' }
    for (const { adapterId, sessions: adapterSessions } of bridgeAdapters) {
      if (!adapterSessions.length) continue
      const icon = ADAPTER_ICONS[adapterId] ?? '🔗'
      for (const s of adapterSessions) {
        container.appendChild(renderEntry(s, { readonly: true, adapterId, sourceLabel: `${icon} ${adapterId.toUpperCase()}` }))
      }
    }

    if (archivedSessions.length > 0 && !showArchivedSessions) {
      const more = document.createElement('div')
      more.className = 'session-more'
      more.textContent = `↓ 还有 ${archivedSessions.length} 个已归档会话`
      more.addEventListener('click', async () => {
        showArchivedSessions = true
        await refreshSessionList()
      })
      container.appendChild(more)
    } else if (archivedSessions.length > 0 && showArchivedSessions) {
      for (const s of archivedSessions) {
        container.appendChild(renderEntry(s))
      }
    }

  } catch (err) {
    console.error('[app] 刷新会话列表失败:', err.message)
  }
}

// ── 工作目录管理 ──────────────────────────────────────────────────────────────

async function refreshWorkdirBar() {
  try {
    const workDirs = await window.jarvis.getWorkspaceDirs()
    const bar = document.getElementById('workdir-bar')
    const list = document.getElementById('workdir-list')

    if (!bar || !list) return

    if (!workDirs || workDirs.length === 0) {
      bar.classList.add('hidden')
      return
    }

    bar.classList.remove('hidden')
    list.innerHTML = ''

    for (const dir of workDirs) {
      const tag = document.createElement('span')
      tag.className = 'workdir-tag'
      tag.textContent = dir.split(/[\\/]/).pop()
      tag.title = dir
      list.appendChild(tag)
    }
  } catch (err) {
    console.error('[app] 刷新工作目录失败:', err.message)
  }
}

// ── 其他控制 ──────────────────────────────────────────────────────────────────

$('#btn-minimize').addEventListener('click', () => window.jarvis.minimize())
$('#btn-close').addEventListener('click', () => window.jarvis.close())

$('#btn-settings').addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden')
})

const btnNewSession = $('#btn-new-session')
if (btnNewSession) {
  btnNewSession.addEventListener('click', async () => {
    const result = await window.jarvis.newSession()
    if (result.ok) {
      currentSessionId = '__new__'
      messages.innerHTML = ''
      scrollDown()
    }
  })
}

// ── 启动初始化 ────────────────────────────────────────────────────────────────

;(async () => {
  // 1. 读取配置
  const config = await window.jarvis.getConfig()
  window.__jarvisConfig = config

  const currentModel = config.model || 'claude-sonnet-5-5'
  const modelDisplay = document.getElementById('current-model-display')
  if (modelDisplay) modelDisplay.textContent = currentModel
  const pathHint = document.getElementById('config-path-hint')
  if (pathHint) pathHint.textContent = config.configPath || ''

  // 2. 加载Agent元数据
  const meta = await window.jarvis.getAgentMeta(config.activeAgent)
  if (meta && !meta.error) {
    renderPermissionOptions(meta.permissionModes)
  }

  // 3. Agent选择器
  if (config.availableAgents && config.availableAgents.length > 1) {
    renderAgentSelector(config.availableAgents, config.activeAgent)
  }

  // 4. 加载主会话
  const mainSession = await window.jarvis.getMainSession({ cwd: null })
  isMainSession = true
  if (mainSession?.sessionId) {
    currentSessionId = mainSession.sessionId
    await switchToSession(mainSession.sessionId)
    if ((sessionMessages.get(currentSessionId) || []).length === 0) {
      _renderAssistantBubble('快来开始玩耍吧！(=^-ω-^=)')
    }
  } else {
    currentSessionId = '__main__'
    _renderAssistantBubble('快来开始玩耍吧！(=^-ω-^=)')
  }

  // 5. 刷新会话和工作目录
  await refreshSessionList()
  await refreshWorkdirBar()

  // 6. 记忆日志
  if (window.jarvis?.onMemoryEvent) {
    window.jarvis.onMemoryEvent((ev) => {
      if (ev.action === 'append') {
        const log = document.getElementById('memory-log')
        if (log) {
          const item = document.createElement('div')
          item.className = 'memory-log-item'
          item.textContent = `📝 ${ev.entry.type}: ${ev.entry.content.slice(0, 60)}`
          log.prepend(item)
          while (log.children.length > 20) log.removeChild(log.lastChild)
        }
      }
    })
  }
})()

// ── 动态渲染权限模式下拉 ──────────────────────────────────────────────────────

function renderPermissionOptions(modes) {
  const select = document.getElementById('select-permission')
  if (!select || !modes) return
  select.innerHTML = ''
  modes.forEach(m => {
    const opt = document.createElement('option')
    opt.value = m.id
    opt.textContent = m.label
    select.appendChild(opt)
  })
}

function getSelectedModel() {
  return window.__jarvisConfig?.model || 'claude-sonnet-5-5'
}

function getPermissionMode() {
  const select = document.getElementById('select-permission')
  return select?.value || 'auto'
}

function renderAgentSelector(agents, activeAgent) {
  const section = document.getElementById('agent-selector-section')
  if (!section) return
  section.innerHTML = '<div class="settings-label">切换 Agent</div>'
  agents.forEach(id => {
    const btn = document.createElement('button')
    btn.className = 'agent-btn' + (id === activeAgent ? ' active' : '')
    btn.textContent = id
    btn.addEventListener('click', async () => {
      await window.jarvis.saveConfig({ activeAgent: id })
      location.reload()
    })
    section.appendChild(btn)
  })
  section.style.display = ''
}
