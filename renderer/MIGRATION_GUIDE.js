/**
 * APP.JS 迁移指南
 *
 * 这份指南说明如何将现有的app.js逐步重构为使用新的统一对话逻辑
 * 不需要一次性全部重构，可以逐个功能迁移
 */

// ==================== PHASE 1: 导入新模块 ====================
// 在app.js开头添加这些导入（模块已在index.html中加载）

// 现在可用的全局对象：
//   - dialogModel: 统一的对话状态管理
//   - messageRenderer: 统一的渲染引擎
//   - dialogEventBus: 统一的事件总线

// ==================== PHASE 2: 替换消息记录逻辑 ====================

// 旧代码：
/*
function recordMessage(rec) {
  if (!sessionMessages.has(currentSessionId)) sessionMessages.set(currentSessionId, [])
  sessionMessages.get(currentSessionId).push(rec)
  if (!currentSessionId.startsWith('__new__')) {
    window.jarvis.appendSessionMessage(currentSessionId, rec).catch(() => {})
  }
}
*/

// 新代码：
function recordMessage(rec, sessionId = null) {
  // 只需一行，其他由dialogModel处理
  dialogModel.recordMessage(rec, sessionId || dialogModel.currentSessionId)
}

// ==================== PHASE 3: 替换渲染逻辑 ====================

// 旧代码：使用 _renderAssistantBubble, _renderUserBubble, appendUserMessage 等分散的函数
// 新代码：统一使用 messageRenderer.renderMessage()

// 示例1：渲染用户消息
/*
// 旧：appendUserMessage(text) { ... 内部调用 _renderUserBubble }
// 新：
function appendUserMessage(text) {
  const msg = { type: 'user', text, source: 'pc-main', metadata: {} }
  recordMessage(msg)

  const el = messageRenderer.renderMessage(msg)
  messages.appendChild(el)
  scrollDown()
}
*/

// 示例2：渲染AI回复
/*
// 旧：appendAssistantMessage(text) { ... 内部调用 _renderAssistantBubble }
// 新：
function appendAssistantMessage(text) {
  const msg = { type: 'assistant', text, source: 'pc-main', metadata: { timestamp: new Date().toISOString() } }
  recordMessage(msg)

  const el = messageRenderer.renderMessage(msg)
  messages.appendChild(el)
  scrollDown()
}
*/

// ==================== PHASE 4: 替换事件监听 ====================

// 旧代码（分散在各处）：
/*
window.jarvis.onStreamText((data) => {
  // ... 处理流式文本 ...
})

window.jarvis.onStreamTool((data) => {
  // ... 处理工具调用 ...
})

window.jarvis.onBridgeEvent((event) => {
  // ... Bridge特定逻辑 ...
})
*/

// 新代码（统一入口）：
dialogEventBus.onMessage((message) => {
  const { source, type, text, metadata } = message

  // 1. 记录消息
  dialogModel.recordMessage({ type, text, source, metadata }, dialogModel.currentSessionId)

  // 2. 渲染消息
  const el = messageRenderer.renderMessage(message)
  if (el) {
    messages.appendChild(el)
  }

  // 3. 处理特殊逻辑
  if (type === 'user') {
    // 用户消息已显示
  } else if (type === 'assistant') {
    // AI回复，更新UI状态
    busy = false
    if (metadata.cost) totalCost += metadata.cost
    if (metadata.turns) totalTurns += metadata.turns
  } else if (type === 'tool') {
    // 工具调用（messageRenderer已处理）
  }

  scrollDown()
})

// ==================== PHASE 5: 替换会话切换 ====================

// 旧代码：
/*
async function switchToSession(sessionId) {
  currentSessionId = sessionId
  messages.innerHTML = ''

  if (!sessionId.startsWith('__new__')) {
    if (!sessionMessages.has(sessionId)) {
      const diskHistory = await window.jarvis.readSessionMessages(sessionId)
      sessionMessages.set(sessionId, diskHistory)
    }
  }

  const history = sessionMessages.get(sessionId) || []
  // ... 逐个重新渲染所有消息 ...
}
*/

// 新代码：
async function switchToSession(sessionId) {
  // 让dialogModel处理所有逻辑
  await dialogModel.switchToSession(sessionId)

  // 清空并重新渲染
  messages.innerHTML = ''
  messageRenderer.clearAllMessages()

  const history = dialogModel.getCurrentHistory()
  for (const msg of history) {
    const el = messageRenderer.renderMessage(msg)
    if (el) {
      messages.appendChild(el)
    }
  }

  scrollDown()
}

// ==================== PHASE 6: 替换send()函数 ====================

// 核心改变：不再手动记录消息，而是通过dialogEventBus发送结果

// 旧逻辑框架：
/*
async function send() {
  if (busy) return
  busy = true

  const prompt = input.value
  input.value = ''

  // 1. 立即渲染用户消息
  appendUserMessage(prompt)  // 包含 recordMessage + DOM渲染

  // 2. 发送给AI
  const result = await window.jarvis.sendMessage({ prompt, ... })

  // 3. 监听流事件
  // onStreamText、onStreamTool 在这期间不断触发

  // 4. Result到达时
  appendAssistantMessage(result.text)  // 包含 recordMessage + DOM渲染
  recordMessage({ type: 'assistant', text: result.text })

  busy = false
}
*/

// 新逻辑框架：
/*
async function send() {
  if (busy) return
  busy = true

  const prompt = input.value
  input.value = ''

  // 1. 通过新事件总线发送用户消息
  dialogEventBus.emitUserMessage(prompt, 'pc-main')

  // 2. 发送给AI（会触发onStreamText/onStreamTool）
  const result = await window.jarvis.sendMessage({
    prompt,
    model: getSelectedModel(),
    permissionMode: getPermissionMode(),
    sessionId: dialogModel.currentSessionId,
    isMain: isMainSession
  })

  // 3. 通过新事件总线发送result
  dialogEventBus.emitPCResult(result)

  // 流事件会自动通过 dialogEventBus.onMessage 处理

  busy = false
}
*/

// ==================== PHASE 7: 清理 ====================

// 可以删除的旧函数（已由新模块替代）：
// - recordMessage（改用 dialogModel.recordMessage）
// - switchToSession（改用 dialogModel.switchToSession）
// - _renderAssistantBubble（改用 messageRenderer.renderMessage）
// - _renderUserBubble（改用 messageRenderer.renderMessage）
// - _renderBridgeResult（改用 messageRenderer.renderMessage）
// - _renderBridgeIncoming（改用 messageRenderer.renderMessage）
// - _renderBridgeTool（改用 messageRenderer.renderMessage）
// - appendUserMessage（改用 dialogEventBus.emitUserMessage）
// - appendAssistantMessage（改用 dialogEventBus.emitPCResult）
// - appendToolTag（工具记录已集成在messageRenderer）
// - appendErrorMessage（改用 messageRenderer.renderMessage）
// - 所有 onStreamText / onStreamTool / onBridgeEvent 的手动监听

// ==================== PHASE 8: CSS调整 ====================

// 在 styles.css 中添加这些规则来支持data-source属性：

/*
/ * Bridge端消息不显示工具折叠块 * /
[data-source="weixin"] .thinking-details,
[data-source="qq"] .thinking-details {
  display: none;
}

/ * Bridge端工具标签灰显 * /
[data-source="weixin"] .tool-tag,
[data-source="qq"] .tool-tag {
  opacity: 0.65;
}

/ * 可选：为Bridge消息添加源标签提示 * /
[data-source="weixin"]::before {
  content: attr(data-source-label);
  font-size: 12px;
  opacity: 0.7;
  margin-right: 4px;
}
*/

// ==================== 迁移检查清单 ====================

const MIGRATION_CHECKLIST = `
□ Step 1: 添加三个新的<script>标签到index.html
□ Step 2: 替换 recordMessage() 实现
□ Step 3: 更新 appendUserMessage() 和 appendAssistantMessage()
□ Step 4: 迁移事件监听到 dialogEventBus.onMessage()
□ Step 5: 重构 switchToSession()
□ Step 6: 重构 send() 函数
□ Step 7: 删除所有旧的渲染函数
□ Step 8: 更新 styles.css，添加data-source规则
□ Step 9: 测试PC端主会话
□ Step 10: 测试Bridge端（微信/QQ）消息
□ Step 11: 验证样式一致性
□ Step 12: 删除旧的 sessionMessages 全局变量
`

// ==================== 验证：一致性检查 ====================

// 完成迁移后，验证两端对话逻辑确实统一了：

// 测试1：修改PC端消息样式
//   1. 改 messageRenderer._renderAssistantBubble() 的样式
//   2. 发送PC消息 → 立即生效
//   3. 切换到微信会话 → 样式保持一致

// 测试2：修改工具标签显示
//   1. 改 messageRenderer._renderToolTag() 的DOM结构
//   2. 发送PC消息 + 工具调用 → PC端工具标签更新
//   3. 发送微信消息 + 工具调用 → 微信端同时更新（虽然被hidden，但DOM结构一致）

// 测试3：验证消息记录
//   1. 发送PC消息 → 检查 dialogModel.sessionMessages
//   2. 发送微信消息 → 检查 dialogModel.sessionMessages
//   3. 两个sessionId的消息结构应完全相同

console.log('app.js迁移指南已加载。参考上述代码注释逐步迁移。')
