# Jarvis Bridge Server 技术方案

## 目标

构建一个统一的消息桥接层，让任意外部数据源（微信、QQ、邮件等）都能与 Jarvis 锚会话双向通信，并在 Electron 界面实现跨数据源的消息同步展示。

## 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│  Electron 主进程 (electron/main.js)                              │
│  ┌────────────────────────┐    ┌───────────────────────────┐    │
│  │ 现有 IPC 链路（保留）    │    │ 新增：spawn bridge 子进程  │    │
│  │ send-message → agent   │    │ + WebSocket 客户端(7780)  │    │
│  │ (cwd = E:\Jarvis)       │    │ → 转发 bridge 事件给渲染层 │    │
│  └────────────────────────┘    └───────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              ↑ WS 7780 (订阅广播)
┌─────────────────────────────────────────────────────────────────┐
│  Bridge Server (独立进程, node bridge/server.mjs)                │
│                                                                  │
│  HTTP 7779 — 外部消息入口、管理 API                               │
│  WS   7780 — 广播事件流（工具调用、结果、状态变化）                 │
│                                                                  │
│  adapter-manager: 单激活 adapter + 超时自动释放 + 消息队列          │
│  anchor-session:  每 adapter 专属 cwd，独立会话空间                │
│                                                                  │
│  adapters/weixin.mjs  ← iLink 长轮询收发消息                     │
└─────────────────────────────────────────────────────────────────┘
```

## 核心设计决策

### 锚会话（Anchor Session）vs 临时会话

| | 锚会话 | 临时会话 |
|---|---|---|
| 创建方式 | 每个 adapter 专属，第一次发消息自动创建 | 用户在 Electron 里手动新建 |
| 会话隔离 | 不同 adapter 用不同 `cwd`，`cwdHash` 天然隔离 | 同 `cwd` 下按 `sessionId` 区分 |
| 生命周期 | 持久，Bridge Server 重启后自动 resume | 可归档 |

### Adapter 并列关系

所有 adapter 是**并列关系**，不是层级关系：

- **`main` adapter = Electron（PC）**：由 Electron 直接驱动，`cwd = E:\Jarvis`，`isMain: true`
- **`weixin` adapter**：由 Bridge Server 驱动，`cwd = E:\Jarvis\bridge\sessions\weixin`，`isMain: true`

每个 adapter 的锚会话独立维护消息历史，互不干扰。单激活机制仅约束外部 adapter（如 weixin）之间的并发，Electron 本地会话不受单激活限制。

### 权限：所有 adapter 锚会话等同主会话

`agent.run()` 的 `isMain` 参数决定写权限范围：
- `isMain: true` → 整个工作空间可写，Jarvis 代码目录需确认，工作空间外询问
- `isMain: false` → 只能写 defaultworkspace 和绑定的 workDirs

**所有 adapter 锚会话统一用 `isMain: true`**（在 `config/bridge.json` 的每个 adapter 里配 `"isMain": true`），与 Electron 主会话权限完全一致。这样微信用户能让 agent 读写整个 Jarvis 目录，和 PC 端体验一致。

### 单激活 adapter

同一时间只有一个 adapter 处于激活状态。消息到来时：
- 若无激活 adapter → 立即激活并运行
- 若当前 adapter 正在处理 → 排队（FIFO）
- 若不同 adapter 发来消息 → 排队，等当前结束后按先来先服务处理

超时自动释放：5 分钟（可配 `inactivityTimeoutMs`）无活动后释放激活权。

### 只读共享记忆（Phase 2）

Electron 是"记忆权威源"，外部 adapter 只读长期记忆。Phase 1 暂不限制（影响小）。

## 文件结构

```
E:\Jarvis\
├── config\
│   ├── agent.json         ← Agent 配置（API Key、模型、effortLevel）
│   ├── bridge.json        ← adapter 配置（token、permissionMode、crons）
│   ├── workspace.json     ← 工作目录列表
│   └── global.md          ← 全局记忆/行为设定（仅用户可改）
└── bridge\
    ├── server.mjs         ← HTTP(7779) + WS(7780) 主进程
    ├── adapter-manager.mjs ← 单激活 + 超时 + 消息队列
    ├── anchor-session.mjs ← 每 adapter 专属 cwd 管理
    ├── start-bridge.ps1   ← Windows Task Scheduler 启动脚本
    ├── adapters/
    │   └── weixin.mjs     ← 微信 iLink adapter（长轮询）
    └── sessions/
        └── weixin/        ← weixin 锚会话 cwd（个人数据，不纳入版本控制）
```

## 统一消息格式

```json
{
  "adapterId": "weixin",
  "from": "用户ID",
  "text": "消息内容",
  "attachments": [],
  "timestamp": "ISO8601"
}
```

## HTTP API（端口 7779）

```
POST /message        推入消息，立即返回 { ok, messageId, status:'running'|'queued' }
GET  /status         当前激活 adapter、各队列长度
GET  /health         存活检查
```

## WebSocket 广播事件（端口 7780）

```json
{ "type": "incoming",  "adapterId": "weixin", "payload": {...} }
{ "type": "active",    "adapterId": "weixin" }
{ "type": "queued",    "adapterId": "weixin", "position": 1 }
{ "type": "tool",      "adapterId": "weixin", "name": "...", "input": {...} }
{ "type": "result",    "adapterId": "weixin", "from": "...", "text": "...", "cost": 0, "isError": false }
{ "type": "released",  "adapterId": "weixin", "reason": "timeout|queue-empty|manual" }
{ "type": "ready" }
```

## 微信 adapter（iLink）

- **协议**：iLink Bot API（`https://ilinkai.weixin.qq.com`），腾讯官方个人 Bot API
- **接收**：长轮询 `POST /ilink/bot/getupdates`，服务器 hold 最多 35 秒，有消息立即返回
- **发送**：`POST /ilink/bot/sendmessage`，需 echo back `context_token`
- **登录**：`node bridge/adapters/weixin.mjs login` 扫码，token 自动写入 `config/bridge.json`
- **session 过期**：-14 错误时，server 自动触发重新登录流程（终端打印新二维码 URL）

## 网络要求与限制

### 不需要

- ❌ 手机和 PC 在同一局域网
- ❌ 公网 IP、frp、ngrok、webhook
- ❌ 微信号本体登录状态不受影响（bot 是独立账号）

### PC 需要

- ✅ 能访问外网（连接腾讯 iLink 服务器和 Claude API）
- ✅ 保持开机（Task Scheduler 开机自启，见下）

### 断网/切网络行为

PC 切换网络（换 Wi-Fi、拔网线）时，当前长轮询请求失败，循环自动重试（5 秒退避）。
下一条消息正常处理，**不需要手动重连**。

### 休眠/合盖行为

进程被挂起，唤醒后轮询恢复。若休眠时间较长导致 iLink session 超时（-14），
Bridge Server 自动打印新的二维码 URL，扫一次即可恢复。查看日志：
```
Get-Content E:\Jarvis\bridge\bridge.log -Tail 20
```

### 离线期间消息

iLink **没有离线消息队列**。Bridge Server 不运行期间，微信用户发来的消息会丢失。
如需减少丢消息，配置 Task Scheduler 任务在登录后自动启动。

### 封号风险

iLink 是腾讯官方接口，比 hook 方案安全，但属于相对较新的 API，存在政策变更风险。

## 开机自启（Windows Task Scheduler）

已注册任务 `Jarvis-BridgeServer`：
- 触发器：用户登录时
- 失败重试：每 1 分钟，最多 3 次
- 日志：`E:\Jarvis\bridge\bridge.log`

管理命令：
```powershell
Start-ScheduledTask   -TaskName 'Jarvis-BridgeServer'   # 手动启动
Stop-ScheduledTask    -TaskName 'Jarvis-BridgeServer'   # 手动停止
Get-ScheduledTask     -TaskName 'Jarvis-BridgeServer'   # 查看状态
Unregister-ScheduledTask -TaskName 'Jarvis-BridgeServer' # 删除任务
```

## 实现路线图

### Phase 1（已完成）
- [x] Bridge Server HTTP + WebSocket 骨架
- [x] 单激活 adapter + 超时释放 + 消息队列
- [x] 锚会话（每 adapter 独立 cwd，重启后 resume）
- [x] 微信 iLink adapter（长轮询收消息 + 发消息）
- [x] 开机自启（Task Scheduler）

### Phase 2（前端同步）
- [ ] `electron/main.js` spawn Bridge Server 子进程
- [ ] Electron WebSocket 客户端订阅 7780 广播
- [ ] `renderer/app.js` 展示外部消息（带来源标记 `[微信]`）

### Phase 3（扩展）
- [ ] 只读共享记忆（外部 adapter 只读 long-term.jsonl）
- [ ] QQ adapter（NapCat OneBot v11）
- [ ] 邮件 adapter
- [ ] 多用户权限控制（allow_from 白名单）

## 参考

- iLink 协议文档：https://github.com/epiral/weixin-bot/blob/main/PROTOCOL.md
- 微信 iLink Client：https://github.com/photon-hq/wechat-ilink-client
- cc-connect（参考实现）：`npm install -g cc-connect`
