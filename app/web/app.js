/* Jarvis App 管理台 —— 会话 / 工具 / 用量 / 设置 */
(function () {
  'use strict'

  const KEYS = {
    url: 'jarvis.app.url',
    token: 'jarvis.app.token',
    ownerToken: 'jarvis.app.ownerToken',
    device: 'jarvis.app.device',
    notify: 'jarvis.app.notify',
    outbox: 'jarvis.app.outbox',
    localFiles: 'jarvis.app.localFiles',
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
    sessionId: '',
    syncCursor: 0,
    oldestSeq: 0,
    hasMore: false,
    loadingOlder: false,
    unread: 0,
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
    updateInfo: null,
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
    chatUnread: $('chatUnread'),
    input: $('input'),
    send: $('sendBtn'),
    attach: $('attachBtn'),
    attachSheet: $('attachSheet'),
    attachBackdrop: $('attachBackdrop'),
    attachCancel: $('attachCancel'),
    attachItems: Array.from(document.querySelectorAll('.sheet-item')),
    fileInput: $('fileInput'),
    attachPreview: $('attachPreview'),
    imageViewer: $('imageViewer'),
    imageViewerImg: $('imageViewerImg'),
    imageViewerName: $('imageViewerName'),
    imageDownloadBtn: $('imageDownloadBtn'),
    imageCloseBtn: $('imageCloseBtn'),
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
    notifySection: $('notifySection'),
    notifyStatus: $('notifyStatus'),
    notifyToggle: $('notifyToggle'),
    notifyTestBtn: $('notifyTestBtn'),
    batteryStatus: $('batteryStatus'),
    openBatteryBtn: $('openBatteryBtn'),
    openStartupBtn: $('openStartupBtn'),
    openNotifySettingsBtn: $('openNotifySettingsBtn'),
    openAppSettingsBtn: $('openAppSettingsBtn'),
    testModeToggle: $('testModeToggle'),
    updateSection: $('updateSection'),
    updateStatus: $('updateStatus'),
    appVersion: $('appVersion'),
    checkUpdateBtn: $('checkUpdateBtn'),
    installUpdateBtn: $('installUpdateBtn'),
    installPermissionBtn: $('installPermissionBtn'),
    setup: $('setup'),
    setupUrl: $('setupUrl'),
    setupToken: $('setupToken'),
    setupOwnerToken: $('setupOwnerToken'),
    setupDevice: $('setupDevice'),
    setupSave: $('setupSave'),
    setupBack: $('setupBack'),
    setupError: $('setupError'),
    login: $('login'),
    loginUsername: $('loginUsername'),
    loginPassword: $('loginPassword'),
    loginError: $('loginError'),
    loginBtn: $('loginBtn'),
    registerBtn: $('registerBtn'),
    advancedSetup: $('advancedSetup'),
    settingsUsername: $('settingsUsername'),
    logoutBtn: $('logoutBtn'),
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
  /**
   * APK/文件在 WebView 里直接点击只会被当成页面加载。把裸 IP 换成 nip.io
   * 别名，让 Android 把它交给系统浏览器/下载器，而不是留在 WebView 里。
   */
  function browserSafeUrl(url) {
    const absolute = absUrl(url)
    try {
      const parsed = new URL(absolute)
      if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname)) {
        parsed.hostname = `${parsed.hostname}.nip.io`
      }
      return parsed.toString()
    } catch {
      return absolute
    }
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

  let viewerImage = null

  function openImageViewer(url, name) {
    if (!el.imageViewer || !el.imageViewerImg) return
    viewerImage = { url: absUrl(url), name: name || '图片' }
    el.imageViewerImg.src = viewerImage.url
    el.imageViewerName.textContent = viewerImage.name
    el.imageViewer.classList.remove('hidden')
    document.body.classList.add('viewer-open')
  }

  function closeImageViewer() {
    if (!el.imageViewer) return
    el.imageViewer.classList.add('hidden')
    el.imageViewerImg.removeAttribute('src')
    viewerImage = null
    document.body.classList.remove('viewer-open')
  }

  function downloadViewerImage() {
    if (!viewerImage) return
    const url = browserSafeUrl(viewerImage.url)
    const name = viewerImage.name || 'image.png'
    const bridge = notifyBridge()
    try {
      if (bridge && typeof bridge.downloadFile === 'function') {
        bridge.downloadFile(url, name)
        return
      }
      if (bridge && typeof bridge.openExternal === 'function') {
        bridge.openExternal(url)
        return
      }
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.target = '_blank'
      link.rel = 'noopener'
      link.click()
    } catch {}
  }

  function setUnread(count) {
    state.unread = Math.max(0, Number(count) || 0)
    if (!el.chatUnread) return
    if (state.unread > 0) {
      el.chatUnread.textContent = state.unread > 99 ? '99+' : String(state.unread)
      el.chatUnread.classList.remove('hidden')
    } else {
      el.chatUnread.textContent = ''
      el.chatUnread.classList.add('hidden')
    }
  }

  let readTimer = null
  function markReadSoon() {
    if (!state.token || state.tab !== 'chat' || document.visibilityState !== 'visible') return
    clearTimeout(readTimer)
    readTimer = setTimeout(async () => {
      try {
        const data = await api('/api/v1/read', { method: 'POST', body: {} })
        setUnread(data.unread || 0)
      } catch {}
    }, 220)
  }

  function readOutbox() {
    try {
      const value = JSON.parse(read(KEYS.outbox, '[]'))
      return Array.isArray(value) ? value : []
    } catch {
      return []
    }
  }

  function writeOutbox(items) {
    write(KEYS.outbox, JSON.stringify((items || []).slice(-50)))
  }

  function newClientMessageId() {
    try {
      if (window.crypto?.randomUUID) return window.crypto.randomUUID()
    } catch {}
    return `cim_${Date.now()}_${Math.random().toString(16).slice(2)}`
  }

  function readLocalFiles() {
    try {
      const value = JSON.parse(read(KEYS.localFiles, '[]'))
      return Array.isArray(value) ? value : []
    } catch {
      return []
    }
  }

  function rememberLocalFile(file) {
    if (!file || !state.sessionId) return
    const item = { ...file, sessionId: state.sessionId }
    const items = readLocalFiles().filter(existing =>
      !(existing.url === item.url && existing.ts === item.ts))
    items.push(item)
    write(KEYS.localFiles, JSON.stringify(items.slice(-30)))
  }

  function queueOutgoing(item) {
    const items = readOutbox()
    items.push({ ...item, clientMessageId: item.clientMessageId || newClientMessageId() })
    writeOutbox(items)
  }

  let sessionRefreshTimer = null
  function refreshCurrentSessionSoon() {
    if (!state.token) return
    clearTimeout(sessionRefreshTimer)
    sessionRefreshTimer = setTimeout(() => { loadSession().catch(() => {}) }, 180)
  }

  async function flushOutbox() {
    if (!state.token) return
    const items = readOutbox()
    if (!items.length) return
    const remaining = []
    for (const item of items) {
      try {
        await api('/api/v1/session/message', {
          method: 'POST',
          body: {
            text: item.text || '',
            attachmentIds: item.attachmentIds || [],
            clientMessageId: item.clientMessageId,
          },
        })
      } catch {
        remaining.push(item)
      }
    }
    writeOutbox(remaining)
    if (remaining.length < items.length) refreshCurrentSessionSoon()
  }

  // ── native notifications ────────────────────────────────────────────────

  function notifyBridge() {
    return (typeof window !== 'undefined' && window.JarvisNative) || null
  }

  function notifyPreferred() {
    return read(KEYS.notify, '1') !== '0'
  }

  function syncNativeNotify() {
    const bridge = notifyBridge()
    if (!bridge || !state.url || !state.token) return
    try {
      bridge.configure(state.url, state.token, state.device, notifyPreferred())
    } catch {}
  }

  function syncChatVisible() {
    const bridge = notifyBridge()
    if (!bridge) return
    try {
      bridge.setChatVisible(document.visibilityState === 'visible' && document.hasFocus() && state.tab === 'chat')
    } catch {}
  }

  function nativePageReady() {
    try {
      const bridge = notifyBridge()
      if (bridge && typeof bridge.pageReady === 'function') bridge.pageReady()
    } catch {}
  }

  function versionParts(value) {
    return String(value || '').split(/[^0-9]+/).filter(Boolean).map(Number)
  }

  function versionNewer(candidate, current) {
    const a = versionParts(candidate)
    const b = versionParts(current)
    const length = Math.max(a.length, b.length)
    for (let i = 0; i < length; i++) {
      const left = a[i] || 0
      const right = b[i] || 0
      if (left > right) return true
      if (left < right) return false
    }
    return false
  }

  function refreshUpdateSection() {
    const bridge = notifyBridge()
    if (el.updateSection) el.updateSection.classList.toggle('hidden', !bridge)
    if (!bridge) return
    let current = ''
    try { current = bridge.getVersionName?.() || '' } catch {}
    if (el.appVersion) el.appVersion.textContent = current || '—'
    if (el.installUpdateBtn) el.installUpdateBtn.classList.add('hidden')
    let canInstall = true
    try {
      if (typeof bridge.canInstallPackages === 'function') canInstall = !!bridge.canInstallPackages()
    } catch {}
    if (el.updateStatus) el.updateStatus.textContent = canInstall ? '' : '需要允许安装未知应用'
    return current
  }

  async function checkUpdate() {
    const bridge = notifyBridge()
    if (!bridge) return
    const current = refreshUpdateSection()
    if (el.updateStatus) el.updateStatus.textContent = '检查中…'
    try {
      const data = await api('/api/v1/app/version')
      state.updateInfo = data
      if (versionNewer(data.version, current)) {
        if (el.updateStatus) el.updateStatus.textContent = `发现 ${data.version}`
        if (el.installUpdateBtn) el.installUpdateBtn.classList.remove('hidden')
      } else {
        if (el.updateStatus) el.updateStatus.textContent = '已是最新'
      }
    } catch (err) {
      if (el.updateStatus) el.updateStatus.textContent = `检查失败：${err.message}`
    }
  }

  function refreshNotifyStatus() {
    const bridge = notifyBridge()
    if (el.notifySection) el.notifySection.classList.toggle('hidden', !bridge)
    if (el.notifyToggle) el.notifyToggle.checked = notifyPreferred()
    if (!el.notifyStatus) return
    if (!bridge) {
      el.notifyStatus.textContent = '仅 App 内可用'
      return
    }
    try {
      if (!notifyPreferred()) el.notifyStatus.textContent = '已关闭'
      else if (!bridge.hasPermission()) el.notifyStatus.textContent = '系统权限未开启'
      else if (typeof bridge.isServiceRunning === 'function' && !bridge.isServiceRunning()) {
        el.notifyStatus.textContent = '已开启 · 后台服务未运行'
      } else {
        el.notifyStatus.textContent = '已开启 · 服务运行中'
      }
    } catch {
      el.notifyStatus.textContent = ''
    }
    if (el.batteryStatus) {
      try {
        el.batteryStatus.textContent = bridge.isIgnoringBatteryOptimizations()
          ? '已忽略（推荐）'
          : '未忽略'
      } catch {
        el.batteryStatus.textContent = '—'
      }
    }
  }

  // ── config / setup ──────────────────────────────────────────────────────

  function initConfig() {
    const params = new URLSearchParams(location.search)
    const qToken = params.get('token')
    const qOwner = params.get('ownerToken')
    const qDevice = params.get('device')
    const reset = params.get('reset') === '1'
    const savedToken = read(KEYS.token, '')
    const savedOwner = read(KEYS.ownerToken, '')
    // 登录 token 优先；只有首次配置或显式 reset 时才使用 URL 里的引导 token，
    // 避免每次启动都被旧访问令牌覆盖登录身份。
    if (qToken && (!savedToken || reset)) write(KEYS.token, qToken)
    if (qOwner && (!savedOwner || reset)) write(KEYS.ownerToken, qOwner)
    if (qDevice) write(KEYS.device, qDevice)
    if (qToken || qOwner || qDevice) {
      try { history.replaceState(null, '', location.pathname) } catch {}
    }
    state.url = (read(KEYS.url, '') || location.origin).replace(/\/+$/, '')
    state.token = read(KEYS.token, '')
    state.ownerToken = read(KEYS.ownerToken, '')
    state.device = read(KEYS.device, 'app-test') || 'app-test'
    write(KEYS.url, state.url)
    syncNativeNotify()
  }

  function openSetup(error) {
    el.setupUrl.value = state.url || location.origin
    el.setupToken.value = state.token || ''
    el.setupOwnerToken.value = state.ownerToken || ''
    el.setupDevice.value = state.device || 'app-test'
    el.setupError.textContent = error || ''
    el.setupBack.classList.toggle('hidden', !!state.token)
    el.setup.classList.remove('hidden')
    setTimeout(() => el.setupToken.focus(), 50)
  }
  function closeSetup() { el.setup.classList.add('hidden') }

  function showLogin(error) {
    el.setup.classList.add('hidden')
    el.loginError.textContent = error || ''
    el.login.classList.remove('hidden')
  }
  function hideLogin() { el.login.classList.add('hidden') }

  async function doAuth(mode) {
    const username = (el.loginUsername.value || '').trim()
    const password = el.loginPassword.value || ''
    if (!username) { el.loginError.textContent = '请填写用户名'; return }
    if (!password) { el.loginError.textContent = '请填写密码'; return }
    el.loginError.textContent = ''
    el.loginBtn.disabled = true
    el.registerBtn.disabled = true
    try {
      const res = await fetch(`${state.url}/api/v1/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      state.token = data.tokenId
      state.authFailed = false
      state.clientId = ''
      write(KEYS.token, state.token)
      syncNativeNotify()
      hideLogin()
      closeSetup()
      setStatus('连接中…', '')
      connect()
      loadMe()
      loadSession()
      showTab('chat')
      appendMessage({
        role: 'system',
        text: mode === 'register' ? '注册成功，已自动分配访问令牌' : '登录成功',
        ts: new Date().toISOString(),
      })
    } catch (err) {
      el.loginError.textContent = err.message
    } finally {
      el.loginBtn.disabled = false
      el.registerBtn.disabled = false
    }
  }

  function logout() {
    state.token = ''
    state.ownerToken = ''
    state.clientId = ''
    state.me = null
    state.authFailed = false
    state.messages = []
    setUnread(0)
    remove(KEYS.token)
    remove(KEYS.ownerToken)
    try { const bridge = notifyBridge(); if (bridge) bridge.setEnabled(false) } catch {}
    if (state.ws) { try { state.ws.close() } catch {} state.ws = null }
    renderMessages([])
    renderConnection()
    setStatus('未登录', 'offline')
    showLogin('')
    showTab('chat')
  }

  el.loginBtn.addEventListener('click', () => doAuth('login'))
  el.registerBtn.addEventListener('click', () => doAuth('register'))
  el.loginPassword.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); doAuth('login') }
  })
  el.advancedSetup.addEventListener('click', () => {
    hideLogin()
    openSetup('')
  })
  el.setupBack.addEventListener('click', () => {
    if (state.token) return
    el.setup.classList.add('hidden')
    showLogin('')
  })
  el.logoutBtn.addEventListener('click', logout)

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
    syncNativeNotify()
    closeSetup()
    hideLogin()
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
      setStatus('登录失效', 'offline')
      showLogin('登录已失效，请重新登录')
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
    if (!state.token) { setStatus('未登录', 'offline'); showLogin(''); return }
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
        setStatus('登录失效', 'offline')
        showLogin('登录已失效，请重新登录')
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
      // WS 只负责实时；重连后从服务端补拉当前会话，避免漏消息。
      refreshCurrentSessionSoon()
      flushOutbox().catch(() => {})
      return
    }
    if (msg.type === 'assistant' && msg.text) {
      clearTyping()
      appendMessage({ role: 'bot', text: msg.text, ts: msg.timestamp || new Date().toISOString() })
      if (state.tab === 'chat' && document.visibilityState === 'visible') markReadSoon()
      else setUnread(state.unread + 1)
      return
    }
    if (msg.type === 'file') {
      clearTyping()
      const file = {
        id: msg.id,
        name: msg.fileName,
        url: msg.url,
        kind: msg.kind || (msg.isImage ? 'image' : 'file'),
        isImage: !!msg.isImage,
        size: msg.size,
      }
      const ts = msg.timestamp || new Date().toISOString()
      rememberLocalFile({ ...file, ts })
      appendMessage({ role: 'bot', file, ts })
      if (state.tab === 'chat' && document.visibilityState === 'visible') markReadSoon()
      else setUnread(state.unread + 1)
      return
    }
    if (msg.type === 'notice' && msg.text) {
      // Owner 状态用顶栏标记表示，不再刷会话
      if (String(msg.text).includes('Owner 权限已启用')) return
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
    if (name === 'chat') {
      scrollToBottom()
      markReadSoon()
    }
    if (name === 'tools') loadTools()
    if (name === 'usage') loadUsage()
    if (name === 'settings') loadSettings()
    syncChatVisible()
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

  function appendLinkedText(parent, text) {
    const pattern = /(https?:\/\/[^\s<>"']+)/g
    let lastIndex = 0
    let match
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)))
      }
      const link = document.createElement('a')
      let cleanUrl = match[1]
      // 消息里的 Markdown 反引号/句末标点不能带进 URL，否则会 404。
      const trailing = /[`"'，。；：！？)\]}】]+$/.exec(cleanUrl)
      if (trailing) cleanUrl = cleanUrl.slice(0, -trailing[0].length)
      link.href = browserSafeUrl(cleanUrl)
      link.target = '_blank'
      link.rel = 'noopener'
      link.textContent = cleanUrl
      if (/\.apk(\?|$)/i.test(cleanUrl)) {
        link.addEventListener('click', event => {
          const bridge = notifyBridge()
          // 普通聊天里的 APK 链接先交给系统浏览器下载，不直接调用 App 内安装器；
          // 这样不会因为 Jarvis 自身的安装权限被卡住。App 更新入口仍走 installUpdate。
          if (bridge && typeof bridge.openExternal === 'function') {
            event.preventDefault()
            bridge.openExternal(browserSafeUrl(cleanUrl))
          } else if (bridge && typeof bridge.installUpdate === 'function') {
            event.preventDefault()
            bridge.installUpdate(browserSafeUrl(cleanUrl), '')
          }
        })
      }
      parent.appendChild(link)
      lastIndex = match.index + match[1].length
    }
    if (lastIndex < text.length) parent.appendChild(document.createTextNode(text.slice(lastIndex)))
  }

  function buildMessageEl(item) {
    const div = document.createElement('div')
    div.className = 'msg ' + (item.role === 'user' ? 'user' : item.role === 'system' ? 'system' : 'bot')

    if (item.text) {
      appendLinkedText(div, item.text)
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
    const url = file.url
      ? absUrl(file.url)
      : (file.id ? `${state.url}/api/file/${encodeURIComponent(file.id)}?token=${encodeURIComponent(state.token)}` : '')
    return buildMediaEl({
      id: file.id,
      name: file.name,
      url,
      kind: file.kind || (file.isImage ? 'image' : 'file'),
      size: file.size,
    })
  }

  function bindNativeFileLink(link, name, url) {
    const bridge = notifyBridge()
    if (!bridge) return
    const isApk = /\.apk(\?|$)/i.test(name || '') || /\.apk(\?|$)/i.test(url || '')
    link.addEventListener('click', event => {
      // 聊天里的文件统一先交给浏览器/系统下载；只有设置里的“下载并安装”才走 App 内安装器。
      if (typeof bridge.openExternal === 'function') {
        event.preventDefault()
        bridge.openExternal(browserSafeUrl(url))
        return
      }
      if (isApk && typeof bridge.installUpdate === 'function') {
        event.preventDefault()
        bridge.installUpdate(browserSafeUrl(url), '')
      }
    })
  }

  function fileVisual(name) {
    const ext = String(name || '').split('.').pop().toLowerCase()
    const map = {
      apk: { label: 'APK', cls: 'apk', type: '安装包' },
      pdf: { label: 'PDF', cls: 'pdf', type: 'PDF 文档' },
      doc: { label: 'DOC', cls: 'doc', type: 'Word 文档' },
      docx: { label: 'DOC', cls: 'doc', type: 'Word 文档' },
      xls: { label: 'XLS', cls: 'sheet', type: '表格' },
      xlsx: { label: 'XLS', cls: 'sheet', type: '表格' },
      csv: { label: 'CSV', cls: 'sheet', type: '表格' },
      ppt: { label: 'PPT', cls: 'ppt', type: '演示文稿' },
      pptx: { label: 'PPT', cls: 'ppt', type: '演示文稿' },
      zip: { label: 'ZIP', cls: 'zip', type: '压缩包' },
      rar: { label: 'RAR', cls: 'zip', type: '压缩包' },
      '7z': { label: '7Z', cls: 'zip', type: '压缩包' },
      txt: { label: 'TXT', cls: 'text', type: '文本' },
      md: { label: 'MD', cls: 'text', type: 'Markdown' },
      json: { label: 'JSON', cls: 'text', type: '数据文件' },
    }
    return map[ext] || { label: (ext || 'FILE').slice(0, 4).toUpperCase(), cls: 'generic', type: '文件' }
  }

  function buildMediaEl({ name, url, kind, size }) {
    const wrap = document.createElement('div')
    if (kind === 'image') {
      const img = document.createElement('img')
      img.className = 'media'
      img.src = url
      img.alt = name || '图片'
      img.addEventListener('click', () => openImageViewer(url, name || '图片'))
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
    const isApk = /\.apk(\?|$)/i.test(name || '') || /\.apk(\?|$)/i.test(url || '')
    const visual = fileVisual(name)
    const card = document.createElement('a')
    card.className = 'file-card ' + (isApk ? 'is-apk' : '')
    card.href = browserSafeUrl(url)
    card.target = '_blank'
    card.rel = 'noopener'

    const icon = document.createElement('span')
    icon.className = 'file-icon ' + visual.cls
    icon.textContent = visual.label
    card.appendChild(icon)

    const info = document.createElement('span')
    info.className = 'file-info'
    const nameEl = document.createElement('span')
    nameEl.className = 'file-name'
    nameEl.textContent = name || '文件'
    info.appendChild(nameEl)
    const meta = document.createElement('span')
    meta.className = 'file-meta'
    meta.textContent = [visual.type, size ? formatSize(size) : ''].filter(Boolean).join(' · ')
    info.appendChild(meta)
    card.appendChild(info)

    const action = document.createElement('span')
    action.className = 'file-action'
    action.textContent = isApk ? '下载' : '打开'
    card.appendChild(action)

    bindNativeFileLink(card, name || '', url)
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
      state.sessionId = data.session?.sessionId || data.sessionId || ''
      state.syncCursor = Number(data.cursor || 0)
      state.messages = Array.isArray(data.messages) ? data.messages : []
      state.oldestSeq = Number(data.oldestSeq ?? (state.messages[0]?.seq || 0))
      state.hasMore = !!data.hasMore
      const localFiles = readLocalFiles().filter(item => item.sessionId === state.sessionId)
      const fileKey = item => item?.id ? `id:${item.id}` : `url:${item?.url || ''}`
      const knownFiles = new Set(state.messages.filter(m => m.file).map(m => fileKey(m.file)))
      for (const item of localFiles) {
        const key = fileKey(item)
        if (knownFiles.has(key)) continue
        knownFiles.add(key)
        state.messages.push({
          role: 'bot',
          file: { id: item.id, name: item.name, url: item.url, kind: item.kind, isImage: item.isImage, size: item.size },
          ts: item.ts,
          local: true,
        })
      }
      // 文件消息按发送时间插回原位置，不能统一堆在最后。
      state.messages.sort((a, b) => {
        const at = Date.parse(a.ts || '') || 0
        const bt = Date.parse(b.ts || '') || 0
        if (at !== bt) return at - bt
        const as = Number.isInteger(a.seq) ? a.seq : Number.MAX_SAFE_INTEGER
        const bs = Number.isInteger(b.seq) ? b.seq : Number.MAX_SAFE_INTEGER
        return as - bs
      })
      renderMessages(state.messages)
      setOwnerChip(!!data.owner)
      setUnread(data.unread || 0)
      markReadSoon()
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

  async function loadOlder() {
    if (!state.token || !state.hasMore || state.loadingOlder) return
    state.loadingOlder = true
    const container = el.messages
    const previousHeight = container.scrollHeight
    const previousTop = container.scrollTop
    try {
      const data = await api(`/api/v1/session/history?before=${encodeURIComponent(state.oldestSeq || 0)}&limit=120`)
      if (data.sessionId && state.sessionId && data.sessionId !== state.sessionId) {
        await loadSession()
        return
      }
      const older = Array.isArray(data.messages) ? data.messages : []
      if (!older.length) {
        state.hasMore = false
        return
      }
      const known = new Set(state.messages.map(m => m.id).filter(Boolean))
      const prepend = older.filter(m => !known.has(m.id))
      state.messages = [...prepend, ...state.messages]
      state.oldestSeq = Number(data.oldestSeq ?? state.oldestSeq)
      state.hasMore = !!data.hasMore
      renderMessages(state.messages)
      requestAnimationFrame(() => {
        container.scrollTop = previousTop + (container.scrollHeight - previousHeight)
      })
    } catch {}
    finally {
      state.loadingOlder = false
    }
  }

  async function loadMe() {
    if (!state.token) return
    try {
      const data = await api('/api/v1/me')
      state.me = data
      setOwnerChip(!!data.owner)
      if (el.settingsUsername) {
        el.settingsUsername.textContent = data.username || data.displayName || '—'
      }
      renderConnection()
      el.testChip.textContent = data.testMode ? '测试' : 'App'
    } catch {}
  }

  // attachments
  el.attach.addEventListener('click', toggleAttachSheet)
  el.attachBackdrop.addEventListener('click', closeAttachSheet)
  el.attachCancel.addEventListener('click', closeAttachSheet)
  for (const item of el.attachItems) {
    item.addEventListener('click', () => pickAttachment(item.dataset.kind))
  }

  if (el.imageCloseBtn) el.imageCloseBtn.addEventListener('click', closeImageViewer)
  if (el.imageDownloadBtn) el.imageDownloadBtn.addEventListener('click', downloadViewerImage)
  if (el.imageViewer) {
    el.imageViewer.addEventListener('click', event => {
      if (event.target === el.imageViewer) closeImageViewer()
    })
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && el.imageViewer && !el.imageViewer.classList.contains('hidden')) {
      closeImageViewer()
    }
  })

  function toggleAttachSheet() {
    const willOpen = el.attachSheet.classList.contains('hidden')
    el.attachSheet.classList.toggle('hidden', !willOpen)
    el.attach.setAttribute('aria-expanded', willOpen ? 'true' : 'false')
  }
  function closeAttachSheet() {
    el.attachSheet.classList.add('hidden')
    el.attach.setAttribute('aria-expanded', 'false')
  }
  function pickAttachment(kind) {
    const configs = {
      image: { accept: 'image/*', multiple: true },
      camera: { accept: 'image/*', multiple: false, capture: 'environment' },
      video: { accept: 'video/*', multiple: true },
      audio: { accept: 'audio/*', multiple: false },
      file: { accept: '', multiple: true },
    }
    const config = configs[kind] || configs.file
    if (config.accept) el.fileInput.setAttribute('accept', config.accept)
    else el.fileInput.removeAttribute('accept')
    if (config.multiple) el.fileInput.setAttribute('multiple', '')
    else el.fileInput.removeAttribute('multiple')
    if (config.capture) el.fileInput.setAttribute('capture', config.capture)
    else el.fileInput.removeAttribute('capture')
    closeAttachSheet()
    el.fileInput.click()
  }

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
    const clientMessageId = newClientMessageId()
    const attachmentIds = attachments.map(a => a.id)
    appendMessage({
      role: 'user',
      id: clientMessageId,
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
        body: { text, attachmentIds, clientMessageId },
      })
    } catch (err) {
      clearTyping()
      queueOutgoing({ text, attachmentIds, clientMessageId })
      appendMessage({
        role: 'system',
        text: `发送失败，已加入重试队列：${err.message}`,
        ts: new Date().toISOString(),
      })
    }
  }

  el.messages.addEventListener('scroll', () => {
    if (el.messages.scrollTop < 32) loadOlder().catch(() => {})
  })

  el.send.addEventListener('click', sendMessage)
  el.input.addEventListener('keydown', event => {
    // 手机上没有 Shift；Enter 只换行，发送统一走按钮。
    // 桌面端保留 Ctrl/Cmd + Enter 快捷发送。
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
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
    if (!state.me) {
      try { await loadMe() } catch {}
    }
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
    const meId = state.me?.principalId || ''
    const tools = state.tools.filter(tool => {
      if (state.toolScope === 'my') {
        return tool.source === 'user' && !!meId && tool.ownerId === meId
      }
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
      empty.textContent = state.toolQuery
        ? '没有匹配的工具'
        : (state.toolScope === 'my' ? '你还没有创建自己的工具' : '还没有工具')
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
    refreshNotifyStatus()
    refreshUpdateSection()
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
    el.settingsUsername.textContent = state.me?.username || state.me?.displayName || '—'
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

  function openNativeSettings(method) {
    const bridge = notifyBridge()
    if (!bridge) return
    try {
      if (typeof bridge[method] === 'function') bridge[method]()
    } catch {}
  }

  if (el.openBatteryBtn) {
    el.openBatteryBtn.addEventListener('click', () => openNativeSettings('openBatterySettings'))
  }
  if (el.openStartupBtn) {
    el.openStartupBtn.addEventListener('click', () => openNativeSettings('openStartupSettings'))
  }
  if (el.openNotifySettingsBtn) {
    el.openNotifySettingsBtn.addEventListener('click', () => openNativeSettings('openNotificationSettings'))
  }
  if (el.openAppSettingsBtn) {
    el.openAppSettingsBtn.addEventListener('click', () => openNativeSettings('openAppSettings'))
  }

  if (el.notifyTestBtn) {
    el.notifyTestBtn.addEventListener('click', () => {
      const bridge = notifyBridge()
      if (!bridge) return
      try {
        if (!bridge.hasPermission()) {
          bridge.requestPermission()
          el.notifyStatus.textContent = '等待系统通知权限…'
          setTimeout(refreshNotifyStatus, 1200)
          return
        }
        const ok = !!bridge.testNotification()
        el.notifyStatus.textContent = ok ? '测试通知已发送，看看通知栏喵' : '发送失败'
      } catch {
        el.notifyStatus.textContent = '发送失败'
      }
      setTimeout(refreshNotifyStatus, 2500)
    })
  }

  if (el.checkUpdateBtn) {
    el.checkUpdateBtn.addEventListener('click', () => { checkUpdate().catch(() => {}) })
  }
  if (el.installPermissionBtn) {
    el.installPermissionBtn.addEventListener('click', () => {
      const bridge = notifyBridge()
      if (!bridge) return
      try {
        if (typeof bridge.openInstallPermission === 'function') bridge.openInstallPermission()
        else if (typeof bridge.openAppSettings === 'function') bridge.openAppSettings()
      } catch {}
    })
  }
  if (el.installUpdateBtn) {
    el.installUpdateBtn.addEventListener('click', () => {
      const bridge = notifyBridge()
      if (!bridge || !state.updateInfo) return
      try {
        const ok = bridge.installUpdate(absUrl(state.updateInfo.url), state.updateInfo.sha256 || '')
        if (el.updateStatus) el.updateStatus.textContent = ok
          ? '正在下载，随后会弹出安装确认…'
          : '请先允许 Jarvis 安装未知应用'
      } catch {
        if (el.updateStatus) el.updateStatus.textContent = '无法开始安装'
      }
    })
  }

  if (el.notifyToggle) {
    el.notifyToggle.addEventListener('change', () => {
      const enabled = !!el.notifyToggle.checked
      write(KEYS.notify, enabled ? '1' : '0')
      const bridge = notifyBridge()
      if (!bridge) {
        refreshNotifyStatus()
        return
      }
      try {
        bridge.setEnabled(enabled)
        if (enabled) bridge.requestPermission()
      } catch {}
      refreshNotifyStatus()
      setTimeout(refreshNotifyStatus, 800)
    })
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
  document.addEventListener('visibilitychange', () => {
    syncChatVisible()
    if (document.visibilityState === 'visible') {
      refreshCurrentSessionSoon()
      flushOutbox().catch(() => {})
      markReadSoon()
    }
  })
  window.addEventListener('focus', () => {
    syncChatVisible()
    refreshCurrentSessionSoon()
  })
  window.addEventListener('blur', syncChatVisible)
  window.addEventListener('online', () => {
    refreshCurrentSessionSoon()
    flushOutbox().catch(() => {})
  })

  initConfig()
  renderConnection()
  showTab('chat')
  if (!state.token) {
    setStatus('未登录', 'offline')
    showLogin('')
    nativePageReady()
  } else {
    connect()
    loadMe()
    loadSession().finally(nativePageReady)
  }
})()
