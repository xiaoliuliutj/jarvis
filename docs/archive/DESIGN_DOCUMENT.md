# Jarvis 前端统一架构设计文档

## 项目目标

**统一PC端主会话和微信端的前端对话逻辑**

核心问题：对一个端的修改（渲染逻辑或UI）应该立刻对另一个端生效。目前两套完全独立，修改无法同步。

---

## 现状分析

### PC端主会话流程
- 源头：渲染进程 input 框 → IPC `send-message`
- 事件监听：`window.jarvis.onStreamText()` / `window.jarvis.onStreamTool()` / `window.jarvis.onMemoryEvent()`
- 渲染函数：多个独立的渲染函数（`_renderAssistantBubble`, `_renderUserBubble`, `_renderErrorBubble`, `_renderSystemNote` 等）
- 消息记录：手动调用 `recordMessage()` → 维护 `sessionMessages Map` → 通过 IPC 调用 `window.jarvis.appendSessionMessage()` 写磁盘
- CSS类名：`msg msg-user`, `msg msg-assistant`, `msg-wrapper` 等

### Bridge微信端流程
- 源头：微信/HTTP → Bridge Server 的 `adapter-manager.mjs` 的 `routeMessage()`
- 事件推送：`window.jarvis.onBridgeEvent()` WebSocket 事件广播
- 渲染函数：独立的Bridge专用渲染函数（`_renderBridgeIncoming`, `_renderBridgeResult`, `_renderBridgeTool` 等）
- 消息记录：由 Bridge Server 端的 `adapter-manager.mjs` 调用 `appendSessionMessage()` 处理
- CSS类名：`bridge-wrapper`, `msg-bridge-incoming`, `msg-bridge-result` 等（与PC端完全不同）

**根本问题**：
- 两套完全独立的前端渲染栈
- 修改PC端的渲染逻辑，Bridge端无法同步
- CSS类名系统完全不同，导致样式修改只对一端生效
- 消息记录逻辑重复且分散在两处

---

## 设计方案：统一前端对话逻辑

### 架构概图

```
PC主会话(IPC)          Bridge适配器(WebSocket)
      ↓                        ↓
    [事件]                    [事件]
      ↓                        ↓
  ┌─────────────────────────────────┐
  │   统一事件转换层                │ ← 格式统一化
  └────────────┬────────────────────┘
               ↓
  ┌─────────────────────────────────┐
  │   统一对话状态管理              │ ← 单一sessionMessages
  └────────────┬────────────────────┘
               ↓
  ┌─────────────────────────────────┐
  │   统一消息渲染引擎              │ ← 一套渲染函数
  └────────────┬────────────────────┘
               ↓
  ┌─────────────────────────────────┐
  │   DOM (样式一致)                │ ← data-source属性追踪来源
  └─────────────────────────────────┘
```

### 核心原则

1. **Bridge Server 保持不变**
   - Bridge不涉及前端业务逻辑改动，仅作为消息中转站
   - 所有对话处理逻辑下沉到前端统一层

2. **事件格式标准化**
   - PC端IPC事件和Bridge端WebSocket事件都转换为统一格式
   - 所有消息使用相同的数据结构

3. **单一状态管理**
   - 替代分散的 `sessionMessages Map` 和 `recordMessage()` 函数
   - 统一处理内存存储和磁盘同步

4. **单一渲染函数库**
   - 替代分散的8个渲染函数
   - 所有消息无论来源都使用同一套渲染逻辑
   - 用 `data-source` 属性追踪来源，允许CSS差异化处理（如需要）

---

## 需要实现的功能

### 功能1：统一对话状态管理

**需求**：
- 维护当前会话ID
- 缓存会话消息列表（内存）
- 从磁盘加载会话历史
- 记录新消息到内存和磁盘
- 支持临时会话升级为真实会话
- 提供会话切换接口

**关键操作**：
- `recordMessage(message, sessionId)` - 记录消息到内存+磁盘
- `switchToSession(sessionId)` - 切换会话，加载历史
- `getCurrentHistory()` - 获取当前会话历史
- `getCurrentSessionId()` - 获取当前会话ID
- `upgradeSession(tempSessionId, realSessionId)` - 临时会话升级

**存储**：
- 内存中维护 `Map<sessionId → Message[]>`
- 消息同步到磁盘通过 `window.jarvis.appendSessionMessage(sessionId, message)` IPC

---

### 功能2：统一消息渲染

**需求**：
- 将任意消息对象转换为DOM元素
- 支持多种消息类型（user, assistant, tool, thinking, error, system）
- 工具调用和思考过程要与assistant消息关联显示（折叠块）
- 所有消息使用统一的CSS类名
- 在DOM元素中标记来源（PC vs Bridge）

**关键方法**：
- `renderMessage(message)` - 通用渲染入口，根据message.type分发
- 各类型专用渲染函数

**消息结构**：
```javascript
{
  type: 'user' | 'assistant' | 'tool' | 'thinking' | 'error' | 'system',
  text: string,                    // 内容文本
  source: 'pc-main' | 'weixin' | 'qq' | ...,  // 来源标记
  metadata: {
    name?: string,                 // 工具名称
    input?: object,                // 工具参数
    from?: string,                 // 用户来源
    cost?: number,                 // token成本
    turns?: number,                // 轮次
    timestamp?: string             // 时间戳
  }
}
```

**工具消息处理**：
- tool 和 thinking 类型消息不直接渲染到DOM
- 改为累积存储待处理区域
- 当assistant消息到达时，与累积的tool/thinking一起显示为折叠块

---

### 功能3：统一事件入口

**需求**：
- 自动检测运行环境（PC IPC vs Bridge WebSocket）
- 根据环境挂载相应的事件监听器
- 将PC端IPC事件转换为统一格式
- 将Bridge端WebSocket事件转换为统一格式
- 提供单一的消息事件监听接口

**事件适配**：

**PC端需要适配的IPC事件**：
- `window.jarvis.onStreamText(callback)` - 流式文本
- `window.jarvis.onStreamTool(callback)` - 工具调用
- `window.jarvis.onMemoryEvent(callback)` - 记忆事件
- `window.jarvis.onResult(callback)` - 最终结果

**Bridge端需要适配的WebSocket事件**：
- `window.jarvis.onBridgeEvent(callback)` - 所有Bridge事件（incoming, tool, result等）

**统一事件格式**：
所有事件统一发送为消息对象，包含上述消息结构

---

## App.js 改动清单

### 需要删除的代码
- 所有独立的渲染函数：`_renderAssistantBubble`, `_renderBridgeResult`, `_renderBridgeIncoming` 等
- 手动的 `recordMessage()` 实现
- 多套事件监听代码（PC端和Bridge端各一套）
- 分散在各处的消息记录逻辑

### 需要改动的代码
- 所有渲染调用改为使用统一渲染入口
- 所有消息记录改为使用统一状态管理
- 所有事件监听改为使用统一事件总线

### 保留的代码
- UI交互逻辑（会话切换、新建会话、输入框处理等）
- 权限管理逻辑
- 窗口控制逻辑
- 配置读取逻辑

---

## HTML改动

在 `index.html` 的 `<body>` 尾部，在 `<script src="app.js"></script>` 前添加三个新模块的加载：

```html
<!-- 统一对话逻辑层 -->
<script src="统一对话状态管理模块.js"></script>
<script src="统一消息渲染模块.js"></script>
<script src="统一事件入口模块.js"></script>

<!-- 主应用逻辑 -->
<script src="app.js"></script>
```

**加载顺序很重要**：状态管理、渲染、事件入口必须先于app.js加载

---

## CSS改动

### 核心改动
- 统一所有消息的CSS类名为 `msg`, `msg-user`, `msg-assistant` 等
- 删除或废弃Bridge专用的CSS类名（`bridge-wrapper`, `msg-bridge-*`）

### 可选改动
- 如需根据来源差异化样式，可添加 `[data-source="source-name"]` 选择器
- 例如：`[data-source="weixin"] .msg-assistant { /* 微信特定样式 */ }`

---

## 测试清单

### 功能测试

#### PC端主会话
- [ ] 发送消息 → 用户气泡立即显示
- [ ] AI流式回复 → 中间文本流式显示，工具调用显示在折叠块中
- [ ] AI回复完成 → 完整assistant气泡显示
- [ ] 切换会话 → 历史消息正确加载
- [ ] 新建会话 → 临时ID正确工作

#### Bridge端（微信/QQ）
- [ ] 接收消息 → 渲染与PC端样式一致
- [ ] 工具调用 → 显示在assistant消息的折叠块中
- [ ] 切换Bridge会话 → 历史从适配器正确加载

#### 样式一致性
- [ ] 修改任何消息渲染逻辑 → 两端同时更新
- [ ] 修改CSS类名 → 所有消息都应用新样式
- [ ] 检查所有DOM元素是否有 `data-source` 属性

---

## 迁移步骤

### 步骤1：创建三个新模块文件
1. 创建"对话状态管理"模块
2. 创建"消息渲染"模块
3. 创建"事件入口"模块

### 步骤2：修改 index.html
1. 在app.js前添加三个模块的script加载

### 步骤3：修改 app.js
1. 删除所有独立的渲染函数
2. 将所有渲染调用改为统一入口
3. 删除手动的recordMessage实现
4. 删除PC端和Bridge端各自的事件监听
5. 改为使用统一事件总线

### 步骤4：修改 styles.css
1. 统一CSS类名
2. 删除或调整Bridge专用类名

### 步骤5：验证和测试
1. 按照测试清单逐项验证
2. PC端消息发送、接收、历史加载
3. Bridge端消息显示
4. 样式一致性

---

## 关键要点

1. **Bridge Server端不改动** - 只在前端做适配
2. **自动环境检测** - 事件入口自动根据环境初始化
3. **消息格式统一** - 所有消息使用同一种结构
4. **修改一处生效两端** - 修改渲染逻辑立刻对两端生效
5. **最小化改动** - App.js只改必要部分，保留UI交互逻辑

---

**此文档仅包含需求和设计，不包含任何具体实现代码。**
