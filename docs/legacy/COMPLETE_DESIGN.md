# Jarvis 系统完整需求文档

## 项目概览

Jarvis 是一个多源对话平台，整合 PC 端（Electron）和多个外部适配器（微信、QQ 等）的消息，通过统一的 Claude Agent 处理和展示。

### 核心组件
- **Electron 主进程** - PC 端入口，驱动主会话
- **Electron 渲染进程** - 前端 UI 展示
- **Bridge Server** - 独立 Node.js 进程，管理外部 adapter（微信/QQ 等）
- **Agent 层** - Claude Agent SDK 集成，统一处理所有消息
- **存储层** - 本地文件系统存储会话历史和记忆

---

## 权限体系需求

### 基本权限模型

Agent 执行权限由 `isMain` 参数决定：

**`isMain: true`（主会话权限）**：
- 可读写整个 Jarvis 工作空间
- 访问 Jarvis 代码目录前需确认
- 工作空间外的访问需用户询问

**`isMain: false`（受限权限）**：
- 只能写 defaultworkspace（如 `C:\data\myproject`）
- 只能写绑定的 workDirs
- 其他目录的访问需用户询问

### 会话权限配置

**PC 主会话**：
- 权限：`isMain: true`
- 工作目录：`E:\Jarvis`（默认）
- 可绑定额外工作目录

**Bridge adapter 锚会话**（微信、QQ 等）：
- 权限：`isMain: true`（与 PC 主会话一致）
- 各 adapter 有独立的工作目录：
  - 微信：`E:\Jarvis\bridge\sessions\weixin`
  - QQ（未来）：`E:\Jarvis\bridge\sessions\qq`
- 微信用户与 PC 用户权限等同

---

## 会话管理需求

### 会话类型

**主会话（Main Session）**：
- 唯一的 PC 端主会话
- `cwd = E:\Jarvis`
- 用户在 PC 上直接驱动
- 不可归档

**临时会话（Temporary Session）**：
- 用户在 PC 上手动新建
- 第一条消息发出后自动命名
- 可归档、可删除

**锚会话（Anchor Session）**：
- 每个 Bridge adapter 对应一个锚会话
- 自动创建（adapter 首次发消息时）
- 有独立的工作目录
- 持久存储

### 会话生命周期

**创建**：
- PC 主会话：应用启动时
- PC 临时会话：用户点"新建会话"时
- Bridge 锚会话：adapter 首次发消息时

**命名**：
- 主会话：始终为"主会话"
- 临时会话：从第一条用户消息自动命名
- Bridge 锚会话：`[adapter] 用户名` 格式

**归档**：
- PC 临时会话可手动归档
- 归档时自动生成摘要写入长期记忆
- 归档后自动切换回主会话

**删除**：
- 临时会话可删除
- Bridge 锚会话不可删除（持久）

### 会话隔离

- 不同会话有独立的消息历史
- Bridge adapter 的锚会话有独立的工作目录（`cwdHash` 天然隔离）
- 同一 adapter 的多个临时会话共享相同工作目录但用 `sessionId` 区分

---

## 记忆系统需求

### 长期记忆结构

**个人记忆目录**：`agents/claude-cc/memory/`（运行时数据，不纳入版本控制）

**文件**：
- `long-term.jsonl` - 条目化的长期记忆
  - 格式：每行一个 JSON 对象，包含 type、content、priority、timestamp、source 等
  - 支持追加操作，不删除（只通过优先级降低隐藏）
  - 定期压缩（移除低优先级条目）

- `config/global.md` - 全局配置与知识库
  - Markdown 格式
  - 包含系统级设置、通用规则、共享配置等
  - 所有会话可读，但只能由用户手动修改

- `sessions/{cwdHash}/{sessionId}.messages.jsonl` - 会话消息记录
  - 用户归档会话时在 `archive/` 下生成索引记录
  - 全部属于个人数据，不纳入版本控制

### 记忆写入

记忆由 Agent 驱动，通过特殊的 Agent 工具写入：
- `memory.append()` - 追加条目到长期记忆
- `memory.update()` - 更新已有条目的优先级或内容
- `memory.query()` - 查询相关条目

### 记忆权限（Phase 1）

暂不限制。所有会话可读写长期记忆。

### 记忆事件监听

主进程可通过 `window.jarvis.onMemoryEvent()` 监听记忆操作：
- `append` - 新增条目
- `update` - 更新条目
- `compress` - 压缩长期记忆

---

## Bridge Server 需求

### 功能

管理外部消息适配器（微信、QQ 等），实现：
- 消息接收和转发
- 单激活机制（同一时间仅一个 adapter 处理消息）
- 消息队列（多个 adapter 消息排队处理）
- 锚会话管理（每个 adapter 独立的工作目录和会话）
- WebSocket 事件广播（实时推送事件到 Electron 主进程）

### 单激活机制

**规则**：
- 同一时间仅一个 adapter 处于激活状态
- 其他 adapter 的消息进入 FIFO 队列
- 当前 adapter 处理完后，自动激活队列中的下一条消息

**超时释放**：
- 5 分钟无活动后自动释放激活权
- 释放后等待新消息或手动触发

**说明**：
- Electron 本地会话（PC 主会话和临时会话）不受单激活限制
- 单激活仅约束外部 adapter 之间的并发

### 消息格式

Bridge 传递给 Electron 的消息格式：
```json
{
  "adapterId": "weixin",
  "from": "用户ID",
  "text": "消息内容",
  "attachments": [],
  "timestamp": "ISO8601"
}
```

### WebSocket 事件广播（端口 7780）

Electron 订阅的事件：

```json
{ "type": "incoming", "adapterId": "weixin", "payload": {...} }
{ "type": "active", "adapterId": "weixin" }
{ "type": "queued", "adapterId": "weixin", "position": 1 }
{ "type": "tool", "adapterId": "weixin", "name": "...", "input": {...} }
{ "type": "result", "adapterId": "weixin", "from": "...", "text": "...", "cost": 0, "isError": false }
{ "type": "released", "adapterId": "weixin", "reason": "timeout|queue-empty|manual" }
```

### HTTP API（端口 7779）

- `POST /message` - 推入消息
- `GET /status` - 查询激活 adapter 和队列状态
- `GET /health` - 健康检查

---

## 前端 UI 需求

### 整体布局

```
┌────────────────────────────────────────────────┐
│  标题栏（38px，可拖拽）                         │
│  左：✦ Jarvis  |  右：⚙ 设置 ─ ✕             │
├──────────────┬────────────────────────────────┤
│              │  工作目录栏（可隐藏）            │
│              │                                │
│   会话        │  消息区（主体）                 │
│   侧边栏      │  （滚动显示对话历史）           │
│   （220px）   │                                │
│              │                                │
├──────────────┼────────────────────────────────┤
│              │  输入框 + 发送按钮              │
└──────────────┴────────────────────────────────┘
```

### 会话侧边栏

**结构**（从上到下）：
1. "＋ 新建会话" 按钮
2. ★ 主会话
3. 微信会话列表（每条带 💬 WEIXIN 标记）
4. 分隔线
5. 普通会话列表（PC 临时会话）
6. 归档会话（可展开）

**会话条目**：
- 状态圆点（颜色表示活跃/非活跃）
- 会话名称
- 最后活跃时间戳
- 悬停显示归档按钮 🗂（非主会话）
- 微信会话显示锁定图标 🔒

**激活状态**：
- 左侧竖线高亮
- 条目背景高亮
- 主会话颜色区别

### 消息区

**消息类型和显示**：

| 类型 | 位置 | 样式 | 来源标记 |
|------|------|------|---------|
| 用户发送（PC） | 右对齐 | 深色气泡 | 无 |
| AI 回复（PC） | 左对齐 | 较深气泡 + 左侧竖线 | 无 |
| 用户发送（微信） | 右对齐 | 深色气泡 | 气泡上方小字 `[💬 weixin]` |
| AI 回复（微信） | 左对齐 | 较深气泡 + 左侧竖线 | 气泡上方小字 `[Jarvis → 💬 weixin]` |
| 工具调用 | 左侧 | 可展开折叠块 `▶ N 个工具调用` | 工具名 + 参数预览 |
| 错误 | 左对齐 | 红色边框 + ⚠️ 前缀 | 无 |
| 系统提示 | 居中 | 灰色胶囊 | 无 |

**自动滚动**：
- 新消息到达时自动滚动到底部

### 工作目录栏

**显示**：
- 当前会话绑定的工作目录（以标签形式）
- 每个标签可点击 ✕ 移除
- "＋ 添加目录" 按钮（弹出系统文件夹选择器）

**说明**：
- 默认显示
- 用户可隐藏（菜单选项）
- 主会话默认 `E:\Jarvis`

### 输入框

**样式**：
- 多行文本框，自适应高度（最高 120px）
- 占位提示：`输入消息，Shift+Enter 换行，Enter 发送…`
- 右侧发送按钮

**状态**：
- 正常：显示"发送"
- AI 处理中：显示"运行中…"，不可点击
- 微信会话只读：输入框禁用，显示提示条 "该会话只能通过 weixin 回复"

### 设置面板

从右侧滑入，overlay 覆盖对话区。内容：
- 当前模型（可点击编辑配置文件）
- 权限模式（下拉选择）
- 记忆事件日志（最近 20 条）
- 累计轮次/成本

---

## 前端对话逻辑统一需求

### 功能需求 1：统一事件入口

**需求**：
- PC 主会话有多个 IPC 事件：`onStreamText()`, `onStreamTool()`, `onMemoryEvent()`, `onResult()`
- Bridge adapter 有单一的 WebSocket 事件：`onBridgeEvent()`
- 这两套事件系统需要统一成一个前端消息处理入口

**功能**：
- 自动检测环境（PC IPC 还是 Bridge WS）
- 将两套完全不同的事件系统转换为统一的消息格式
- 提供单一的消息监听接口给应用层

**输入**：
- PC IPC 事件：多个 onXxx 回调
- Bridge WS 事件：单一的 onBridgeEvent 回调

**输出**：
- 统一的消息对象，所有消息都包含：
  - `type`（user, assistant, tool, thinking, error, system）
  - `text`（内容）
  - `source`（来源：pc-main, weixin, qq 等）
  - `metadata`（可选元数据：name, input, from, cost, turns, timestamp 等）

### 功能需求 2：统一消息状态管理

**需求**：
- 目前消息状态分散在 `sessionMessages Map` 和手动的 `recordMessage()` 调用
- 需要统一维护所有来源（PC 和 Bridge）的消息状态

**功能**：
- 维护 `Map<sessionId → Message[]>` 的消息缓存
- 支持会话切换，自动从磁盘加载历史
- 新消息到达时自动记录到内存和磁盘
- 支持临时会话（`__new__`）升级为真实会话
- 提供接口：获取当前会话 ID、获取历史、切换会话

**存储**：
- 内存：`Map<sessionId, Message[]>`
- 磁盘：通过现有 IPC 调用 `window.jarvis.appendSessionMessage(sessionId, message)`

**支持的操作**：
- 记录消息到当前会话
- 切换到指定会话并加载历史
- 获取当前会话的完整消息列表
- 处理临时会话升级

### 功能需求 3：统一消息渲染

**需求**：
- 目前有多套独立的渲染函数（PC 端和 Bridge 端各一套），导致样式和交互逻辑无法复用
- 需要一套统一的渲染系统，使修改自动应用于所有来源的消息

**功能**：
- 支持所有消息类型（user, assistant, tool, thinking, error, system）
- 所有消息使用统一的 CSS 类名系统
- 工具调用和思考过程与 assistant 消息关联显示（可展开折叠块）
- 每条消息的 DOM 元素标记来源（用于调试和样式差异化）
- 修改任何渲染逻辑后，所有来源的消息同步应用

**消息统一数据格式**：
```javascript
{
  type: 'user' | 'assistant' | 'tool' | 'thinking' | 'error' | 'system',
  text: string,
  source: 'pc-main' | 'weixin' | 'qq' | ...,
  metadata: {
    name?: string,           // 工具名称
    input?: object,          // 工具参数
    from?: string,           // 用户来源
    cost?: number,           // token成本
    turns?: number,          // 轮次
    timestamp?: string       // 时间戳
  }
}
```

**关键要求**：
- 一套渲染逻辑支持所有消息类型和来源
- 所有 CSS 类名统一（不区分 PC vs Bridge）
- 无论消息来自 PC 还是 Bridge，视觉效果和交互完全一致
- 工具调用收进折叠块，与 assistant 消息关联

### 功能需求 4：应用层集成

**需求**：
- 应用层（app.js）需要能够与统一的对话逻辑交互

**功能**：
- 应用层能发送用户消息（触发 Agent 处理）
- 应用层能接收和显示 Agent 结果
- 应用层能切换会话和加载历史
- 应用层的原有功能（权限、会话、输入处理等）保持不变

**交互方式**：
- 用户输入 → 统一接口记录消息 → Agent 处理 → 统一接口接收结果 → DOM 渲染
- 会话切换 → 统一接口加载历史 → DOM 重新渲染

---

## 现有实现清单

### 已实现的功能

**后端**：
- ✅ Electron 主进程 IPC 处理（send-message → Agent）
- ✅ Bridge Server（HTTP 7779 + WS 7780）
- ✅ 单激活 adapter + 消息队列 + 超时释放
- ✅ 微信 iLink adapter（长轮询）
- ✅ 锚会话管理（独立 cwd）
- ✅ 权限体系（isMain 权限控制）
- ✅ 长期记忆系统（long-term.jsonl + config/global.md）

**前端**：
- ✅ UI 布局（标题栏、侧边栏、消息区、输入框）
- ✅ PC 主会话消息发送和接收
- ✅ PC 临时会话新建、切换、归档
- ✅ 工作目录管理（绑定、移除、显示）
- ✅ 设置面板（模型选择、权限模式、记忆日志）
- ✅ PC 端消息渲染（用户气泡、AI 气泡、工具调用、错误等）
- ✅ 会话列表刷新和排序

**Bridge 前端集成**（部分）：
- ✅ Bridge 事件监听（IPC 转发 WebSocket 事件）
- ✅ Bridge 消息显示（带来源标记）
- ⚠️ Bridge 消息渲染与 PC 端不一致（需统一）

### 未实现的功能

**需要新增**：
- 统一事件入口（将 PC IPC + Bridge WS 转换为一套消息处理）
- 统一消息状态管理（替代分散的 recordMessage 和 sessionMessages）
- 统一消息渲染（替代多套独立的渲染函数）
- PC 和 Bridge 消息样式统一（CSS 类名、渲染逻辑）

**未来规划（不在本次范围）**：
- QQ adapter
- 邮件 adapter
- 记忆权限限制（只读共享）
- 多用户权限控制
- AI 思考过程显示

