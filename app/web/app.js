/* Jarvis App 管理台 —— 会话 / 工具 / 用量 / 设置 */
(function () {
  'use strict'

  const KEYS = {
    url: 'jarvis.app.url',
    token: 'jarvis.app.token',
    ownerToken: 'jarvis.app.ownerToken',
    device: 'jarvis.app.device',
  }
  const MAX_ATTACHMENTS = 3
  const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

  const $ = id => document.getElementById(id)

  const state = {
    url: '',
    token: '',
    ownerToken: '',
    device: 'app-test',
    clientId: '',
    ws: null,
    retry: 0,
    authFailed: false,
    attachments: [],
    messages: [],
    typingEl: null,
    typingTimer: null,
    tab: 'chat',
    tools: [],
    toolQuery: '',
    toolScope: 'all',
    toolDetail: null,
    expandedToolId: null,
    models: [],
    settings: null,
    me: null,
    usageMonth: currentMonth(),
    usageSummary: null,
    usageRecords: [],
    editingModelId: null,
  }

  const el = {
    dot: $('statusDot'),
    status: $('statusText'),
    testChip: $('testChip'),
    ownerChip: $('ownerChip'),
    views: {
      chat: $('view-chat'),
      tools: $('view-tools'),
      usage: $('view-usage'),
      settings: $('view-settings'),
    },
    navButtons: Array.from(document.querySelectorAll('.nav-btn')),
    messages: $('messages'),
    input: $('input'),
    send: $('sendBtn'),
    attach: $('attachBtn'),
    fileInput: $('fileInput'),
    attachPreview: $('attachPreview'),
    toolCount: $('toolCount'),
    toolSearch: $('toolSearch'),
    toolScope: $('toolScope'),
    toolList: $('toolList'),
    usageMonth: $('usageMonth'),
    usageCards: $('usageCards'),
    usageChart: $('usageChart'),
    usageRecords: $('usageRecords'),
    settingsStatus: $('settingsStatus'),
    settingsUrl: $('settingsUrl'),
    settingsDevice: $('settingsDevice'),
    settingsToken: $('settingsToken'),
    settingsOwnerToken: $('settingsOwnerToken'),
    editConnection: $('editConnection'),
    reconnectBtn: $('reconnectBtn'),
    addModel: $('addModel'),
    modelList: $('modelList'),
    deviceList: $('deviceList'),
    testModeToggle: $('testModeToggle'),
    setup: $('setup'),
    setupUrl: $('setupUrl'),
    setupToken: $('setupToken'),
    setupOwnerToken: $('setupOwnerToken'),
    setupDevice: $('setupDevice'),
    setupSave: $('setupSave'),
    setupError: $('setupError'),
    modelModal: $('modelModal'),
    modelModalTitle: $('modelModalTitle'),
    modelCancel: $('modelCancel'),
    modelCapability: $('modelCapability'),
    modelChatBox: $('modelChatBox'),
    modelConfigText: $('modelConfigText'),
    modelFields: $('modelFields'),
    modelName: $('modelName'),
    modelProvider: $('modelProvider'),
    modelBaseUrl: $('modelBaseUrl'),
    modelId: $('modelId'),
    modelApiKey: $('modelApiKey'),
    modelEnabled: $('modelEnabled'),
    modelHint: $('modelHint'),
    modelTestResult: $('modelTestResult'),
    modelTest: $('modelTest'),
    modelSave: $('modelSave'),
    toolModal: $('toolModal'),
    toolModalTitle: $('toolModalTitle'),
    toolCancel: $('toolCancel'),
    toolModalBody: $('toolModalBody'),
    toolSave: $('toolSave'),
  }

  // ── utilities ───────────────────────────────────────────────────────────

  function currentMonth() {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  }

  function read(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
  }
  function write(key, value) {
    try { localStorage.setItem(key, value) } catch {}
  }
  function remove(key) {
    try { localStorage.removeItem(key) } catch {}
  }
  function mask(value) {
    if (!value) return '未配置'
    if (value.length <= 8) return '已配置'
    return `${value.slice(0, 4)}****${value.slice(-4)}`
  }
  function absUrl(url) {
    if (!url) return ''
    if (/^https?:\/\//i.test(url)) return url
    if (url.startsWith('/')) return state.url + url
    return `${state.url}/${url}`
  }
  function formatTime(ts) {
    if (!ts) return ''
    try {
      return new Date(ts).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    } catch { return '' }
  }
  function setStatus(text, mode) {
    el.status.textContent = text
    el.dot.className = 'dot' + (mode ? ' ' + mode : '')
    if (el.settingsStatus) el.settingsStatus.textContent = text
  }
  function setOwnerChip(owner) {
    el.ownerChip.classList.toggle('hidden', !owner)
  }
  function toast(text) {
    appendMessage({ role: 'system', text, ts: new Date().toISOString() })
  }

  // ── config / setup ──────────────────────────────────────────────────────

  function initConfig() {
    const params = new URLSearchParams(location.search)
    const qToken = params.get('token')
    const qOwner = params.get('ownerToken')
    const qDevice = params.get('device')
    if (qToken) write(KEYS.token, qToken)
    if (qOwner) write(KEYS.ownerToken, qOwner)
    if (qDevice) write(KEYS.device, qDevice)
    if (qToken || qOwner || qDevice) {
      try { history.replaceState(null, '', location.pathname) } catch {}
    }
    state.url = (read(KEYS.url, '') || location.origin).replace(/\/+$/, '')
    state.token = read(KEYS.token, '')
    state.ownerToken = read(KEYS.ownerToken, '')
    state.device = read(KEYS.device, 'app-test') || 'app-test'
    write(KEYS.url, state.url)
  }

  function openSetup(error) {
    el.setupUrl.value = state.url || location.origin
    el.setupToken.value = state.token || ''
    el.setupOwnerToken.value = state.ownerToken || ''
    el.setupDevice.value = state.device || 'app-test'
    el.setupError.textContent = error || ''
    el.setup.classList.remove('hidden')
    setTimeout(() => el.setupToken.focus(), 50)
  }
  function closeSetup() { el.setup.classList.add('hidden') }

  el.setupSave.addEventListener('click', () => {
    const url = (el.setupUrl.value || '').trim().replace(/\/+$/, '')
    const token = (el.setupToken.value || '').trim()
    const ownerToken = (el.setupOwnerToken.value || '').trim()
    const device = (el.setupDevice.value || 'app-test').trim()
    if (!/^https?:\/\//i.test(url)) { el.setupError.textContent = '地址要以 http:// 或 https:// 开头'; return }
    if (!token) { el.setupError.textContent = '请填写访问令牌'; return }
    state.url = url
    state.token = token
    state.ownerToken = ownerToken
    state.device = device || 'app-test'
    state.clientId = ''
    state.authFailed = false
    write(KEYS.url, state.url)
    write(KEYS.token, state.token)
    write(KEYS.ownerToken, state.ownerToken)
    write(KEYS.device, state.device)
    closeSetup()
    renderConnection()
    connect()
    loadMe()
    loadSession()
    showTab('chat')
  })

  el.editConnection.addEventListener('click', () => openSetup(''))
  el.reconnectBtn.addEventListener('click', reconnect)

  // ── API ─────────────────────────────────────────────────────────────────

  async function api(path, opts = {}) {
    if (!state.token) throw new Error('未配置访问令牌')
    const headers = {
      'Authorization': `Bearer ${state.token}`,
      'X-Device-Id': state.device,
      ...(opts.headers || {}),
    }
    if (state.ownerToken) headers['X-Owner-Token'] = state.ownerToken
    if (state.clientId) headers['X-Client-Id'] = state.clientId
    let body = opts.body
    if (body !== undefined && !(body instanceof Blob) && !opts.raw) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(body)
    }
    const res = await fetch(state.url + path, { method: opts.method || 'GET', headers, body })
    if (res.status === 401) {
      state.authFailed = true
      setStatus('令牌无效', 'offline')
      openSetup('访问令牌不正确，请重新填写')
      throw new Error('unauthorized')
    }
    const text = await res.text()
    let data = {}
    try { data = JSON.parse(text) } catch {}
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
  }

  // ── WS ──────────────────────────────────────────────────────────────────

  function wsUrl() {
    const base = state.url.replace(/^http/i, 'ws')
    let url = `${base}/ws?token=${encodeURIComponent(state.token)}&device=${encodeURIComponent(state.device)}`
    if (state.ownerToken) url += `&ownerToken=${encodeURIComponent(state.ownerToken)}`
    return url
  }

  function connect() {
    if (!state.token) { setStatus('未配置', 'offline'); openSetup(''); return }
    if (state.authFailed) { setStatus('令牌无效', 'offline'); return }
    if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return
    setStatus('连接中…', '')
    let ws
    try { ws = new WebSocket(wsUrl()) } catch { setStatus('地址不合法', 'offline'); return }
    state.ws = ws
    ws.onopen = () => {
      state.retry = 0
      setStatus('在线', 'online')
    }
    ws.onmessage = event => {
      let msg
      try { msg = JSON.parse(event.data) } catch { return }
      handleEvent(msg)
    }
    ws.onclose = event => {
      state.ws = null
      state.clientId = ''
      if (event && event.code === 4401) {
        state.authFailed = true
        setStatus('令牌无效', 'offline')
        openSetup('访问令牌不正确，请重新填写')
        return
      }
      setStatus('已断开', 'offline')
      scheduleReconnect()
    }
    ws.onerror = () => setStatus('连接失败', 'offline')
  }

  function reconnect() {
    state.authFailed = false
    if (state.ws) { try { state.ws.close() } catch {} state.ws = null }
    state.clientId = ''
    setStatus('连接中…', '')
    connect()
  }

  function scheduleReconnect() {
    if (!state.token || state.authFailed) return
    state.retry = Math.min(state.retry + 1, 6)
    const delay = Math.min(1000 * Math.pow(1.6, state.retry), 15000)
    setTimeout(() => { if (!state.ws) connect() }, delay)
  }

  setInterval(() => {
    if (state.ws && state.ws.readyState === 1) {
      try { state.ws.send(JSON.stringify({ type: 'ping' })) } catch {}
    } else if (!state.ws && state.token && !state.authFailed) {
      connect()
    }
  }, 25000)

  function handleEvent(msg) {
    if (!msg || !msg.type) return
    if (msg.type === 'hello') {
      state.clientId = msg.clientId || ''
      setOwnerChip(!!msg.owner)
      return
    }
    if (msg.type === 'assistant' && msg.text) {
      clearTyping()
      appendMessage({ role: 'bot', text: msg.text, ts: msg.timestamp || new Date().toISOString() })
      return
    }
    if (msg.type === 'file') {
      clearTyping()
      appendMessage({
        role: 'bot',
        file: {
          name: msg.fileName,
          url: msg.url,
          kind: msg.kind || (msg.isImage ? 'image' : 'file'),
          isImage: !!msg.isImage,
        },
        ts: msg.timestamp || new Date().toISOString(),
      })
      return
    }
    if (msg.type === 'notice' && msg.text) {
      appendMessage({ role: 'system', text: msg.text, ts: new Date().toISOString() })
      return
    }
    if (msg.type === 'error' && msg.text) {
      clearTyping()
      appendMessage({ role: 'system', text: msg.text, ts: new Date().toISOString() })
    }
  }

  // ── tabs ────────────────────────────────────────────────────────────────

  function showTab(name) {
    if (!el.views[name]) return
    state.tab = name
    for (const key of Object.keys(el.views)) {
      el.views[key].classList.toggle('hidden', key !== name)
    }
    for (const btn of el.navButtons) {
      btn.classList.toggle('active', btn.dataset.tab === name)
    }
    if (name === 'chat') scrollToBottom()
    if (name === 'tools') loadTools()
    if (name === 'usage') loadUsage()
    if (name === 'settings') loadSettings()
  }

  for (const btn of el.navButtons) {
    btn.addEventListener('click', () => showTab(btn.dataset.tab))
  }

  // ── chat ────────────────────────────────────────────────────────────────

  function renderMessages(items) {
    el.messages.textContent = ''
    if (!items.length) {
      const empty = document.createElement('div')
      empty.className = 'empty-state'
      empty.textContent = '和 Jarvis 说点什么喵～'
      el.messages.appendChild(empty)
      return
    }
    for (const item of items) {
      el.messages.appendChild(buildMessageEl(item))
    }
    scrollToBottom()
  }

  function buildMessageEl(item) {
    const div = document.createElement('div')
    div.className = 'msg ' + (item.role === 'user' ? 'user' : item.role === 'system' ? 'system' : 'bot')

    if (item.text) {
      div.appendChild(document.createTextNode(item.text))
    }

    if (item.attachments) {
      for (const att of item.attachments) {
        div.appendChild(buildAttachmentEl(att))
      }
    }

    if (item.file) {
      div.appendChild(buildFileEl(item.file))
    }

    if (item.role !== 'system') {
      const meta = document.createElement('span')
      meta.className = 'meta'
      meta.textContent = formatTime(item.ts)
      div.appendChild(meta)
    }
    return div
  }

  function buildAttachmentEl(att) {
    const url = absUrl(att.url)
    const kind = att.kind || (String(att.mime || '').startsWith('image/') ? 'image' : 'file')
    return buildMediaEl({ name: att.fileName || att.name, url, kind, size: att.size })
  }

  function buildFileEl(file) {
    return buildMediaEl({
      name: file.name,
      url: absUrl(file.url),
      kind: file.kind || (file.isImage ? 'image' : 'file'),
    })
  }

  function buildMediaEl({ name, url, kind, size }) {
    const wrap = document.createElement('div')
    if (kind === 'image') {
      const img = document.createElement('img')
      img.className = 'media'
      img.src = url
      img.alt = name || '图片'
      wrap.appendChild(img)
      return wrap
    }
    if (kind === 'video') {
      const video = document.createElement('video')
      video.className = 'media'
      video.src = url
      video.controls = true
      wrap.appendChild(video)
      return wrap
    }
    if (kind === 'audio') {
      const audio = document.createElement('audio')
      audio.className = 'media'
      audio.src = url
      audio.controls = true
      wrap.appendChild(audio)
      return wrap
    }
    const card = document.createElement('div')
    card.className = 'file-card'
    const link = document.createElement('a')
    link.href = url
    link.target = '_blank'
    link.rel = 'noopener'
    link.textContent = name || '文件'
    card.appendChild(link)
    if (size) {
      const sizeEl = document.createElement('span')
      sizeEl.className = 'file-size'
      sizeEl.textContent = formatSize(size)
      card.appendChild(sizeEl)
    }
    wrap.appendChild(card)
    return wrap
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(1)} MB`
  }

  function appendMessage(item) {
    state.messages.push(item)
    if (el.messages.querySelector('.empty-state')) el.messages.textContent = ''
    el.messages.appendChild(buildMessageEl(item))
    scrollToBottom()
  }

  function scrollToBottom() {
    requestAnimationFrame(() => { el.messages.scrollTop = el.messages.scrollHeight })
  }

  function showTyping() {
    if (state.typingEl) return
    const div = document.createElement('div')
    div.className = 'typing'
    for (let i = 0; i < 3; i++) div.appendChild(document.createElement('i'))
    state.typingEl = div
    el.messages.appendChild(div)
    scrollToBottom()
    clearTimeout(state.typingTimer)
    state.typingTimer = setTimeout(clearTyping, 120000)
  }
  function clearTyping() {
    clearTimeout(state.typingTimer)
    state.typingTimer = null
    if (state.typingEl) { state.typingEl.remove(); state.typingEl = null }
  }

  async function loadSession() {
    if (!state.token) return
    try {
      const data = await api('/api/v1/session/current')
      state.messages = Array.isArray(data.messages) ? data.messages : []
      renderMessages(state.messages)
      setOwnerChip(!!data.owner)
    } catch (err) {
      try {
        const data = await api('/api/history')
        state.messages = Array.isArray(data.messages) ? data.messages : []
        renderMessages(state.messages)
      } catch {
        renderMessages([])
        appendMessage({ role: 'system', text: `会话加载失败：${err.message}`, ts: new Date().toISOString() })
      }
    }
  }

  async function loadMe() {
    if (!state.token) return
    try {
      const data = await api('/api/v1/me')
      state.me = data
      setOwnerChip(!!data.owner)
      el.testChip.textContent = data.testMode ? '测试' : 'App'
    } catch {}
  }

  // attachments
  el.attach.addEventListener('click', () => el.fileInput.click())

  el.fileInput.addEventListener('change', async () => {
    const files = Array.from(el.fileInput.files || [])
    el.fileInput.value = ''
    for (const file of files) {
      if (state.attachments.length >= MAX_ATTACHMENTS) { toast(`最多 ${MAX_ATTACHMENTS} 个附件`); break }
      if (file.size > MAX_ATTACHMENT_BYTES) { toast(`「${file.name}」超过 20MB，已跳过`); continue }
      try {
        const uploaded = await uploadFile(file)
        state.attachments.push(uploaded)
        renderAttachments()
      } catch (err) {
        toast(`「${file.name}」上传失败：${err.message}`)
      }
    }
  })

  async function uploadFile(file) {
    const headers = {
      'Authorization': `Bearer ${state.token}`,
      'X-Device-Id': state.device,
      'X-File-Name': encodeURIComponent(file.name),
      'Content-Type': file.type || 'application/octet-stream',
    }
    if (state.ownerToken) headers['X-Owner-Token'] = state.ownerToken
    if (state.clientId) headers['X-Client-Id'] = state.clientId
    const res = await fetch(`${state.url}/api/v1/upload`, { method: 'POST', headers, body: file })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `HTTP ${res.status}`)
    }
    const data = await res.json()
    return {
      id: data.id,
      fileName: data.fileName,
      mime: data.mime,
      size: data.size,
      url: data.url,
      kind: String(data.mime || file.type || '').startsWith('image/')
        ? 'image'
        : (String(data.mime || file.type || '').startsWith('video/') ? 'video'
          : (String(data.mime || file.type || '').startsWith('audio/') ? 'audio' : 'file')),
    }
  }

  function renderAttachments() {
    el.attachPreview.textContent = ''
    state.attachments.forEach((att, index) => {
      const chip = document.createElement('span')
      chip.className = 'attach-chip'
      const name = document.createElement('span')
      name.textContent = att.fileName.length > 14 ? att.fileName.slice(0, 12) + '…' : att.fileName
      const removeBtn = document.createElement('button')
      removeBtn.type = 'button'
      removeBtn.textContent = '×'
      removeBtn.addEventListener('click', () => {
        state.attachments.splice(index, 1)
        renderAttachments()
      })
      chip.appendChild(name)
      chip.appendChild(removeBtn)
      el.attachPreview.appendChild(chip)
    })
  }

  async function sendMessage() {
    const text = el.input.value.trim()
    const attachments = state.attachments.slice()
    if (!text && !attachments.length) return
    if (!state.token) { openSetup(''); return }
    appendMessage({
      role: 'user',
      text,
      attachments: attachments.map(a => ({ ...a, url: absUrl(a.url) })),
      ts: new Date().toISOString(),
    })
    el.input.value = ''
    state.attachments = []
    renderAttachments()
    autoGrow()
    showTyping()
    try {
      await api('/api/v1/session/message', {
        method: 'POST',
        body: { text, attachmentIds: attachments.map(a => a.id) },
      })
    } catch (err) {
      clearTyping()
      appendMessage({ role: 'system', text: `发送失败：${err.message}`, ts: new Date().toISOString() })
    }
  }

  el.send.addEventListener('click', sendMessage)
  el.input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      sendMessage()
    }
  })
  el.input.addEventListener('input', autoGrow)

  function autoGrow() {
    el.input.style.height = 'auto'
    el.input.style.height = Math.min(el.input.scrollHeight, 132) + 'px'
  }

  // ── tools ───────────────────────────────────────────────────────────────

  let toolSearchTimer = null
  el.toolSearch.addEventListener('input', () => {
    clearTimeout(toolSearchTimer)
    toolSearchTimer = setTimeout(() => {
      state.toolQuery = el.toolSearch.value.trim()
      loadTools()
    }, 220)
  })
  el.toolScope.addEventListener('click', event => {
    const btn = event.target.closest('button[data-scope]')
    if (!btn) return
    state.toolScope = btn.dataset.scope
    for (const b of el.toolScope.querySelectorAll('button')) b.classList.toggle('active', b === btn)
    renderTools()
  })

  async function loadTools() {
    if (!state.token) return
    try {
      const data = await api(`/api/v1/tools?q=${encodeURIComponent(state.toolQuery)}`)
      state.tools = Array.isArray(data.tools) ? data.tools : []
      renderTools()
    } catch (err) {
      el.toolList.textContent = ''
      const empty = document.createElement('div')
      empty.className = 'empty-state'
      empty.textContent = `工具加载失败：${err.message}`
      el.toolList.appendChild(empty)
      el.toolCount.textContent = '—'
    }
  }

  function renderTools() {
    const tools = state.tools.filter(tool => {
      if (state.toolScope === 'my') return tool.source === 'user' || tool.enabled
      return true
    })
    if (state.expandedToolId && !tools.some(tool => tool.id === state.expandedToolId)) {
      state.expandedToolId = null
      state.toolDetail = null
    }
    el.toolCount.textContent = `${tools.length} 个`
    el.toolList.textContent = ''
    if (!tools.length) {
      const empty = document.createElement('div')
      empty.className = 'empty-state'
      empty.textContent = state.toolQuery ? '没有匹配的工具' : '还没有工具'
      el.toolList.appendChild(empty)
      return
    }
    for (const tool of tools) el.toolList.appendChild(buildToolItem(tool))
  }

  function buildToolItem(tool) {
    const item = document.createElement('div')
    item.className = 'tool-item'
      + (state.expandedToolId === tool.id ? ' expanded' : '')
      + (tool.enabled ? '' : ' disabled')

    const row = document.createElement('div')
    row.className = 'tool-row'
    row.addEventListener('click', () => toggleToolExpand(tool.id))

    const icon = document.createElement('div')
    icon.className = 'tool-icon'
    icon.textContent = tool.icon || '🧰'
    row.appendChild(icon)

    const info = document.createElement('div')
    info.className = 'tool-info'
    const nameLine = document.createElement('div')
    nameLine.className = 'tool-name-line'
    const name = document.createElement('span')
    name.className = 'tool-name'
    name.textContent = tool.name || tool.id
    nameLine.appendChild(name)
    info.appendChild(nameLine)

    const desc = document.createElement('div')
    desc.className = 'tool-desc tool-desc-collapsed'
    desc.textContent = tool.description || '无描述'
    info.appendChild(desc)

    const meta = document.createElement('div')
    meta.className = 'tool-meta'
    meta.appendChild(badge(sourceLabel(tool.source), tool.source))
    if (tool.risk === 'high' || tool.risk === 'medium') meta.appendChild(badge(tool.risk === 'high' ? '高风险' : '中风险', tool.risk))
    if (!tool.available) meta.appendChild(badge('待接入', 'off'))
    if (!tool.enabled) meta.appendChild(badge('已停用', 'off'))
    info.appendChild(meta)
    row.appendChild(info)

    const toggle = document.createElement('button')
    toggle.className = 'tool-toggle' + (tool.enabled ? ' on' : '')
    toggle.title = tool.enabled ? '停用' : '启用'
    toggle.addEventListener('click', async event => {
      event.stopPropagation()
      try {
        await api(`/api/v1/tools/${encodeURIComponent(tool.id)}`, {
          method: 'PUT',
          body: { enabled: !tool.enabled },
        })
        tool.enabled = !tool.enabled
        if (state.toolDetail?.id === tool.id) state.toolDetail.enabled = tool.enabled
        renderTools()
      } catch (err) {
        toast(`操作失败：${err.message}`)
      }
    })
    row.appendChild(toggle)

    const chevron = document.createElement('span')
    chevron.className = 'tool-chevron'
    chevron.textContent = '⌄'
    row.appendChild(chevron)
    item.appendChild(row)

    if (state.expandedToolId === tool.id) {
      const panel = document.createElement('div')
      panel.className = 'tool-expanded'
      panel.addEventListener('click', event => event.stopPropagation())
      if (!state.toolDetail || state.toolDetail.id !== tool.id) {
        panel.textContent = '加载配置…'
      } else {
        renderToolExpanded(panel, state.toolDetail)
      }
      item.appendChild(panel)
    }
    return item
  }

  async function toggleToolExpand(id) {
    if (state.expandedToolId === id) {
      state.expandedToolId = null
      state.toolDetail = null
      renderTools()
      return
    }
    state.expandedToolId = id
    state.toolDetail = null
    renderTools()
    try {
      const data = await api(`/api/v1/tools/${encodeURIComponent(id)}`)
      if (state.expandedToolId !== id) return
      state.toolDetail = data.tool
      renderTools()
    } catch (err) {
      toast(`工具详情加载失败：${err.message}`)
      state.expandedToolId = null
      state.toolDetail = null
      renderTools()
    }
  }

  function renderToolExpanded(panel, tool) {
    const desc = document.createElement('p')
    desc.className = 'tool-detail-desc'
    desc.textContent = tool.description || '无描述'
    panel.appendChild(desc)

    if (!tool.available) {
      const note = document.createElement('div')
      note.className = 'tool-unavailable'
      note.textContent = '这个工具还处于待接入阶段；可以先保存配置，等原生/外部 SDK 接入后使用。'
      panel.appendChild(note)
    }

    const enabledLabel = document.createElement('label')
    enabledLabel.className = 'check-row'
    const enabled = document.createElement('input')
    enabled.type = 'checkbox'
    enabled.id = `toolEnabled_${tool.id}`
    enabled.checked = !!tool.enabled
    enabledLabel.appendChild(enabled)
    const enabledText = document.createElement('span')
    enabledText.textContent = '启用此工具'
    enabledLabel.appendChild(enabledText)
    panel.appendChild(enabledLabel)

    const fields = Array.isArray(tool.configFields) ? tool.configFields : []
    if (fields.length) {
      for (const field of fields) {
        const wrap = document.createElement('div')
        wrap.className = 'tool-config-field'
        const label = document.createElement('label')
        label.textContent = field.label || field.key
        const input = document.createElement('input')
        input.id = `toolCfg_${tool.id}_${field.key}`
        input.type = field.secret ? 'password' : 'text'
        input.value = field.secret ? '' : (tool.config?.[field.key] || '')
        input.placeholder = field.secret
          ? (tool.hasSecrets?.[field.key] ? '已配置，留空保持不变' : (field.placeholder || '填写密钥'))
          : (field.placeholder || '')
        label.appendChild(input)
        wrap.appendChild(label)
        panel.appendChild(wrap)
      }
    } else {
      const hint = document.createElement('p')
      hint.className = 'hint'
      hint.textContent = '这个工具没有需要配置的字段。'
      panel.appendChild(hint)
    }

    const actions = document.createElement('div')
    actions.className = 'tool-expanded-actions'
    const save = document.createElement('button')
    save.className = 'primary-btn'
    save.textContent = '保存配置'
    save.addEventListener('click', async event => {
      event.stopPropagation()
      const config = {}
      const secrets = {}
      for (const field of (tool.configFields || [])) {
        const input = $(`toolCfg_${tool.id}_${field.key}`)
        if (!input) continue
        if (field.secret) {
          if (input.value) secrets[field.key] = input.value
        } else {
          config[field.key] = input.value
        }
      }
      const enabledEl = $(`toolEnabled_${tool.id}`)
      try {
        await api(`/api/v1/tools/${encodeURIComponent(tool.id)}`, {
          method: 'PUT',
          body: { enabled: !!enabledEl?.checked, config, secrets },
        })
        toast(`「${tool.name || tool.id}」配置已保存`)
        state.expandedToolId = null
        state.toolDetail = null
        await loadTools()
      } catch (err) {
        toast(`保存失败：${err.message}`)
      }
    })
    actions.appendChild(save)
    panel.appendChild(actions)
  }

  function sourceLabel(source) {
    return ({ system: '系统', user: '我的', external: '外部', native: '原生' })[source] || source || '工具'
  }
  function badge(text, cls) {
    const span = document.createElement('span')
    span.className = 'badge' + (cls ? ' ' + cls : '')
    span.textContent = text
    return span
  }

  async function openTool(id) {
    try {
      const data = await api(`/api/v1/tools/${encodeURIComponent(id)}`)
      state.toolDetail = data.tool
      renderToolModal(data.tool)
      el.toolModal.classList.remove('hidden')
    } catch (err) {
      toast(`工具详情加载失败：${err.message}`)
    }
  }

  function renderToolModal(tool) {
    el.toolModalTitle.textContent = tool.name || tool.id
    el.toolModalBody.textContent = ''

    const head = document.createElement('div')
    head.className = 'tool-detail-head'
    const icon = document.createElement('div')
    icon.className = 'tool-detail-icon'
    icon.textContent = tool.icon || '🧰'
    head.appendChild(icon)
    const headInfo = document.createElement('div')
    const title = document.createElement('div')
    title.className = 'tool-name'
    title.textContent = tool.name || tool.id
    headInfo.appendChild(title)
    const meta = document.createElement('div')
    meta.className = 'tool-meta'
    meta.appendChild(badge(sourceLabel(tool.source), tool.source))
    if (tool.risk) meta.appendChild(badge(tool.risk === 'high' ? '高风险' : (tool.risk === 'medium' ? '中风险' : '低风险'), tool.risk))
    if (!tool.available) meta.appendChild(badge('待接入', 'off'))
    headInfo.appendChild(meta)
    head.appendChild(headInfo)
    el.toolModalBody.appendChild(head)

    const desc = document.createElement('p')
    desc.className = 'tool-detail-desc'
    desc.textContent = tool.description || '无描述'
    el.toolModalBody.appendChild(desc)

    if (!tool.available) {
      const note = document.createElement('div')
      note.className = 'tool-unavailable'
      note.textContent = '这个工具还处于待接入阶段；可以先保存配置，等原生/外部 SDK 接入后使用。'
      el.toolModalBody.appendChild(note)
    }

    const enabledLabel = document.createElement('label')
    enabledLabel.className = 'check-row'
    const enabled = document.createElement('input')
    enabled.type = 'checkbox'
    enabled.id = 'toolEnabled'
    enabled.checked = !!tool.enabled
    enabledLabel.appendChild(enabled)
    const enabledText = document.createElement('span')
    enabledText.textContent = '启用此工具'
    enabledLabel.appendChild(enabledText)
    el.toolModalBody.appendChild(enabledLabel)

    const fields = Array.isArray(tool.configFields) ? tool.configFields : []
    if (fields.length) {
      for (const field of fields) {
        const wrap = document.createElement('div')
        wrap.className = 'tool-config-field'
        const label = document.createElement('label')
        label.textContent = field.label || field.key
        const input = document.createElement('input')
        input.id = `toolCfg_${field.key}`
        input.type = field.secret ? 'password' : 'text'
        input.value = field.secret ? '' : (tool.config?.[field.key] || '')
        input.placeholder = field.secret
          ? (tool.hasSecrets?.[field.key] ? '已配置，留空保持不变' : (field.placeholder || '填写密钥'))
          : (field.placeholder || '')
        label.appendChild(input)
        wrap.appendChild(label)
        el.toolModalBody.appendChild(wrap)
      }
    } else {
      const hint = document.createElement('p')
      hint.className = 'hint'
      hint.textContent = '这个工具没有需要配置的字段。'
      el.toolModalBody.appendChild(hint)
    }
  }

  el.toolCancel.addEventListener('click', () => el.toolModal.classList.add('hidden'))
  el.toolSave.addEventListener('click', async () => {
    const tool = state.toolDetail
    if (!tool) return
    const config = {}
    const secrets = {}
    for (const field of (tool.configFields || [])) {
      const input = $(`toolCfg_${field.key}`)
      if (!input) continue
      if (field.secret) {
        if (input.value) secrets[field.key] = input.value
      } else {
        config[field.key] = input.value
      }
    }
    const enabledEl = $('toolEnabled')
    try {
      await api(`/api/v1/tools/${encodeURIComponent(tool.id)}`, {
        method: 'PUT',
        body: { enabled: !!enabledEl?.checked, config, secrets },
      })
      el.toolModal.classList.add('hidden')
      await loadTools()
    } catch (err) {
      toast(`保存失败：${err.message}`)
    }
  })

  // ── usage ───────────────────────────────────────────────────────────────

  el.usageMonth.value = state.usageMonth
  el.usageMonth.addEventListener('change', () => {
    state.usageMonth = el.usageMonth.value || currentMonth()
    loadUsage()
  })

  async function loadUsage() {
    if (!state.token) return
    try {
      const [summary, records] = await Promise.all([
        api(`/api/v1/usage/summary?month=${encodeURIComponent(state.usageMonth)}`),
        api(`/api/v1/usage/records?month=${encodeURIComponent(state.usageMonth)}&limit=80`),
      ])
      state.usageSummary = summary.summary
      state.usageRecords = Array.isArray(records.records) ? records.records : []
      renderUsage()
    } catch (err) {
      el.usageCards.textContent = ''
      el.usageChart.textContent = ''
      el.usageRecords.textContent = ''
      const empty = document.createElement('div')
      empty.className = 'empty-state'
      empty.textContent = `用量加载失败：${err.message}`
      el.usageRecords.appendChild(empty)
    }
  }

  function renderUsage() {
    const s = state.usageSummary || {}
    el.usageCards.textContent = ''
    const cards = [
      ['调用次数', String(s.calls || 0)],
      ['Token', String((s.inputTokens || 0) + (s.outputTokens || 0))],
      ['费用', `$${Number(s.cost || 0).toFixed(4)}`],
      ['平均延迟', `${s.avgLatencyMs || 0} ms`],
    ]
    for (const [label, value] of cards) {
      const card = document.createElement('div')
      card.className = 'stat-card'
      const l = document.createElement('div')
      l.className = 'stat-label'
      l.textContent = label
      const v = document.createElement('div')
      v.className = 'stat-value'
      v.textContent = value
      card.appendChild(l)
      card.appendChild(v)
      el.usageCards.appendChild(card)
    }

    const byModel = Object.entries(s.byModel || {})
      .sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0))
      .slice(0, 8)
    const max = Math.max(1, ...byModel.map(([, v]) => Number(v.cost) || 0))
    el.usageChart.textContent = ''
    if (!byModel.length) {
      const empty = document.createElement('div')
      empty.className = 'empty-state'
      empty.textContent = '本月还没有调用记录'
      el.usageChart.appendChild(empty)
    } else {
      for (const [name, v] of byModel) {
        const row = document.createElement('div')
        row.className = 'bar-row'
        const nameEl = document.createElement('div')
        nameEl.className = 'bar-name'
        nameEl.textContent = name
        const track = document.createElement('div')
        track.className = 'bar-track'
        const fill = document.createElement('div')
        fill.className = 'bar-fill'
        fill.style.width = `${Math.max(4, (Number(v.cost) || 0) / max * 100)}%`
        track.appendChild(fill)
        const value = document.createElement('div')
        value.className = 'bar-value'
        value.textContent = `${v.calls || 0} 次 · $${Number(v.cost || 0).toFixed(3)}`
        row.appendChild(nameEl)
        row.appendChild(track)
        row.appendChild(value)
        el.usageChart.appendChild(row)
      }
    }

    el.usageRecords.textContent = ''
    if (!state.usageRecords.length) {
      const empty = document.createElement('div')
      empty.className = 'empty-state'
      empty.textContent = '还没有调用记录'
      el.usageRecords.appendChild(empty)
      return
    }
    for (const record of state.usageRecords) {
      const item = document.createElement('div')
      item.className = 'record-item'
      const main = document.createElement('div')
      main.className = 'record-main'
      const title = document.createElement('div')
      title.className = 'record-title'
      title.textContent = record.model || record.capability || '调用'
      const sub = document.createElement('div')
      sub.className = 'record-sub'
      sub.textContent = `${formatTime(record.ts)} · ${record.inputTokens || 0}+${record.outputTokens || 0} tokens · ${record.latencyMs || 0}ms`
      main.appendChild(title)
      main.appendChild(sub)
      const right = document.createElement('div')
      right.className = 'record-right'
      const cost = document.createElement('div')
      cost.textContent = `$${Number(record.cost || 0).toFixed(4)}`
      const status = document.createElement('div')
      status.className = record.status === 'error' ? 'record-error' : 'record-ok'
      status.textContent = record.status === 'error' ? '失败' : '成功'
      right.appendChild(cost)
      right.appendChild(status)
      item.appendChild(main)
      item.appendChild(right)
      el.usageRecords.appendChild(item)
    }
  }

  // ── settings ────────────────────────────────────────────────────────────

  async function loadSettings() {
    if (!state.token) return
    renderConnection()
    try {
      const data = await api('/api/v1/settings')
      state.settings = data.settings
      state.models = Array.isArray(data.models) ? data.models : []
      renderModels()
      el.testModeToggle.checked = data.settings?.testMode !== false
      await loadDevices()
    } catch (err) {
      el.modelList.textContent = ''
      const empty = document.createElement('div')
      empty.className = 'empty-state'
      empty.textContent = `设置加载失败：${err.message}`
      el.modelList.appendChild(empty)
    }
  }

  function renderConnection() {
    if (!el.settingsStatus) return
    el.settingsStatus.textContent = el.status.textContent || '—'
    el.settingsUrl.textContent = state.url || '—'
    el.settingsDevice.textContent = state.device || '—'
    el.settingsToken.textContent = mask(state.token)
    el.settingsOwnerToken.textContent = mask(state.ownerToken)
  }

  function renderModels() {
    el.modelList.textContent = ''
    if (!state.models.length) {
      const empty = document.createElement('div')
      empty.className = 'empty-state'
      empty.textContent = '还没有用户模型配置；普通用户需要先配置自己的模型 API。点右上角添加。'
      el.modelList.appendChild(empty)
      return
    }
    for (const model of state.models) {
      const card = document.createElement('div')
      card.className = 'model-card'
      const main = document.createElement('div')
      main.className = 'model-main'
      const name = document.createElement('div')
      name.className = 'model-name'
      name.textContent = model.name || model.model || '未命名模型'
      const sub = document.createElement('div')
      sub.className = 'model-sub'
      sub.textContent = model.raw
        ? '原始 LLM 配置 · 已加密保存'
        : `${capabilityLabel(model.capability)} · ${model.provider || 'custom'} · ${model.model || '—'}`
      const key = document.createElement('div')
      key.className = 'model-sub ' + (model.hasKey ? 'key-ok' : 'key-missing')
      key.textContent = model.raw ? '配置已保存' : (model.hasKey ? 'API Key 已配置' : 'API Key 未配置')
      main.appendChild(name)
      main.appendChild(sub)
      main.appendChild(key)
      card.appendChild(main)

      const actions = document.createElement('div')
      actions.className = 'model-actions'
      const edit = document.createElement('button')
      edit.className = 'ghost-btn'
      edit.textContent = '编辑'
      edit.addEventListener('click', () => openModelModal(model))
      const del = document.createElement('button')
      del.className = 'ghost-btn danger-btn'
      del.textContent = '删除'
      del.addEventListener('click', () => deleteModel(model))
      actions.appendChild(edit)
      actions.appendChild(del)
      card.appendChild(actions)
      el.modelList.appendChild(card)
    }
  }

  function capabilityLabel(capability) {
    return ({ chat: '对话', image: '图片', video: '视频', voice: '语音', embedding: 'Embedding' })[capability] || capability
  }

  function firstValue(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && String(value).trim() !== '') return value
    }
    return ''
  }

  /** 兼容常见 LLM 配置文件：顶层字段、config/credentials/auth、env.ANTHROPIC_*。 */
  function extractLlmConfig(parsed) {
    const env = (parsed.env && typeof parsed.env === 'object') ? parsed.env : {}
    const sources = [parsed, parsed.config, parsed.credentials, parsed.auth, parsed.authentication]
      .filter(object => object && typeof object === 'object')
    const sourceValue = (keys) => {
      for (const source of sources) {
        for (const key of keys) {
          const value = source[key]
          if (value !== undefined && value !== null && String(value).trim() !== '') return value
        }
      }
      return ''
    }
    const apiKey = firstValue(
      sourceValue(['apiKey', 'api_key', 'key', 'token', 'authToken', 'accessToken']),
      env.ANTHROPIC_API_KEY,
      env.ANTHROPIC_AUTH_TOKEN,
      env.OPENAI_API_KEY,
      env.API_KEY,
      env.TOKEN,
    )
    const baseUrl = firstValue(
      sourceValue(['baseUrl', 'base_url', 'baseURL', 'endpoint', 'url']),
      env.ANTHROPIC_BASE_URL,
      env.OPENAI_BASE_URL,
      env.BASE_URL,
      env.API_BASE_URL,
    )
    const model = firstValue(
      sourceValue(['model', 'model_name', 'modelName']),
      parsed.model_name,
      parsed.modelName,
    )
    const name = firstValue(sourceValue(['name', 'title', 'displayName']), model)
    const provider = firstValue(
      sourceValue(['provider', 'type']),
      env.OPENAI_API_KEY ? 'openai' : 'anthropic',
    )
    const inferredAuthMode = (env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY)
      ? 'auth-token'
      : ((env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) ? 'api-key' : 'both')
    const authMode = firstValue(sourceValue(['authMode', 'auth_mode']), env.AUTH_MODE, inferredAuthMode)
    return {
      apiKey: String(apiKey || '').trim(),
      baseUrl: String(baseUrl || '').trim(),
      model: String(model || '').trim(),
      name: String(name || '').trim(),
      provider: String(provider || 'anthropic'),
      authMode: String(authMode || 'both'),
      params: (parsed.params && typeof parsed.params === 'object') ? parsed.params : {},
      enabled: parsed.enabled !== false,
      priority: Number(parsed.priority) || 0,
    }
  }

  function syncModelFields() {
    const chat = el.modelCapability.value === 'chat'
    el.modelChatBox.classList.toggle('hidden', !chat)
    el.modelFields.classList.toggle('hidden', chat)
    el.modelHint.textContent = chat
      ? '整段 JSON 加密保存；兼容 Claude Code settings（env.ANTHROPIC_* / model）。编辑时留空保持原配置。'
      : '图片/视频/语音模型先保存配置，实际 provider 适配在下一阶段。'
  }

  function openModelModal(model) {
    state.editingModelId = model?.id || null
    el.modelModalTitle.textContent = model ? '编辑模型' : '添加模型'
    el.modelCapability.value = model?.capability || 'chat'
    el.modelName.value = model?.name || ''
    el.modelProvider.value = model?.provider || 'anthropic'
    el.modelBaseUrl.value = model?.baseUrl || ''
    el.modelId.value = model?.model || ''
    el.modelApiKey.value = ''
    el.modelEnabled.checked = model ? model.enabled !== false : true
    el.modelTestResult.textContent = ''
    if (model?.raw) {
      el.modelConfigText.value = ''
      el.modelConfigText.placeholder = '已保存一份配置；留空保持不变，粘贴新的整段 JSON 会覆盖'
    } else if (!model || model.capability === 'chat') {
      const config = model
        ? {
            name: model.name || '',
            provider: model.provider || 'anthropic',
            baseUrl: model.baseUrl || '',
            model: model.model || '',
            apiKey: '',
            enabled: model.enabled !== false,
            authMode: model.authMode || 'both',
            priority: model.priority || 0,
            params: model.params || {},
          }
        : {
            name: '',
            provider: 'anthropic',
            baseUrl: '',
            model: '',
            apiKey: '',
            enabled: true,
          }
      el.modelConfigText.value = JSON.stringify(config, null, 2)
      el.modelConfigText.placeholder = '粘贴整段 LLM 配置 JSON'
    }
    syncModelFields()
    el.modelModal.classList.remove('hidden')
  }

  function closeModelModal() { el.modelModal.classList.add('hidden') }

  el.addModel.addEventListener('click', () => openModelModal(null))
  el.modelCancel.addEventListener('click', closeModelModal)
  el.modelCapability.addEventListener('change', syncModelFields)

  el.modelSave.addEventListener('click', async () => {
    const capability = el.modelCapability.value
    let body
    if (capability === 'chat') {
      const rawText = (el.modelConfigText.value || '').trim()
      const existing = state.models.find(m => m.id === state.editingModelId)
      if (!rawText) {
        if (!existing?.raw) {
          el.modelTestResult.textContent = '请粘贴整段 LLM 配置 JSON'
          return
        }
        // 编辑已有原始配置：留空只更新元数据，保留原配置
        body = { capability: 'chat', name: existing.name, enabled: existing.enabled }
      } else {
        let parsed
        try {
          parsed = JSON.parse(rawText)
        } catch {
          el.modelTestResult.textContent = 'JSON 格式错误，请检查逗号和引号'
          return
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          el.modelTestResult.textContent = '请粘贴一个 JSON 对象'
          return
        }
        body = {
          capability: 'chat',
          rawConfig: parsed,
          name: parsed.name || parsed.model || existing?.name || 'LLM 配置',
        }
      }
    } else {
      body = {
        capability,
        name: el.modelName.value.trim(),
        provider: el.modelProvider.value,
        baseUrl: el.modelBaseUrl.value.trim(),
        model: el.modelId.value.trim(),
        enabled: el.modelEnabled.checked,
      }
      if (el.modelApiKey.value) body.apiKey = el.modelApiKey.value
    }
    try {
      if (state.editingModelId) {
        await api(`/api/v1/settings/models/${encodeURIComponent(state.editingModelId)}`, { method: 'PUT', body })
      } else {
        await api('/api/v1/settings/models', { method: 'POST', body })
      }
      el.modelModal.classList.add('hidden')
      await loadSettings()
    } catch (err) {
      el.modelTestResult.textContent = `保存失败：${err.message}`
    }
  })

  el.modelTest.addEventListener('click', async () => {
    if (!state.editingModelId) {
      el.modelTestResult.textContent = '先保存模型，再测试连接'
      return
    }
    el.modelTestResult.textContent = '测试中…'
    try {
      const data = await api(`/api/v1/settings/models/${encodeURIComponent(state.editingModelId)}/test`, { method: 'POST' })
      el.modelTestResult.textContent = data.ok ? `连接成功（HTTP ${data.status || 200}）` : `连接失败：${data.error || '未知错误'}`
    } catch (err) {
      el.modelTestResult.textContent = `测试失败：${err.message}`
    }
  })

  async function deleteModel(model) {
    if (!confirm(`删除模型「${model.name || model.model}」？`)) return
    try {
      await api(`/api/v1/settings/models/${encodeURIComponent(model.id)}`, { method: 'DELETE' })
      await loadSettings()
    } catch (err) {
      toast(`删除失败：${err.message}`)
    }
  }

  async function loadDevices() {
    try {
      const data = await api('/api/v1/devices')
      el.deviceList.textContent = ''
      const devices = Array.isArray(data.devices) ? data.devices : []
      if (!devices.length) {
        const empty = document.createElement('div')
        empty.className = 'empty-state'
        empty.textContent = '还没有设备记录'
        el.deviceList.appendChild(empty)
        return
      }
      for (const device of devices) {
        const item = document.createElement('div')
        item.className = 'device-item'
        const name = document.createElement('span')
        const deviceName = device.name || device.deviceId || 'App'
        name.textContent = device.deviceId && deviceName !== device.deviceId
          ? `${deviceName} · ${device.deviceId}`
          : deviceName
        const last = document.createElement('span')
        last.textContent = formatTime(device.lastSeen)
        item.appendChild(name)
        item.appendChild(last)
        el.deviceList.appendChild(item)
      }
    } catch {}
  }

  el.testModeToggle.addEventListener('change', async () => {
    try {
      await api('/api/v1/settings', { method: 'PUT', body: { testMode: el.testModeToggle.checked } })
      el.testChip.textContent = el.testModeToggle.checked ? '测试' : 'App'
    } catch (err) {
      toast(`保存失败：${err.message}`)
    }
  })

  // ── boot ────────────────────────────────────────────────────────────────

  window.addEventListener('error', event => {
    const message = event?.message || '未知错误'
    const empty = document.querySelector('#messages .empty-state')
    if (empty) empty.textContent = `页面出错：${message}`
  })
  window.addEventListener('unhandledrejection', event => {
    console.error('unhandled rejection', event.reason)
  })

  initConfig()
  renderConnection()
  showTab('chat')
  if (!state.token) {
    setStatus('未配置', 'offline')
    openSetup('')
  } else {
    connect()
    loadMe()
    loadSession()
  }
})()
