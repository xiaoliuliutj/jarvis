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
    device: '',
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
    connectionStatus: '',
    attachments: [],
    messages: [],
    runStatus: { timer: null, since: 0, text: '' },
    wsSeen: new Set(),
    tab: 'chat',
    tools: [],
    toolQuery: '',
    toolScope: 'all',
    toolDetail: null,
    expandedToolId: null,
    models: [],
    settings: null,
    me: null,
    usageGranularity: 'day',
    usageAnchor: todayKey(),
    usageSummary: null,
    usageError: '',
    usageDetailsOpen: false,
    usageMessageOpen: {},
    usageMessageCalls: {},
    usageRequestKey: '',
    context: null,
    editingModelId: null,
    updateInfo: null,
  }

  const el = {
    dot: $('statusDot'),
    ownerChip: $('ownerChip'),
    contextBar: $('contextBar'),
    contextSegments: $('contextSegments'),
    contextLabel: $('contextLabel'),
    contextPercent: $('contextPercent'),
    contextLegend: $('contextLegend'),
    contextPopover: $('contextPopover'),
    views: {
      chat: $('view-chat'),
      tools: $('view-tools'),
      usage: $('view-usage'),
      settings: $('view-settings'),
    },
    navButtons: Array.from(document.querySelectorAll('.nav-btn')),
    messages: $('messages'),
    runStatus: $('runStatus'),
    runStatusText: $('runStatusText'),
    runStatusElapsed: $('runStatusElapsed'),
    chatUnread: $('chatUnread'),
    chatScrollbar: $('chatScrollbar'),
    chatScrollbarThumb: $('chatScrollbarThumb'),
    scrollBottomBtn: $('scrollBottomBtn'),
    olderLoading: $('olderLoading'),
    olderLoadingText: $('olderLoadingText'),
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
    usageGranularity: $('usageGranularity'),
    usageDate: $('usageDate'),
    usagePrev: $('usagePrev'),
    usageNext: $('usageNext'),
    usageToday: $('usageToday'),
    usagePeriodLabel: $('usagePeriodLabel'),
    usageCards: $('usageCards'),
    usageMeta: $('usageMeta'),
    usageChart: $('usageChart'),
    usageDetailsToggle: $('usageDetailsToggle'),
    usageMessageCount: $('usageMessageCount'),
    usageMessages: $('usageMessages'),
    settingsStatus: $('settingsStatus'),
    settingsUrl: $('settingsUrl'),
    settingsNickname: $('settingsNickname'),
    settingsAccount: $('settingsAccount'),
    settingsAccountId: $('settingsAccountId'),
    settingsOwnerStatus: $('settingsOwnerStatus'),
    editNickname: $('editNickname'),
    nicknameInput: $('nicknameInput'),
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
    setupOwnerToken: $('setupOwnerToken'),
    setupSave: $('setupSave'),
    setupBack: $('setupBack'),
    setupError: $('setupError'),
    login: $('login'),
    loginNickname: $('loginNickname'),
    loginUsername: $('loginUsername'),
    loginPassword: $('loginPassword'),
    loginError: $('loginError'),
    loginBtn: $('loginBtn'),
    registerBtn: $('registerBtn'),
    advancedSetup: $('advancedSetup'),
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

  function pad2(n) {
    return String(n).padStart(2, '0')
  }
  function localDateKey(date = new Date()) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  }
  function todayKey() {
    return localDateKey(new Date())
  }
  function parseLocalDateKey(key) {
    const [year, month, day] = String(key || '').split('-').map(Number)
    return new Date(year || new Date().getFullYear(), (month || 1) - 1, day || 1)
  }
  function addDays(date, days) {
    const next = new Date(date)
    next.setDate(next.getDate() + days)
    return next
  }
  function startOfWeek(date) {
    const next = new Date(date)
    const offset = (next.getDay() + 6) % 7
    next.setDate(next.getDate() - offset)
    next.setHours(0, 0, 0, 0)
    return next
  }
  function usagePeriodRange(granularity, anchorKey) {
    const anchor = parseLocalDateKey(anchorKey)
    if (granularity === 'day') {
      const from = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())
      return { from, to: addDays(from, 1) }
    }
    if (granularity === 'week') {
      const from = startOfWeek(anchor)
      return { from, to: addDays(from, 7) }
    }
    const from = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
    return { from, to: new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1) }
  }
  function usageSnapAnchor(granularity, anchorKey) {
    const { from } = usagePeriodRange(granularity, anchorKey)
    return localDateKey(from)
  }
  function usageShiftAnchor(granularity, anchorKey, delta) {
    const date = parseLocalDateKey(anchorKey)
    if (granularity === 'day') {
      date.setDate(date.getDate() + delta)
    } else if (granularity === 'week') {
      date.setDate(date.getDate() + delta * 7)
    } else {
      date.setDate(1)
      date.setMonth(date.getMonth() + delta)
    }
    return localDateKey(date)
  }
  function usagePeriodLabel(granularity, from, to) {
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    if (granularity === 'day') {
      return `${from.getFullYear()}年${from.getMonth() + 1}月${from.getDate()}日 ${weekdays[from.getDay()]}`
    }
    if (granularity === 'week') {
      const last = addDays(to, -1)
      return `${from.getFullYear()}年${from.getMonth() + 1}月${from.getDate()}日 - ${last.getMonth() + 1}月${last.getDate()}日`
    }
    return `${from.getFullYear()}年${from.getMonth() + 1}月`
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
    if (/^(blob:|data:)/i.test(url)) return url
    const absolute = /^https?:/i.test(url)
      ? url
      : (url.startsWith('/') ? state.url + url : `${state.url}/${url}`)
    // 文件/媒体 URL 统一附加登录用户 token；旧访问令牌不再用于身份。
    try {
      const parsed = new URL(absolute)
      const sameOrigin = parsed.origin === new URL(state.url).origin
      const isAsset = parsed.pathname.startsWith('/api/file/') || parsed.pathname.startsWith('/api/v1/media/')
      if (state.token && sameOrigin && (isAsset || parsed.searchParams.has('token'))) {
        parsed.searchParams.set('token', state.token)
      }
      return parsed.toString()
    } catch {
      return absolute
    }
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
  function formatTokens(n) {
    const value = Number(n) || 0
    if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
    if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
    if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
    return String(Math.round(value))
  }
  function formatTokenExact(n) {
    return Math.round(Number(n) || 0).toLocaleString('zh-CN')
  }
  function formatDuration(ms) {
    const value = Number(ms) || 0
    if (value >= 60000) return `${(value / 60000).toFixed(1)} 分钟`
    if (value >= 1000) return `${(value / 1000).toFixed(1)} 秒`
    return `${Math.round(value)} ms`
  }
  function setStatus(text, mode) {
    state.connectionStatus = text
    if (el.status) el.status.textContent = text
    if (el.dot) {
      el.dot.className = 'dot' + (mode ? ' ' + mode : '')
      el.dot.title = text
    }
    if (el.settingsStatus) el.settingsStatus.textContent = text
  }
  function setOwnerChip(owner) {
    el.ownerChip.classList.toggle('hidden', !owner)
  }
  function toast(text) {
    appendMessage({ role: 'system', text, ts: new Date().toISOString() })
  }

  const CONTEXT_GROUPS = [
    { id: 'system', label: '系统', color: '#3987e5', ids: ['system_prompt'] },
    { id: 'messages', label: '历史', color: '#d95926', ids: ['messages'] },
    { id: 'tools', label: '工具', color: '#199e70', ids: ['system_tools', 'mcp_tools', 'mcp_instructions', 'custom_agents'] },
    { id: 'memory', label: '记忆', color: '#9085e9', ids: ['memory_files', 'skills'] },
    { id: 'buffer', label: '预留', color: '#c98500', ids: ['autocompact_buffer', 'compact_buffer'] },
    { id: 'other', label: '其他', color: '#d55181', ids: [] },
  ]

  function contextCategoryId(category) {
    if (category.id) return category.id
    const name = String(category.name || '').toLowerCase()
    if (name.includes('system prompt')) return 'system_prompt'
    if (name.includes('system tool')) return 'system_tools'
    if (name.includes('mcp')) return name.includes('instruction') ? 'mcp_instructions' : 'mcp_tools'
    if (name.includes('message')) return 'messages'
    if (name.includes('memory')) return 'memory_files'
    if (name.includes('skill')) return 'skills'
    if (name.includes('agent')) return 'custom_agents'
    if (name.includes('autocompact')) return 'autocompact_buffer'
    if (name.includes('compact')) return 'compact_buffer'
    if (name.includes('free')) return 'free_space'
    return ''
  }

  function renderContext(context) {
    state.context = context || null
    if (!el.contextSegments || !el.contextLabel) return
    el.contextSegments.textContent = ''
    el.contextLegend.textContent = ''
    el.contextPopover.textContent = ''
    if (!context || !Array.isArray(context.categories) || !context.categories.length) {
      el.contextLabel.textContent = '上下文 —'
      el.contextPercent.textContent = ''
      el.contextBar.classList.add('empty')
      const hint = document.createElement('div')
      hint.className = 'context-popover-row'
      hint.textContent = '等待下一次回复后显示上下文明细'
      el.contextPopover.appendChild(hint)
      return
    }

    const max = Number(context.maxTokens) || Number(context.rawMaxTokens) || 0
    const total = Number(context.totalTokens) || 0
    const groups = CONTEXT_GROUPS.map(group => ({ ...group, tokens: 0 }))
    for (const category of context.categories) {
      const categoryId = category ? contextCategoryId(category) : ''
      if (!category || category.kind === 'deferred' || categoryId === 'free_space') continue
      const group = groups.find(item => item.ids.includes(categoryId))
        || groups.find(item => item.id === 'other')
      group.tokens += Number(category.tokens) || 0
    }
    const summed = groups.reduce((sum, group) => sum + group.tokens, 0)
    if (total > summed) groups.find(group => group.id === 'other').tokens += total - summed
    const visible = groups.filter(group => group.tokens > 0)
    const denominator = max || Math.max(total, 1)

    for (const group of visible) {
      const percent = group.tokens / denominator * 100
      const segment = document.createElement('span')
      segment.className = 'context-segment'
      segment.style.background = group.color
      segment.style.width = `${Math.max(0.4, percent)}%`
      segment.title = `${group.label} · ${formatTokens(group.tokens)} tokens · ${percent.toFixed(1)}%`
      segment.setAttribute('aria-label', segment.title)
      el.contextSegments.appendChild(segment)
    }
    el.contextBar.classList.toggle('empty', !visible.length)
    el.contextLabel.textContent = `上下文 ${formatTokens(total)} / ${formatTokens(max)}${context.estimated ? ' · 估算' : ''}`
    const percentage = Number(context.percentage) || (max ? total / max * 100 : 0)
    el.contextPercent.textContent = max ? `${Math.round(percentage)}%` : ''

    for (const group of visible) {
      const item = document.createElement('span')
      item.className = 'context-legend-item'
      const dot = document.createElement('span')
      dot.className = 'context-legend-dot'
      dot.style.background = group.color
      const label = document.createElement('span')
      label.textContent = group.label
      item.appendChild(dot)
      item.appendChild(label)
      el.contextLegend.appendChild(item)
    }

    const usedForBar = Math.max(total, summed)
    const free = Math.max(0, max - usedForBar)
    const rows = [...visible]
    if (free > 0) rows.push({ id: 'free', label: '空闲', color: 'rgba(242,239,228,0.28)', tokens: free })
    for (const row of rows) {
      const rowEl = document.createElement('div')
      rowEl.className = 'context-popover-row'
      const dot = document.createElement('span')
      dot.className = 'context-legend-dot'
      dot.style.background = row.color
      const name = document.createElement('span')
      name.className = 'context-popover-name'
      name.textContent = row.label
      const value = document.createElement('span')
      value.className = 'context-popover-value'
      value.textContent = `${formatTokens(row.tokens)} · ${(row.tokens / denominator * 100).toFixed(1)}%`
      rowEl.appendChild(dot)
      rowEl.appendChild(name)
      rowEl.appendChild(value)
      el.contextPopover.appendChild(rowEl)
    }
  }

  if (el.contextBar) {
    el.contextBar.addEventListener('click', event => {
      event.stopPropagation()
      el.contextPopover.classList.toggle('hidden')
    })
  }
  document.addEventListener('click', event => {
    if (!el.contextPopover || el.contextPopover.classList.contains('hidden')) return
    if (el.contextPopover.contains(event.target) || el.contextBar.contains(event.target)) return
    el.contextPopover.classList.add('hidden')
  })
  renderContext(null)

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

  let olderLoadingTimer = null
  function showOlderLoading(text = '正在加载更早消息…') {
    if (!el.olderLoading) return
    clearTimeout(olderLoadingTimer)
    if (el.olderLoadingText) el.olderLoadingText.textContent = text
    el.olderLoading.classList.remove('hidden')
  }
  function hideOlderLoading(delay = 0) {
    if (!el.olderLoading) return
    clearTimeout(olderLoadingTimer)
    olderLoadingTimer = setTimeout(() => el.olderLoading.classList.add('hidden'), delay)
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

  // 设备 ID 只用于消息路由：客户端生成并持久化，不提供给用户编辑。
  function newDeviceId() {
    try {
      const bytes = new Uint8Array(16)
      crypto.getRandomValues(bytes)
      return 'dev_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
    } catch {
      return 'dev_' + Math.random().toString(16).slice(2) + Date.now().toString(16)
    }
  }

  function initConfig() {
    const params = new URLSearchParams(location.search)
    const qOwner = params.get('ownerToken')
    const reset = params.get('reset') === '1'
    const savedOwner = read(KEYS.ownerToken, '')
    // 登录 token 只来自登录接口；共享访问令牌不再作为身份引导。
    if (qOwner && (!savedOwner || reset)) write(KEYS.ownerToken, qOwner)
    if (qOwner) {
      try { history.replaceState(null, '', location.pathname) } catch {}
    }
    state.url = (read(KEYS.url, '') || location.origin).replace(/\/+$/, '')
    state.token = read(KEYS.token, '')
    state.ownerToken = read(KEYS.ownerToken, '')
    // 旧设备名（owner/app-test）一律换成本机随机 ID；不再从 URL/用户输入读取。
    const savedDevice = read(KEYS.device, '')
    const invalidDevice = !savedDevice
      || savedDevice === 'owner'
      || savedDevice === 'app-test'
      || savedDevice.length < 8
    state.device = invalidDevice ? newDeviceId() : savedDevice
    write(KEYS.device, state.device)
    write(KEYS.url, state.url)
    syncNativeNotify()
  }

  function openSetup(error) {
    el.setupUrl.value = state.url || location.origin
    el.setupOwnerToken.value = state.ownerToken || ''
    el.setupError.textContent = error || ''
    el.setup.classList.remove('hidden')
    setTimeout(() => el.setupUrl.focus(), 50)
  }
  function closeSetup() { el.setup.classList.add('hidden') }

  function showLogin(error) {
    el.setup.classList.add('hidden')
    el.loginError.textContent = error || ''
    el.login.classList.remove('hidden')
  }
  function hideLogin() { el.login.classList.add('hidden') }

  async function doAuth(mode) {
    const nickname = (el.loginNickname.value || '').trim()
    const account = (el.loginUsername.value || '').trim()
    const password = el.loginPassword.value || ''
    if (mode === 'register' && !nickname) { el.loginError.textContent = '请填写昵称'; return }
    if (!account) { el.loginError.textContent = '请填写账号'; return }
    if (!password) { el.loginError.textContent = '请填写密码'; return }
    el.loginError.textContent = ''
    el.loginBtn.disabled = true
    el.registerBtn.disabled = true
    try {
      const body = mode === 'register'
        ? { nickname, account, password }
        : { account, password }
      const res = await fetch(`${state.url}/api/v1/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
        text: mode === 'register' ? '注册成功，已登录' : '登录成功',
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
    state.context = null
    renderContext(null)
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
    el.setup.classList.add('hidden')
    if (!state.token) showLogin('')
  })
  el.logoutBtn.addEventListener('click', logout)

  el.setupSave.addEventListener('click', () => {
    const url = (el.setupUrl.value || '').trim().replace(/\/+$/, '')
    const ownerToken = (el.setupOwnerToken.value || '').trim()
    if (!/^https?:\/\//i.test(url)) { el.setupError.textContent = '地址要以 http:// 或 https:// 开头'; return }
    state.url = url
    state.ownerToken = ownerToken
    state.clientId = ''
    state.authFailed = false
    write(KEYS.url, state.url)
    write(KEYS.ownerToken, state.ownerToken)
    syncNativeNotify()
    closeSetup()
    renderConnection()
    if (state.token) {
      hideLogin()
      setStatus('连接中…', '')
      connect()
      loadMe()
      loadSession()
      showTab('chat')
    } else {
      showLogin('')
    }
  })

  el.editConnection.addEventListener('click', () => openSetup(''))
  el.reconnectBtn.addEventListener('click', reconnect)

  function openNicknameEditor() {
    if (!el.nicknameInput || !el.settingsNickname) return
    el.nicknameInput.value = state.me?.nickname || ''
    el.nicknameInput.classList.remove('hidden')
    el.settingsNickname.classList.add('hidden')
    if (el.editNickname) el.editNickname.classList.add('hidden')
    el.nicknameInput.focus()
    try { el.nicknameInput.select() } catch {}
  }
  function closeNicknameEditor() {
    if (el.nicknameInput) el.nicknameInput.classList.add('hidden')
    if (el.settingsNickname) el.settingsNickname.classList.remove('hidden')
    if (el.editNickname) el.editNickname.classList.remove('hidden')
  }
  async function saveNickname() {
    if (!el.nicknameInput || el.nicknameInput.classList.contains('hidden')) return
    const nickname = (el.nicknameInput.value || '').trim()
    if (!nickname) { toast('昵称不能为空'); el.nicknameInput.focus(); return }
    const current = state.me?.nickname || ''
    if (nickname === current) { closeNicknameEditor(); return }
    try {
      const data = await api('/api/v1/me', { method: 'PUT', body: { nickname } })
      if (state.me) state.me.nickname = data.nickname || nickname
      closeNicknameEditor()
      renderConnection()
      toast('昵称已更新')
    } catch (err) {
      toast(`修改失败：${err.message}`)
    }
  }
  el.editNickname?.addEventListener('click', openNicknameEditor)
  el.nicknameInput?.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); el.nicknameInput.blur() }
    else if (event.key === 'Escape') { event.preventDefault(); closeNicknameEditor() }
  })
  el.nicknameInput?.addEventListener('blur', () => { saveNickname() })

  // ── API ─────────────────────────────────────────────────────────────────

  async function api(path, opts = {}) {
    if (!state.token) throw new Error('请先登录')
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
      // 旧连接被替换后，迟到的事件不能再处理，否则同一条回复会重复入列表。
      if (state.ws !== ws) return
      let msg
      try { msg = JSON.parse(event.data) } catch { return }
      handleEvent(msg)
    }
    ws.onclose = event => {
      // 已经切换到新连接时，旧连接的 onclose 不能把 state.ws 清空。
      if (state.ws !== ws) return
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

  // 同一条 WS 事件可能从多条残留连接重复到达；以 id / 时间戳+正文去重。
  function isDuplicateWsEvent(key) {
    if (!key) return false
    if (state.wsSeen.has(key)) return true
    state.wsSeen.add(key)
    if (state.wsSeen.size > 300) {
      const oldest = state.wsSeen.values().next().value
      state.wsSeen.delete(oldest)
    }
    return false
  }

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
    if (msg.type === 'context') {
      renderContext(msg.context)
      return
    }
    if (msg.type === 'turn_status' && msg.state) {
      setRunStatus(msg)
      return
    }
    if (msg.type === 'assistant' && msg.text) {
      const key = msg.id
        ? `assistant:${msg.id}`
        : (msg.timestamp ? `assistant:${msg.timestamp}|${msg.text}` : '')
      if (isDuplicateWsEvent(key)) return
      clearTyping()
      appendMessage({ role: 'bot', text: msg.text, ts: msg.timestamp || new Date().toISOString() })
      refreshContext()
      if (state.tab === 'chat' && document.visibilityState === 'visible') markReadSoon()
      else setUnread(state.unread + 1)
      return
    }
    if (msg.type === 'file') {
      // 回合进行中也可能发文件，不能因此清掉运行状态。
      const key = msg.id
        ? `file:${msg.id}`
        : (msg.timestamp ? `file:${msg.timestamp}|${msg.url || msg.fileName || ''}` : '')
      if (isDuplicateWsEvent(key)) return
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
      requestAnimationFrame(updateChatScrollbar)
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

  // ── markdown ────────────────────────────────────────────────────────────

  function markdownSafeUrl(raw) {
    const value = String(raw || '').trim().replace(/^<|>$/g, '')
    if (!value) return ''
    if (/^(https?:\/\/|\/)/i.test(value)) return browserSafeUrl(value)
    if (/^[\w.-]+\.[a-z]{2,}([/:?#]|$)/i.test(value)) return browserSafeUrl(`https://${value}`)
    return ''
  }

  function appendMarkdownInline(parent, text) {
    const src = String(text ?? '')
    let index = 0
    let buffer = ''
    const flush = () => {
      if (!buffer) return
      parent.appendChild(document.createTextNode(buffer))
      buffer = ''
    }
    const pushEmphasis = (tag, start, marker, end) => {
      flush()
      const el = document.createElement(tag)
      appendMarkdownInline(el, src.slice(start, end))
      parent.appendChild(el)
      return end + marker.length
    }

    while (index < src.length) {
      const char = src[index]

      if (char === '`') {
        const end = src.indexOf('`', index + 1)
        if (end > index + 1) {
          flush()
          const code = document.createElement('code')
          code.textContent = src.slice(index + 1, end)
          parent.appendChild(code)
          index = end + 1
          continue
        }
      }

      if (char === '!' && src[index + 1] === '[') {
        const labelEnd = src.indexOf(']', index + 2)
        if (labelEnd > index && src[labelEnd + 1] === '(') {
          const urlEnd = src.indexOf(')', labelEnd + 2)
          if (urlEnd > labelEnd) {
            const alt = src.slice(index + 2, labelEnd)
            const url = markdownSafeUrl(src.slice(labelEnd + 2, urlEnd))
            if (url) {
              flush()
              const image = document.createElement('img')
              image.className = 'md-image'
              image.src = url
              image.alt = alt || '图片'
              image.loading = 'lazy'
              image.addEventListener('click', () => openImageViewer(url, alt || '图片'))
              parent.appendChild(image)
              index = urlEnd + 1
              continue
            }
          }
        }
      }

      if (char === '[') {
        const labelEnd = src.indexOf(']', index + 1)
        if (labelEnd > index && src[labelEnd + 1] === '(') {
          const urlEnd = src.indexOf(')', labelEnd + 2)
          if (urlEnd > labelEnd) {
            const label = src.slice(index + 1, labelEnd)
            const url = markdownSafeUrl(src.slice(labelEnd + 2, urlEnd))
            if (url) {
              flush()
              const link = document.createElement('a')
              link.href = url
              link.target = '_blank'
              link.rel = 'noopener'
              appendMarkdownInline(link, label)
              parent.appendChild(link)
              index = urlEnd + 1
              continue
            }
          }
        }
      }

      if (char === '~' && src[index + 1] === '~') {
        const end = src.indexOf('~~', index + 2)
        if (end > index + 2) {
          index = pushEmphasis('del', index + 2, '~~', end)
          continue
        }
      }

      if (char === '*' || char === '_') {
        if (char === '_'
          && /[A-Za-z0-9]/.test(src[index - 1] || '')
          && /[A-Za-z0-9]/.test(src[index + 1] || '')) {
          buffer += char
          index++
          continue
        }
        const triple = src.slice(index, index + 3)
        if (triple === '***' || triple === '___') {
          const end = src.indexOf(triple, index + 3)
          if (end > index + 3) {
            flush()
            const strong = document.createElement('strong')
            const em = document.createElement('em')
            appendMarkdownInline(em, src.slice(index + 3, end))
            strong.appendChild(em)
            parent.appendChild(strong)
            index = end + 3
            continue
          }
        }
        const double = src.slice(index, index + 2)
        if (double === '**' || double === '__') {
          const end = src.indexOf(double, index + 2)
          if (end > index + 2) {
            index = pushEmphasis('strong', index + 2, double, end)
            continue
          }
        }
        const end = src.indexOf(char, index + 1)
        if (end > index + 1) {
          index = pushEmphasis('em', index + 1, char, end)
          continue
        }
      }

      if ((char === 'h' || char === 'H') && /^https?:\/\//i.test(src.slice(index))) {
        let end = index
        while (end < src.length && !/[\s<>"']/.test(src[end])) end++
        let url = src.slice(index, end)
        const trailing = /[`"'，。；：！？)\]}>】]+$/.exec(url)
        if (trailing) url = url.slice(0, -trailing[0].length)
        flush()
        const link = document.createElement('a')
        link.href = browserSafeUrl(url)
        link.target = '_blank'
        link.rel = 'noopener'
        link.textContent = url
        parent.appendChild(link)
        index += url.length
        continue
      }

      if (char === '\n') {
        flush()
        parent.appendChild(document.createElement('br'))
        index++
        continue
      }

      buffer += char
      index++
    }
    flush()
  }

  function markdownTableStart(lines, index) {
    const line = lines[index] || ''
    const next = lines[index + 1] || ''
    return line.includes('|')
      && next.includes('|')
      && /^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/.test(next)
  }

  function splitMarkdownTableRow(line) {
    let value = String(line || '').trim()
    if (value.startsWith('|')) value = value.slice(1)
    if (value.endsWith('|')) value = value.slice(0, -1)
    return value.split('|').map(cell => cell.trim())
  }

  function renderMarkdownTable(parent, lines, start) {
    const header = splitMarkdownTableRow(lines[start])
    const separators = splitMarkdownTableRow(lines[start + 1])
    const alignments = separators.map(cell => {
      const left = cell.startsWith(':')
      const right = cell.endsWith(':')
      return left && right ? 'center' : (right ? 'right' : 'left')
    })
    const wrap = document.createElement('div')
    wrap.className = 'md-table-wrap'
    const table = document.createElement('table')
    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    header.forEach((cell, column) => {
      const th = document.createElement('th')
      appendMarkdownInline(th, cell)
      th.style.textAlign = alignments[column] || 'left'
      headRow.appendChild(th)
    })
    thead.appendChild(headRow)
    table.appendChild(thead)
    const tbody = document.createElement('tbody')
    let index = start + 2
    while (index < lines.length) {
      const line = lines[index]
      if (!line.trim() || !line.includes('|')) break
      const cells = splitMarkdownTableRow(line)
      const row = document.createElement('tr')
      for (let column = 0; column < header.length; column++) {
        const td = document.createElement('td')
        appendMarkdownInline(td, cells[column] || '')
        td.style.textAlign = alignments[column] || 'left'
        row.appendChild(td)
      }
      tbody.appendChild(row)
      index++
    }
    table.appendChild(tbody)
    wrap.appendChild(table)
    parent.appendChild(wrap)
    return index
  }

  function renderMarkdownList(lines, start) {
    const first = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[start])
    if (!first) {
      return { el: document.createElement('ul'), next: start + 1 }
    }
    const baseIndent = first[1].length
    const ordered = /^\d+\./.test(first[2])
    const list = document.createElement(ordered ? 'ol' : 'ul')
    let index = start
    let lastItem = null

    while (index < lines.length) {
      const match = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[index])
      if (!match) break
      const indent = match[1].length
      const itemOrdered = /^\d+\./.test(match[2])
      if (indent < baseIndent) break
      if (indent === baseIndent && itemOrdered !== ordered) break

      if (indent > baseIndent) {
        if (!lastItem) break
        const nested = renderMarkdownList(lines, index)
        lastItem.appendChild(nested.el)
        if (nested.next === index) break
        index = nested.next
        continue
      }

      lastItem = document.createElement('li')
      const task = /^\[([ xX])\]\s+(.*)$/.exec(match[3])
      if (task) {
        const box = document.createElement('span')
        box.className = 'md-task'
        box.textContent = task[1].toLowerCase() === 'x' ? '☑' : '☐'
        lastItem.appendChild(box)
        appendMarkdownInline(lastItem, task[2])
      } else {
        appendMarkdownInline(lastItem, match[3])
      }
      list.appendChild(lastItem)
      index++

      while (index < lines.length) {
        const nextLine = lines[index]
        if (!nextLine.trim()) { index++; break }
        if (/^(\s*)([-*+]|\d+\.)\s+/.test(nextLine)) break
        const spaces = nextLine.length - nextLine.trimStart().length
        if (spaces <= baseIndent) break
        appendMarkdownInline(lastItem, '\n' + nextLine.trim())
        index++
      }
    }
    return { el: list, next: index }
  }

  function renderMarkdownBlocks(parent, lines) {
    let index = 0
    while (index < lines.length) {
      const line = lines[index]
      if (!line.trim()) { index++; continue }

      const fence = /^\s*(```+|~~~+)\s*([A-Za-z0-9_+-]*)\s*$/.exec(line)
      if (fence) {
        const marker = fence[1][0]
        const fenceLength = fence[1].length
        const body = []
        index++
        while (index < lines.length) {
          const close = new RegExp(`^\\s*${marker}{${fenceLength},}\\s*$`)
          if (close.test(lines[index])) { index++; break }
          body.push(lines[index])
          index++
        }
        const wrap = document.createElement('div')
        wrap.className = 'md-code'
        const pre = document.createElement('pre')
        const code = document.createElement('code')
        if (fence[2]) code.className = `language-${fence[2]}`
        code.textContent = body.join('\n')
        pre.appendChild(code)
        const copy = document.createElement('button')
        copy.type = 'button'
        copy.className = 'md-copy'
        copy.textContent = '复制'
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(body.join('\n'))
            copy.textContent = '已复制'
            setTimeout(() => { copy.textContent = '复制' }, 1200)
          } catch {
            copy.textContent = '复制失败'
          }
        })
        wrap.appendChild(pre)
        wrap.appendChild(copy)
        parent.appendChild(wrap)
        continue
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line)
      if (heading) {
        const el = document.createElement(`h${heading[1].length}`)
        appendMarkdownInline(el, heading[2])
        parent.appendChild(el)
        index++
        continue
      }

      if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        parent.appendChild(document.createElement('hr'))
        index++
        continue
      }

      if (/^\s*>/.test(line)) {
        const quoteLines = []
        while (index < lines.length && /^\s*>/.test(lines[index])) {
          quoteLines.push(lines[index].replace(/^\s*>\s?/, ''))
          index++
        }
        const quote = document.createElement('blockquote')
        renderMarkdownBlocks(quote, quoteLines)
        parent.appendChild(quote)
        continue
      }

      if (markdownTableStart(lines, index)) {
        index = renderMarkdownTable(parent, lines, index)
        continue
      }

      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        const list = renderMarkdownList(lines, index)
        parent.appendChild(list.el)
        index = list.next
        continue
      }

      const paragraph = []
      while (index < lines.length) {
        const current = lines[index]
        if (!current.trim()) break
        if (paragraph.length && (
          /^\s*(```|~~~)/.test(current)
          || /^(#{1,6})\s+/.test(current)
          || /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(current)
          || /^\s*>/.test(current)
          || /^\s*([-*+]|\d+\.)\s+/.test(current)
          || markdownTableStart(lines, index)
        )) break
        paragraph.push(current)
        index++
      }
      if (!paragraph.length) { index++; continue }
      const p = document.createElement('p')
      appendMarkdownInline(p, paragraph.join('\n'))
      parent.appendChild(p)
    }
  }

  function renderMarkdown(parent, text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
    renderMarkdownBlocks(parent, lines)
  }

  function buildMessageEl(item) {
    const div = document.createElement('div')
    div.className = 'msg ' + (item.role === 'user' ? 'user' : item.role === 'system' ? 'system' : 'bot')

    if (item.text) {
      if (item.role === 'bot') {
        const md = document.createElement('div')
        md.className = 'md'
        renderMarkdown(md, item.text)
        div.appendChild(md)
      } else {
        appendLinkedText(div, item.text)
      }
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
    const url = att.url
      ? absUrl(att.url)
      : (att.mediaId
        ? `${state.url}/api/v1/media/${encodeURIComponent(att.mediaId)}?token=${encodeURIComponent(state.token)}&device=${encodeURIComponent(state.device)}`
        : '')
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
    const wasAtBottom = el.messages.scrollTop + el.messages.clientHeight >= el.messages.scrollHeight - 60
    state.messages.push(item)
    if (el.messages.querySelector('.empty-state')) el.messages.textContent = ''
    el.messages.appendChild(buildMessageEl(item))
    if (wasAtBottom) scrollToBottom()
    else requestAnimationFrame(updateChatScrollbar)
  }

  function updateChatScrollbar() {
    const messages = el.messages
    const track = el.chatScrollbar
    const thumb = el.chatScrollbarThumb
    if (!messages || !track || !thumb) return
    const maxScroll = Math.max(0, messages.scrollHeight - messages.clientHeight)
    if (maxScroll < 2) {
      track.classList.add('hidden')
      if (el.scrollBottomBtn) el.scrollBottomBtn.classList.add('hidden')
      return
    }
    track.classList.remove('hidden')
    const trackHeight = track.clientHeight
    const thumbHeight = Math.max(32, Math.round(trackHeight * messages.clientHeight / messages.scrollHeight))
    const maxTop = Math.max(0, trackHeight - thumbHeight)
    const ratio = maxScroll ? Math.min(1, Math.max(0, messages.scrollTop / maxScroll)) : 0
    thumb.style.height = thumbHeight + 'px'
    thumb.style.transform = `translateY(${Math.round(maxTop * ratio)}px)`
    if (el.scrollBottomBtn) {
      el.scrollBottomBtn.classList.toggle('hidden', messages.scrollTop >= maxScroll - 40)
    }
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      el.messages.scrollTop = el.messages.scrollHeight
      updateChatScrollbar()
    })
  }

  const TOOL_TIPS = new Map([
    ['Bash', '执行命令中'],
    ['Read', '读取文件中'],
    ['Write', '写入文件中'],
    ['Edit', '修改文件中'],
    ['MultiEdit', '修改文件中'],
    ['NotebookEdit', '修改笔记中'],
    ['Glob', '查找文件中'],
    ['Grep', '搜索内容中'],
    ['WebSearch', '搜索资料中'],
    ['WebFetch', '读取网页中'],
    ['Task', '处理子任务中'],
    ['Agent', '处理子任务中'],
    ['TodoWrite', '整理任务中'],
    ['cn_calendar', '查询日历中'],
    ['weather_query', '查询天气中'],
    ['festival_query', '查询节日中'],
    ['my_location', '定位中'],
    ['file_builder', '生成文件中'],
    ['read_word', '读取 Word 文档中'],
    ['unzip_file', '解压文件中'],
    ['screenshot', '截屏中'],
    ['image_gen', '生成图片中'],
    ['abstract_image', '生成表情图中'],
    ['mouse_control', '操作鼠标中'],
    ['keyboard_control', '操作键盘中'],
    ['input_session', '控制键鼠中'],
    ['restart', '重启服务中'],
    ['persona', '处理人设中'],
  ])

  // MCP 名称格式：mcp__<服务>__<工具>...；按服务+动作给出自然描述。
  const TOOL_SERVICE_ACTIONS = new Map([
    ['cron', { default: '处理定时任务中', add: '创建定时任务中', list: '查看定时任务中', update: '修改定时任务中', delete: '删除定时任务中' }],
    ['schedule', { default: '处理日程中', add: '添加日程中', list: '查看日程中', update: '修改日程中', delete: '删除日程中' }],
    ['notes', { default: '整理笔记中', add: '记录笔记中', read: '查看笔记中', task_done: '更新任务中' }],
    ['persona', { default: '处理人设中', get_persona: '查看人设中', update_persona: '修改人设中' }],
    ['restart', { default: '重启服务中' }],
    ['_meta', { default: '管理工具中', create_tool: '创建工具中', update_tool: '修改工具中', delete_tool: '删除工具中', list_tools: '查看工具中', toggle_tool: '开关工具中', get_tool_template: '查看工具模板中' }],
  ])

  function toolTip(name) {
    const raw = String(name || '').trim()
    if (!raw) return '执行操作中…'
    const direct = TOOL_TIPS.get(raw) || TOOL_TIPS.get(raw.replace(/^mcp__/, ''))
    if (direct) return direct

    const parts = raw.replace(/^mcp__/, '').split('__').filter(Boolean)
    const service = parts[0] || ''
    const action = parts[1] || ''
    if (TOOL_TIPS.has(service)) return TOOL_TIPS.get(service)
    const actions = TOOL_SERVICE_ACTIONS.get(service)
    if (actions) return actions[action] || actions.default
    // 不认识的自定义工具：给通用描述，绝不展示代码方法名。
    return '执行操作中…'
  }

  function runStatusLabel(status) {
    switch (status?.state) {
      case 'queued': return '排队中…'
      case 'tool': return toolTip(status.tool)
      case 'writing': return '正在整理回复…'
      case 'interim': return String(status.text || '').trim() || '正在处理…'
      case 'started':
      case 'thinking':
      default: return '思考中…'
    }
  }

  // 运行状态独立于消息时间线：刷新/重连/插入消息都不会把它冲掉。
  function setRunStatus(status) {
    if (!el.runStatus) return
    if (!status || status.state === 'done') { clearRunStatus(); return }
    const label = runStatusLabel(status)
    state.runStatus.since = Number(status.since) || state.runStatus.since || Date.now()
    state.runStatus.text = label
    el.runStatusText.textContent = label
    el.runStatus.classList.remove('hidden')
    renderRunElapsed()
    if (!state.runStatus.timer) {
      state.runStatus.timer = setInterval(renderRunElapsed, 1000)
    }
    // 兜底：断线丢失 done 事件时，45 分钟后自动收起。
    clearTimeout(state.runStatus.staleTimer)
    state.runStatus.staleTimer = setTimeout(clearRunStatus, 45 * 60 * 1000)
  }

  function renderRunElapsed() {
    if (!el.runStatusElapsed) return
    const seconds = Math.max(0, Math.floor((Date.now() - (state.runStatus.since || Date.now())) / 1000))
    el.runStatusElapsed.textContent = seconds >= 1 ? `${seconds}s` : ''
  }

  function clearRunStatus() {
    if (state.runStatus.timer) {
      clearInterval(state.runStatus.timer)
      state.runStatus.timer = null
    }
    clearTimeout(state.runStatus.staleTimer)
    state.runStatus.staleTimer = null
    state.runStatus.since = 0
    state.runStatus.text = ''
    if (el.runStatus) el.runStatus.classList.add('hidden')
    if (el.runStatusElapsed) el.runStatusElapsed.textContent = ''
  }

  function showTyping() {
    setRunStatus({ state: 'thinking', since: Date.now() })
  }

  function clearTyping() {
    clearRunStatus()
  }

  async function refreshContext() {
    if (!state.token) return
    try {
      const data = await api('/api/v1/context')
      renderContext(data.context || null)
    } catch {}
  }

  async function loadSession() {
    if (!state.token) return
    try {
      const data = await api('/api/v1/session/current')
      state.sessionId = data.session?.sessionId || data.sessionId || ''
      state.syncCursor = Number(data.cursor || 0)
      state.messages = Array.isArray(data.messages) ? data.messages : []
      state.context = data.context || null
      renderContext(state.context)
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
      // 刷新/重连后恢复服务端的真实运行状态，而不是把状态当成消息重建。
      if (data.running) setRunStatus(data.running)
      else clearRunStatus()
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
    showOlderLoading()
    let keepHint = false
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
        showOlderLoading('已经到最上面了')
        keepHint = true
        return
      }
      const known = new Set(state.messages.map(m => m.id).filter(Boolean))
      const prepend = older.filter(m => !known.has(m.id))
      state.messages = [...prepend, ...state.messages]
      state.oldestSeq = Number(data.oldestSeq ?? state.oldestSeq)
      state.hasMore = !!data.hasMore
      // 只增量插入旧消息，避免每次翻页重建整个消息列表
      if (prepend.length) {
        if (el.messages.querySelector('.empty-state')) el.messages.textContent = ''
        const fragment = document.createDocumentFragment()
        for (const item of prepend) fragment.appendChild(buildMessageEl(item))
        el.messages.insertBefore(fragment, el.messages.firstChild)
      }
      requestAnimationFrame(() => {
        container.scrollTop = previousTop + (container.scrollHeight - previousHeight)
        updateChatScrollbar()
      })
    } catch {}
    finally {
      state.loadingOlder = false
      hideOlderLoading(keepHint ? 700 : 220)
    }
  }

  async function loadMe() {
    if (!state.token) return
    try {
      const data = await api('/api/v1/me')
      state.me = data
      setOwnerChip(!!data.owner)
      renderConnection()
      if (el.testChip) el.testChip.textContent = data.testMode ? '测试' : 'App'
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
    const pending = []
    for (const file of files) {
      if (state.attachments.length >= MAX_ATTACHMENTS) { toast(`最多 ${MAX_ATTACHMENTS} 个附件`); break }
      if (file.size > MAX_ATTACHMENT_BYTES) { toast(`「${file.name}」超过 20MB，已跳过`); continue }
      const mime = String(file.type || '')
      const isImage = mime.startsWith('image/')
      const kind = isImage
        ? 'image'
        : (mime.startsWith('video/') ? 'video' : (mime.startsWith('audio/') ? 'audio' : 'file'))
      const localUrl = isImage ? URL.createObjectURL(file) : ''
      const placeholder = {
        id: `local_${Date.now()}_${pending.length}`,
        fileName: file.name,
        mime: file.type,
        size: file.size,
        kind,
        url: localUrl,
        previewUrl: localUrl,
        uploading: true,
        file,
      }
      state.attachments.push(placeholder)
      pending.push(placeholder)
    }
    renderAttachments()
    for (const placeholder of pending) {
      placeholder.uploadPromise = uploadFile(placeholder.file)
        .then(uploaded => {
          uploaded.previewUrl = placeholder.previewUrl
          uploaded.uploading = false
          const index = state.attachments.indexOf(placeholder)
          if (index >= 0) state.attachments[index] = uploaded
          renderAttachments()
          return uploaded
        })
        .catch(err => {
          const index = state.attachments.indexOf(placeholder)
          if (index >= 0) state.attachments.splice(index, 1)
          renderAttachments()
          toast(`「${placeholder.fileName}」上传失败：${err.message}`)
          return null
        })
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
      chip.className = 'attach-chip' + (att.uploading ? ' uploading' : '')
      if (att.kind === 'image' && (att.previewUrl || att.url)) {
        const img = document.createElement('img')
        img.src = att.previewUrl || absUrl(att.url)
        img.alt = att.fileName || '图片'
        chip.appendChild(img)
      } else {
        const icon = document.createElement('span')
        icon.className = 'attach-file-icon'
        icon.textContent = fileVisual(att.fileName).label
        chip.appendChild(icon)
      }
      const name = document.createElement('span')
      name.className = 'attach-name'
      name.textContent = att.fileName || '文件'
      chip.appendChild(name)
      const removeBtn = document.createElement('button')
      removeBtn.type = 'button'
      removeBtn.textContent = '×'
      removeBtn.addEventListener('click', () => {
        const removed = state.attachments.splice(index, 1)[0]
        if (removed?.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(removed.previewUrl)
        renderAttachments()
      })
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
    appendMessage({
      role: 'user',
      id: clientMessageId,
      text,
      attachments: attachments.map(a => ({
        id: a.id,
        fileName: a.fileName,
        mime: a.mime,
        size: a.size,
        kind: a.kind,
        mediaId: a.id,
        // 乐观消息先用本地预览，避免等服务器图片加载；刷新后改用服务器 URL
        url: a.previewUrl || absUrl(a.url),
      })),
      ts: new Date().toISOString(),
    })
    el.input.value = ''
    state.attachments = []
    renderAttachments()
    autoGrow()
    showTyping()

    const uploadTasks = attachments.map(att => (
      att.uploading && att.uploadPromise ? att.uploadPromise : Promise.resolve(att)
    ))
    let resolved
    try {
      resolved = await Promise.all(uploadTasks)
    } catch (err) {
      clearTyping()
      appendMessage({
        role: 'system',
        text: `附件上传失败：${err.message}`,
        ts: new Date().toISOString(),
      })
      return
    }
    if (resolved.some(att => !att)) {
      clearTyping()
      appendMessage({
        role: 'system',
        text: '附件上传失败，请重新选择图片/文件后再发。',
        ts: new Date().toISOString(),
      })
      return
    }

    const attachmentIds = resolved.map(att => att.id)
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
    updateChatScrollbar()
    if (el.messages.scrollTop < 32) loadOlder().catch(() => {})
  })

  if (el.scrollBottomBtn) {
    el.scrollBottomBtn.addEventListener('click', () => {
      el.messages.scrollTo({ top: el.messages.scrollHeight, behavior: 'smooth' })
      updateChatScrollbar()
    })
  }

  if (el.chatScrollbar && el.chatScrollbarThumb) {
    const track = el.chatScrollbar
    const thumb = el.chatScrollbarThumb
    const messages = el.messages
    const maxScroll = () => Math.max(0, messages.scrollHeight - messages.clientHeight)
    const scrollToTrackY = clientY => {
      const rect = track.getBoundingClientRect()
      const ratio = rect.height ? Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)) : 0
      messages.scrollTop = ratio * maxScroll()
    }
    track.addEventListener('pointerdown', event => {
      if (event.target === thumb) return
      event.preventDefault()
      scrollToTrackY(event.clientY)
    })
    thumb.addEventListener('pointerdown', event => {
      event.preventDefault()
      event.stopPropagation()
      const startY = event.clientY
      const startTop = messages.scrollTop
      const trackHeight = track.clientHeight
      const thumbHeight = thumb.offsetHeight
      const total = maxScroll()
      const denominator = Math.max(1, trackHeight - thumbHeight)
      try { thumb.setPointerCapture(event.pointerId) } catch {}
      const move = moveEvent => {
        const delta = moveEvent.clientY - startY
        messages.scrollTop = Math.min(total, Math.max(0, startTop + (delta / denominator) * total))
      }
      const end = () => {
        thumb.removeEventListener('pointermove', move)
        thumb.removeEventListener('pointerup', end)
        thumb.removeEventListener('pointercancel', end)
      }
      thumb.addEventListener('pointermove', move)
      thumb.addEventListener('pointerup', end)
      thumb.addEventListener('pointercancel', end)
    })
    if (window.ResizeObserver) {
      new ResizeObserver(() => updateChatScrollbar()).observe(messages)
    }
    window.addEventListener('resize', () => updateChatScrollbar())
  }

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
    // 4 行 * 21px 行高 + 20px 内边距
    el.input.style.height = Math.min(el.input.scrollHeight, 104) + 'px'
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
        // 「我的」= 当前账号创建/拥有的工具（含放在系统目录但带 ownerId 的工具）。
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

  state.usageAnchor = usageSnapAnchor(state.usageGranularity, state.usageAnchor)
  el.usageDate.value = state.usageAnchor
  for (const button of el.usageGranularity.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.granularity === state.usageGranularity)
  }

  el.usageGranularity.addEventListener('click', event => {
    const button = event.target.closest('button[data-granularity]')
    if (!button) return
    state.usageGranularity = button.dataset.granularity
    state.usageAnchor = usageSnapAnchor(state.usageGranularity, state.usageAnchor)
    el.usageDate.value = state.usageAnchor
    for (const item of el.usageGranularity.querySelectorAll('button')) {
      item.classList.toggle('active', item === button)
    }
    resetUsagePeriod()
  })

  el.usageDate.addEventListener('change', () => {
    state.usageAnchor = el.usageDate.value || todayKey()
    resetUsagePeriod()
  })

  el.usagePrev.addEventListener('click', () => shiftUsagePeriod(-1))
  el.usageNext.addEventListener('click', () => shiftUsagePeriod(1))
  el.usageToday.addEventListener('click', () => {
    state.usageAnchor = todayKey()
    el.usageDate.value = state.usageAnchor
    resetUsagePeriod()
  })
  el.usageDetailsToggle.addEventListener('click', () => {
    state.usageDetailsOpen = !state.usageDetailsOpen
    renderUsage()
  })

  function resetUsagePeriod() {
    state.usageSummary = null
    state.usageError = ''
    state.usageDetailsOpen = false
    state.usageMessageOpen = {}
    state.usageMessageCalls = {}
    renderUsage()
    loadUsage()
  }

  function shiftUsagePeriod(delta) {
    state.usageAnchor = usageShiftAnchor(state.usageGranularity, state.usageAnchor, delta)
    el.usageDate.value = state.usageAnchor
    resetUsagePeriod()
  }

  function usageEmpty(target, text) {
    target.textContent = ''
    const empty = document.createElement('div')
    empty.className = 'empty-state'
    empty.textContent = text
    target.appendChild(empty)
  }

  function usageTokenTotal(record) {
    return (record.inputTokens || 0)
      + (record.outputTokens || 0)
      + (record.cacheReadTokens || 0)
      + (record.cacheWriteTokens || 0)
  }

  async function loadUsage() {
    if (!state.token) return
    if (!state.usageSummary) renderUsage()
    const { from, to } = usagePeriodRange(state.usageGranularity, state.usageAnchor)
    const query = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      messageLimit: '200',
    })
    const requestKey = query.toString()
    state.usageRequestKey = requestKey
    try {
      const data = await api(`/api/v1/usage/summary?${requestKey}`)
      if (state.usageRequestKey !== requestKey) return
      state.usageSummary = data.summary
      state.usageError = ''
      renderUsage()
    } catch (err) {
      if (state.usageRequestKey !== requestKey) return
      state.usageSummary = null
      state.usageError = err.message
      renderUsage()
    }
  }

  function renderUsage() {
    const s = state.usageSummary
    const data = s || {}
    const { from, to } = usagePeriodRange(state.usageGranularity, state.usageAnchor)
    el.usagePeriodLabel.textContent = usagePeriodLabel(state.usageGranularity, from, to)

    el.usageCards.textContent = ''
    const totalTokens = usageTokenTotal(data)
    const cards = [
      ['对话轮数', s ? formatTokenExact(data.messageTotal) : '—'],
      ['LLM 调用', s ? formatTokenExact(data.llmCalls) : '—'],
      ['输入 Token', s ? formatTokenExact(data.inputTokens) : '—'],
      ['输出 Token', s ? formatTokenExact(data.outputTokens) : '—'],
      ['缓存读 Token', s ? formatTokenExact(data.cacheReadTokens) : '—'],
      ['总 Token', s ? formatTokenExact(totalTokens) : '—'],
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

    if (s) {
      const parts = [
        `活跃 ${data.activeDays || 0} 天`,
        `平均耗时 ${formatDuration(data.avgLatencyMs)}`,
      ]
      if (data.legacyTurns) parts.push(`历史部分按 ${formatTokenExact(data.legacyTurns)} 轮整轮汇总`)
      if (data.cacheWriteTokens) parts.push(`缓存写 ${formatTokens(data.cacheWriteTokens)}`)
      if (data.errors) parts.push(`失败 ${data.errors} 次`)
      el.usageMeta.textContent = parts.join(' · ')
    } else {
      el.usageMeta.textContent = ''
    }

    const byModel = Object.entries(data.byModel || {})
      .map(([name, value]) => ({
        name,
        ...value,
        tokens: (value.inputTokens || 0)
          + (value.outputTokens || 0)
          + (value.cacheReadTokens || 0)
          + (value.cacheWriteTokens || 0),
      }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 8)
    const max = Math.max(1, ...byModel.map(item => item.tokens))
    el.usageChart.textContent = ''
    if (!s) {
      usageEmpty(el.usageChart, state.usageError ? `加载失败：${state.usageError}` : '正在加载用量…')
    } else if (!byModel.length) {
      usageEmpty(el.usageChart, '这个时间段还没有调用记录')
    } else {
      for (const item of byModel) {
        const row = document.createElement('div')
        row.className = 'bar-row'
        const nameEl = document.createElement('div')
        nameEl.className = 'bar-name'
        nameEl.textContent = item.name
        nameEl.title = `${formatTokenExact(item.tokens)} tokens · ${item.calls || 0} 次/轮`
        const track = document.createElement('div')
        track.className = 'bar-track'
        const fill = document.createElement('div')
        fill.className = 'bar-fill'
        fill.style.width = `${Math.max(4, item.tokens / max * 100)}%`
        track.appendChild(fill)
        const value = document.createElement('div')
        value.className = 'bar-value'
        value.textContent = `${formatTokens(item.tokens)} tok`
        row.appendChild(nameEl)
        row.appendChild(track)
        row.appendChild(value)
        el.usageChart.appendChild(row)
      }
    }

    const messageList = Array.isArray(data.messages) ? data.messages : []
    const messageNote = s && (data.messageTotal || 0) > messageList.length
      ? ` · 最近 ${messageList.length} 轮`
      : ''
    el.usageMessageCount.textContent = s ? `共 ${data.messageTotal || 0} 轮${messageNote}` : ''
    el.usageDetailsToggle.textContent = state.usageDetailsOpen ? '收起' : '查看详情'
    el.usageDetailsToggle.disabled = !s || !(data.messageTotal)
    el.usageMessages.classList.toggle('hidden', !state.usageDetailsOpen)
    renderUsageMessages()
  }

  function renderUsageMessages() {
    const data = state.usageSummary
    el.usageMessages.textContent = ''
    if (!state.usageDetailsOpen) return
    if (!data) {
      usageEmpty(el.usageMessages, state.usageError
        ? `消息明细加载失败：${state.usageError}`
        : '正在加载消息明细…')
      return
    }
    const messages = Array.isArray(data.messages) ? data.messages : []
    if (!messages.length) {
      usageEmpty(el.usageMessages, '这个时间段还没有消息')
      return
    }
    for (const message of messages) {
      const card = document.createElement('div')
      card.className = 'usage-message'
      const head = document.createElement('button')
      head.type = 'button'
      head.className = 'usage-message-head'

      const main = document.createElement('div')
      main.className = 'usage-message-main'
      const preview = document.createElement('div')
      preview.className = 'usage-message-preview'
      preview.textContent = message.preview
        || (message.level === 'turn'
          ? `历史对话 · ${formatTime(message.firstTs)}`
          : '对话（无预览）')
      const sub = document.createElement('div')
      sub.className = 'usage-message-sub'
      const parts = [formatTime(message.firstTs)]
      if (message.sessionName) parts.push(message.sessionName)
      if (message.calls) parts.push(`${formatTokenExact(message.calls)} 次 LLM 调用`)
      else parts.push(`${formatTokenExact(message.legacyTurns || message.turnRecords)} 轮整轮汇总`)
      if (message.models?.length === 1) parts.push(message.models[0])
      else if (message.models?.length > 1) parts.push(`${message.models.length} 个模型`)
      if (message.tools?.length) {
        parts.push(`工具 ${message.tools.slice(0, 2).join('、')}${message.tools.length > 2 ? '…' : ''}`)
      }
      sub.textContent = parts.join(' · ')
      main.appendChild(preview)
      main.appendChild(sub)

      const right = document.createElement('div')
      right.className = 'usage-message-right'
      const total = document.createElement('div')
      total.className = 'usage-message-total'
      total.textContent = `${formatTokenExact(message.totalTokens || 0)} tok`
      const breakdown = document.createElement('div')
      breakdown.className = 'usage-message-sub'
      const breakdownParts = [
        `入 ${formatTokens(message.inputTokens)}`,
        `出 ${formatTokens(message.outputTokens)}`,
      ]
      const cache = (message.cacheReadTokens || 0) + (message.cacheWriteTokens || 0)
      if (cache) breakdownParts.push(`缓存 ${formatTokens(cache)}`)
      breakdown.textContent = breakdownParts.join(' · ')
      right.appendChild(total)
      right.appendChild(breakdown)

      const chevron = document.createElement('span')
      chevron.className = 'usage-message-chevron'
      chevron.textContent = state.usageMessageOpen[message.turnId] ? '▾' : '▸'

      head.appendChild(main)
      head.appendChild(right)
      head.appendChild(chevron)
      head.addEventListener('click', () => toggleUsageMessage(message))
      card.appendChild(head)

      if (state.usageMessageOpen[message.turnId]) {
        const detail = document.createElement('div')
        detail.className = 'usage-message-detail'
        if (message.level === 'turn' || !message.calls) {
          renderUsageTurnSummary(detail, message)
        } else {
          const entry = state.usageMessageCalls[message.turnId]
          if (!entry || entry.loading) {
            usageEmpty(detail, '正在加载本次消息的 LLM 调用…')
          } else if (entry.error) {
            usageEmpty(detail, `加载失败：${entry.error}`)
          } else if (!entry.loaded) {
            usageEmpty(detail, '正在加载…')
          } else if (!entry.records.length) {
            usageEmpty(detail, '没有 LLM 调用记录')
          } else {
            renderUsageCalls(detail, entry.records)
          }
        }
        card.appendChild(detail)
      }
      el.usageMessages.appendChild(card)
    }
  }

  function renderUsageCalls(target, records) {
    target.textContent = ''
    const heading = document.createElement('div')
    heading.className = 'usage-call-heading'
    heading.textContent = `本轮 LLM 调用（${records.length} 次）`
    target.appendChild(heading)
    for (const [index, record] of records.entries()) {
      const item = document.createElement('div')
      item.className = 'record-item'
      const main = document.createElement('div')
      main.className = 'record-main'
      const title = document.createElement('div')
      title.className = 'record-title'
      const titleParts = [`#${index + 1}`, record.model || 'LLM 调用']
      if (record.subagent) titleParts.push('子任务')
      if (record.level === 'turn') titleParts.push(`整轮汇总 · ${record.turns || 0} 轮`)
      title.textContent = titleParts.join(' · ')
      const sub = document.createElement('div')
      sub.className = 'record-sub'
      const parts = [
        formatTime(record.ts),
        `入 ${formatTokenExact(record.inputTokens)} / 出 ${formatTokenExact(record.outputTokens)}`,
      ]
      if (record.cacheReadTokens) parts.push(`缓存读 ${formatTokenExact(record.cacheReadTokens)}`)
      if (record.cacheWriteTokens) parts.push(`缓存写 ${formatTokenExact(record.cacheWriteTokens)}`)
      if (record.tools?.length) parts.push(`${record.tools.length} 工具`)
      sub.textContent = parts.join(' · ')
      main.appendChild(title)
      main.appendChild(sub)

      const right = document.createElement('div')
      right.className = 'record-right'
      const tokens = document.createElement('div')
      tokens.textContent = `${formatTokenExact(usageTokenTotal(record))} tok`
      const status = document.createElement('div')
      status.className = record.status === 'error' ? 'record-error' : 'record-ok'
      status.textContent = record.status === 'error' ? '失败' : '成功'
      right.appendChild(tokens)
      right.appendChild(status)
      item.appendChild(main)
      item.appendChild(right)
      target.appendChild(item)
    }
  }

  function renderUsageTurnSummary(target, message) {
    target.textContent = ''
    const item = document.createElement('div')
    item.className = 'record-item'
    const main = document.createElement('div')
    main.className = 'record-main'
    const title = document.createElement('div')
    title.className = 'record-title'
    title.textContent = `整轮汇总 · ${message.legacyTurns || message.turnRecords || 0} 轮`
    const sub = document.createElement('div')
    sub.className = 'record-sub'
    const parts = [
      formatTime(message.firstTs),
      `入 ${formatTokenExact(message.inputTokens)} / 出 ${formatTokenExact(message.outputTokens)}`,
    ]
    if (message.cacheReadTokens) parts.push(`缓存读 ${formatTokenExact(message.cacheReadTokens)}`)
    if (message.cacheWriteTokens) parts.push(`缓存写 ${formatTokenExact(message.cacheWriteTokens)}`)
    if (message.tools?.length) parts.push(`${message.tools.length} 工具`)
    sub.textContent = parts.join(' · ')
    main.appendChild(title)
    main.appendChild(sub)
    const right = document.createElement('div')
    right.className = 'record-right'
    const tokens = document.createElement('div')
    tokens.textContent = `${formatTokenExact(message.totalTokens || 0)} tok`
    const status = document.createElement('div')
    status.className = message.status === 'error' ? 'record-error' : 'record-ok'
    status.textContent = message.status === 'error' ? '失败' : '成功'
    right.appendChild(tokens)
    right.appendChild(status)
    item.appendChild(main)
    item.appendChild(right)
    target.appendChild(item)
  }

  function toggleUsageMessage(message) {
    const turnId = message.turnId
    const open = !state.usageMessageOpen[turnId]
    state.usageMessageOpen[turnId] = open
    if (open && message.calls > 0) {
      const entry = state.usageMessageCalls[turnId]
      if (!entry || (!entry.loaded && !entry.loading)) loadUsageMessageCalls(message)
    }
    renderUsageMessages()
  }

  async function loadUsageMessageCalls(message) {
    const turnId = message.turnId
    if (!turnId || state.usageMessageCalls[turnId]?.loading) return
    const requestKey = state.usageRequestKey
    state.usageMessageCalls[turnId] = {
      loading: true,
      loaded: false,
      error: '',
      records: [],
    }
    renderUsageMessages()
    try {
      const data = await api(`/api/v1/usage/message?turnId=${encodeURIComponent(turnId)}`)
      if (state.usageRequestKey !== requestKey) return
      state.usageMessageCalls[turnId] = {
        loading: false,
        loaded: true,
        error: '',
        records: Array.isArray(data.records) ? data.records : [],
      }
    } catch (err) {
      if (state.usageRequestKey !== requestKey) return
      state.usageMessageCalls[turnId] = {
        loading: false,
        loaded: false,
        error: err.message,
        records: [],
      }
    } finally {
      if (state.usageRequestKey === requestKey) renderUsageMessages()
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

  function maskId(value) {
    const s = String(value || '').trim()
    if (!s) return '—'
    if (s.length <= 10) return `${s.slice(0, 3)}…${s.slice(-2)}`
    return `${s.slice(0, 6)}…${s.slice(-4)}`
  }

  function renderConnection() {
    if (!el.settingsStatus) return
    const me = state.me || {}
    el.settingsNickname.textContent = me.nickname || '—'
    el.settingsAccount.textContent = me.account || '—'
    el.settingsAccountId.textContent = maskId(me.accountId)
    el.settingsOwnerStatus.textContent = me.owner ? '已开启' : '未开启'
    el.settingsStatus.textContent = state.connectionStatus || '—'
    el.settingsUrl.textContent = state.url || '—'
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
        const rawId = device.deviceId || ''
        const deviceName = device.name || 'App'
        name.textContent = rawId ? `${deviceName} · ${maskId(rawId)}` : deviceName
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
      if (el.testChip) el.testChip.textContent = el.testModeToggle.checked ? '测试' : 'App'
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
