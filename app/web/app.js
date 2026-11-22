/* Jarvis App 端 Demo —— 依赖后端 /api/message + /ws */
(function () {
  'use strict'

  const KEYS = {
    url: 'jarvis.app.url',
    token: 'jarvis.app.token',
    device: 'jarvis.app.device',
    history: 'jarvis.app.history',
  }
  const MAX_HISTORY = 200

  const el = {
    messages: document.getElementById('messages'),
    input: document.getElementById('input'),
    send: document.getElementById('sendBtn'),
    attach: document.getElementById('attachBtn'),
    fileInput: document.getElementById('fileInput'),
    preview: document.getElementById('attachPreview'),
    dot: document.getElementById('statusDot'),
    status: document.getElementById('statusText'),
    settings: document.getElementById('settingsBtn'),
    setup: document.getElementById('setup'),
    setupUrl: document.getElementById('setupUrl'),
    setupToken: document.getElementById('setupToken'),
    setupDevice: document.getElementById('setupDevice'),
    setupSave: document.getElementById('setupSave'),
    setupError: document.getElementById('setupError'),
  }

  const state = {
    url: '',
    token: '',
    device: 'owner',
    ws: null,
    retry: 0,
    authFailed: false,
    attachments: [],
    typingEl: null,
    typingTimer: null,
  }

  // ── 存储 ────────────────────────────────────────────────────────────────
  function read(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
  }
  function write(key, value) {
    try { localStorage.setItem(key, value) } catch {}
  }

  function historyKey() {
    return `${KEYS.history}:${state.url}:${state.device}`
  }
  function loadHistory() {
    try { return JSON.parse(read(historyKey(), '[]')) || [] } catch { return [] }
  }
  function saveHistory(items) {
    try { write(historyKey(), JSON.stringify(items.slice(-MAX_HISTORY))) } catch {}
  }

  // ── 初始化配置 ──────────────────────────────────────────────────────────
  function initConfig() {
    const params = new URLSearchParams(location.search)
    const qToken = params.get('token')
    const qDevice = params.get('device')
    if (qToken) write(KEYS.token, qToken)
    if (qDevice) write(KEYS.device, qDevice)
    if (qToken || qDevice) {
      try { history.replaceState(null, '', location.pathname) } catch {}
    }

    state.url = (read(KEYS.url, '') || location.origin).replace(/\/+$/, '')
    state.token = read(KEYS.token, '')
    state.device = read(KEYS.device, 'owner') || 'owner'
    write(KEYS.url, state.url)
  }

  function openSetup(error) {
    el.setupUrl.value = state.url || location.origin
    el.setupToken.value = state.token || ''
    el.setupDevice.value = state.device || 'owner'
    el.setupError.textContent = error || ''
    el.setup.classList.remove('hidden')
    setTimeout(() => el.setupToken.focus(), 50)
  }

  function closeSetup() {
    el.setup.classList.add('hidden')
  }

  el.setupSave.addEventListener('click', () => {
    const url = (el.setupUrl.value || '').trim().replace(/\/+$/, '')
    const token = (el.setupToken.value || '').trim()
    const device = (el.setupDevice.value || 'owner').trim()
    if (!/^https?:\/\//i.test(url)) { el.setupError.textContent = '地址要以 http:// 或 https:// 开头'; return }
    if (!token) { el.setupError.textContent = '请填写访问令牌'; return }
    state.url = url
    state.token = token
    state.device = device || 'owner'
    state.authFailed = false
    write(KEYS.url, state.url)
    write(KEYS.token, state.token)
    write(KEYS.device, state.device)
    closeSetup()
    connect()
    renderAll()
  })

  el.settings.addEventListener('click', () => openSetup(''))

  // ── 连接 ────────────────────────────────────────────────────────────────
  function setStatus(text, mode) {
    el.status.textContent = text
    el.dot.className = 'dot' + (mode ? ' ' + mode : '')
  }

  function wsUrl() {
    const base = state.url.replace(/^http/i, 'ws')
    return `${base}/ws?token=${encodeURIComponent(state.token)}&device=${encodeURIComponent(state.device)}`
  }

  function connect() {
    if (!state.token) { openSetup(''); setStatus('未连接', 'offline'); return }
    if (state.authFailed) { setStatus('令牌无效', 'offline'); return }
    if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return

    setStatus('连接中…', '')
    let ws
    try { ws = new WebSocket(wsUrl()) } catch {
      setStatus('地址不合法', 'offline')
      return
    }
    state.ws = ws

    ws.onopen = () => {
      state.retry = 0
      setStatus('在线', 'online')
    }

    ws.onmessage = (event) => {
      let msg
      try { msg = JSON.parse(event.data) } catch { return }
      handleEvent(msg)
    }

    ws.onclose = (event) => {
      state.ws = null
      if (event && event.code === 4401) {
        state.authFailed = true
        setStatus('令牌无效', 'offline')
        openSetup('访问令牌不正确，请重新填写')
        return
      }
      setStatus('已断开', 'offline')
      scheduleReconnect()
    }

    ws.onerror = () => {
      setStatus('连接失败', 'offline')
    }
  }

  function scheduleReconnect() {
    if (!state.token || state.authFailed) return
    state.retry = Math.min(state.retry + 1, 6)
    const delay = Math.min(1000 * Math.pow(1.6, state.retry), 15000)
    setTimeout(() => {
      if (!state.ws) connect()
    }, delay)
  }

  setInterval(() => {
    if (state.ws && state.ws.readyState === 1) {
      try { state.ws.send(JSON.stringify({ type: 'ping' })) } catch {}
    } else if (!state.ws && state.token && !state.authFailed) {
      connect()
    }
  }, 25000)

  function handleEvent(msg) {
    if (msg.type === 'assistant' && msg.text) {
      clearTyping()
      appendMessage({ role: 'bot', text: msg.text, ts: msg.timestamp || new Date().toISOString() })
    } else if (msg.type === 'file') {
      clearTyping()
      appendMessage({
        role: 'bot',
        text: '',
        file: { name: msg.fileName, url: msg.url, isImage: !!msg.isImage },
        ts: msg.timestamp || new Date().toISOString(),
      })
    } else if (msg.type === 'notice') {
      appendMessage({ role: 'system', text: msg.text || '', ts: new Date().toISOString() })
    }
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────
  function formatTime(ts) {
    try {
      const d = new Date(ts)
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    } catch { return '' }
  }

  function buildMessageEl(item) {
    const div = document.createElement('div')
    div.className = 'msg ' + (item.role === 'user' ? 'user' : item.role === 'system' ? 'system' : 'bot')

    if (item.file) {
      const card = document.createElement('div')
      card.className = 'file-card'
      const link = document.createElement('a')
      link.href = item.file.url
      link.target = '_blank'
      link.rel = 'noopener'
      link.textContent = item.file.name || '文件'
      card.appendChild(link)
      div.appendChild(card)
      if (item.file.isImage) {
        const img = document.createElement('img')
        img.className = 'attachment'
        img.src = item.file.url
        img.alt = item.file.name || '图片'
        div.appendChild(img)
      }
    } else {
      div.appendChild(document.createTextNode(item.text || ''))
    }

    if (item.role !== 'system') {
      const meta = document.createElement('span')
      meta.className = 'meta'
      meta.textContent = formatTime(item.ts)
      div.appendChild(meta)
    }
    return div
  }

  function appendMessage(item) {
    const history = loadHistory()
    history.push(item)
    saveHistory(history)
    el.messages.appendChild(buildMessageEl(item))
    scrollToBottom()
  }

  function renderAll() {
    el.messages.textContent = ''
    for (const item of loadHistory()) {
      el.messages.appendChild(buildMessageEl(item))
    }
    scrollToBottom()
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      el.messages.scrollTop = el.messages.scrollHeight
    })
  }

  function showTyping() {
    if (state.typingEl) return
    const div = document.createElement('div')
    div.className = 'typing'
    for (let i = 0; i < 3; i++) div.appendChild(document.createElement('i'))
    state.typingEl = div
    el.messages.appendChild(div)
    scrollToBottom()
    state.typingTimer = setTimeout(clearTyping, 120000)
  }

  function clearTyping() {
    if (state.typingTimer) clearTimeout(state.typingTimer)
    state.typingTimer = null
    if (state.typingEl) {
      state.typingEl.remove()
      state.typingEl = null
    }
  }

  // ── 附件 ────────────────────────────────────────────────────────────────
  el.attach.addEventListener('click', () => el.fileInput.click())

  el.fileInput.addEventListener('change', async () => {
    const files = Array.from(el.fileInput.files || [])
    el.fileInput.value = ''
    for (const file of files) {
      if (state.attachments.length >= 3) break
      if (file.size > 8 * 1024 * 1024) {
        appendMessage({ role: 'system', text: `「${file.name}」超过 8MB，已跳过`, ts: new Date().toISOString() })
        continue
      }
      const dataBase64 = await fileToBase64(file)
      state.attachments.push({
        fileName: file.name,
        kind: file.type.startsWith('image/') ? 'image' : 'file',
        dataBase64,
      })
    }
    renderAttachments()
  })

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '')
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  function renderAttachments() {
    el.preview.textContent = ''
    state.attachments.forEach((att, index) => {
      const chip = document.createElement('span')
      chip.className = 'attach-chip'
      const name = document.createElement('span')
      name.textContent = att.fileName.length > 16 ? att.fileName.slice(0, 14) + '…' : att.fileName
      const remove = document.createElement('button')
      remove.textContent = '×'
      remove.type = 'button'
      remove.addEventListener('click', () => {
        state.attachments.splice(index, 1)
        renderAttachments()
      })
      chip.appendChild(name)
      chip.appendChild(remove)
      el.preview.appendChild(chip)
    })
  }

  // ── 发送 ────────────────────────────────────────────────────────────────
  async function sendMessage() {
    const text = el.input.value.trim()
    if (!text && state.attachments.length === 0) return
    if (!state.token) { openSetup(''); return }

    const attachments = state.attachments.slice()
    const attachNames = attachments.map(a => a.fileName).join('、')
    const displayText = attachNames
      ? `${text}${text ? '\n' : ''}📎 ${attachNames}`
      : text
    appendMessage({
      role: 'user',
      text: displayText,
      ts: new Date().toISOString(),
    })
    el.input.value = ''
    state.attachments = []
    renderAttachments()
    autoGrow()
    showTyping()

    try {
      const res = await fetch(`${state.url}/api/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${state.token}`,
          'X-Device-Id': state.device,
        },
        body: JSON.stringify({ text, attachments }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
    } catch (err) {
      clearTyping()
      appendMessage({ role: 'system', text: `发送失败：${err.message}`, ts: new Date().toISOString() })
    }
  }

  el.send.addEventListener('click', sendMessage)

  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      sendMessage()
    }
  })

  el.input.addEventListener('input', autoGrow)

  function autoGrow() {
    el.input.style.height = 'auto'
    el.input.style.height = Math.min(el.input.scrollHeight, 132) + 'px'
  }

  // ── 启动 ────────────────────────────────────────────────────────────────
  initConfig()
  renderAll()
  if (!state.token) {
    setStatus('未配置', 'offline')
    openSetup('')
  } else {
    connect()
  }
})()
