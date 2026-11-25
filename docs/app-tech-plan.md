# Jarvis App 技术实现方案 v1

> 配合《Jarvis App 产品方案 v1》
> 当前阶段：App 仅测试/备用；微信是正常使用主渠道、天然 owner。
> 目标：先落地 P0（会话、设置、工具、用量、媒体、存储/API），P1/P2 再补原生 SDK 与完整音视频。

---

## 1. 范围与约束

- 复用现有身份、会话、记忆、工作区、权限、工具注册表，不新建用户系统。
- App 数据放在 `userdata/<principalId>/app/`，与微信记录隔离。
- 微信端不依赖 App 的 owner 令牌；App 的 owner 令牌只用于测试。
- 先文件存储（JSON/JSONL），单 Bridge；规模上来再换 SQLite / 数据面。
- 不破坏现有微信链路；后端改动重启 Bridge 后生效。
- P0 不实现原生闹钟/高德 SDK、图片/视频模型实际路由；先做框架、配置和可见能力。

---

## 2. 总体架构

```text
App (PWA / Android WebView)
  │ HTTPS + WS（access token / owner token / clientId）
  ▼
Bridge App Adapter (/api/v1, /ws)
  │ 会话、消息、上传、工具、设置、用量、设备
  ▼
Jarvis 内核（conversation / tools / agent）
  │
  ├─ 模型（chat provider；图片/视频/语音配置先存后用）
  ├─ 工具注册表（系统/用户/外部/原生）
  └─ 用户数据（userdata/<id>/app）
```

### 2.1 复用边界

| 能力 | 复用 | 新增 |
|---|---|---|
| 身份/角色 | `principals.json`、`core/principals.mjs` | 无 |
| 会话/消息 | `core/user-store.mjs`、`core/conversation.mjs` | App 会话 API |
| 记忆/工作区 | `userdata/<id>/` | 无 |
| 权限 | `core/permissions.mjs` | 用户工具配置过滤 |
| 工具注册表 | `core/tools.mjs`、`agents/tools/` | 图标/搜索/用户配置 |
| 模型调用 | `agents/agent.mjs`、`core/config.mjs` | 每用户 chat 模型覆盖 |
| 日志 | `core/logger.mjs` | usage 记录 |
| App 接入 | `bridge/adapters/app.mjs` | `/api/v1`、上传、设置、工具、用量 |

---

## 3. 身份、鉴权与路由

### 3.1 身份

- **微信**：按微信号解析 principal，天然 owner；不需要令牌。
- **App**：按 access token + device 解析 App principal；App 测试身份独立。
- **Owner 令牌**：App 专用测试令牌，匹配时该 App principal 的回合以 owner 角色执行；不映射到微信 owner 会话。
- **用户访问令牌**：App 连接令牌；P0 沿用 App adapter 全局 token，P1 升级每设备 token hash。

### 3.2 路由（不做 device 硬路由）

- App WS 连接时服务端生成 `clientId`，随 `hello` 下发。
- App 后续 HTTP 请求带 `X-Client-Id`。
- Bridge 回复时用 `replyTo = clientId`；`device` 只做 App 测试身份/展示。
- 无 clientId 时回退 device（兼容旧 App）。
- `clientId` 只用于连接路由，不用于 owner 判断。

### 3.3 权限

- App principal 的回合权限 = 该 principal 的 role + owner token override。
- owner token 通过 → 该回合 `role=owner`、`editJarvisCode=true`；不改变持久 principal。
- 微信 principal 的 role 不变。
- 工具权限仍由 `core/permissions.mjs` 与 owner-access 工具规则控制。

---

## 4. 存储设计

### 4.1 目录

```text
userdata/<principalId>/
  persona.md / sessions/ / memory/ / workspace/ ...
  app/
    settings.json          # 非敏感设置、显示偏好、测试模式
    models.json            # 模型配置（不含 Key）
    tools.json             # 工具启用/参数
    devices.json           # clientId/device/lastSeen
    usage/YYYY-MM.jsonl    # 调用记录
    media/                 # 上传的图片/视频/语音/文件
userdata/_secrets/<principalId>.json  # AES-256-GCM 加密的 Key
config/app-secrets.key               # 主密钥（0600，Agent 文件工具不可读）
config/principals.json               # 身份/角色
```

### 4.2 文件格式

- JSON 原子写：临时文件 + rename；读失败返回默认值。
- usage JSONL 追加；按月分文件。
- 所有文件带 `version` 字段，便于迁移。
- Own user only；app adapter 通过 principalId 定位。

### 4.3 密钥

- AES-256-GCM：`{iv, tag, data}` base64；主密钥 32 字节。
- 首次加密时生成 `config/app-secrets.key`，0600；不打印、不写日志。
- `userdata/_secrets/` 不在 Agent 文件工具可访问的 ownRoot 内；`permissions.mjs` 增加 deny。
- App 只收「已配置/掩码」；API 不返回明文。
- 加密用于静态/备份保护；Agent 的 Bash 仍是信任边界，硬隔离留给后续沙箱。

### 4.4 数据模型

- `settings.json`：`{ version, displayName, testMode, notifications, appearance, updatedAt }`
- `models.json`：`{ version, models: [{ id, capability, name, provider, baseUrl, model, params, enabled, priority, hasKey, createdAt, updatedAt }] }`
- `tools.json`：`{ version, enabled: {toolId: bool}, config: {toolId: object} }`
- `devices.json`：`{ version, devices: { clientId: { id, deviceId, name, lastSeen } } }`
- `usage`：`{ id, ts, principalId, sessionId, source, capability, model, provider, inputTokens, outputTokens, cost, turns, latencyMs, status, tools }`
- `media`：`{ id, fileName, mime, size, storageKey, thumbKey?, createdAt }`（元数据可放 `media/index.json` 或每文件 sidecar）

---

## 5. 后端模块

新增：

- `core/app-settings-store.mjs`：settings 读写、默认值。
- `core/model-config-store.mjs`：models CRUD、Key 掩码、chat runtime 解析。
- `core/secrets-store.mjs`：AES-GCM、主密钥、set/get/delete。
- `core/usage-store.mjs`：append、summary、records。
- `core/tool-config-store.mjs`：启用/配置。
- `core/tool-catalog.mjs`：工具目录、图标、搜索、来源/风险。
- `core/device-store.mjs`：clientId/device 记录（P0 轻量）。

复用：`user-store`、`principals`、`permissions`、`tools`、`logger`、`paths`。

### 5.1 Chat 模型覆盖

`runTurn` 解析顺序：

1. 当前 principal 的 `models.json` 中 `capability=chat` 且 enabled 的模型；
2. 解密对应 Key；
3. 覆盖 `apiKey/baseUrl/authMode/model`；
4. 无配置则回退全局 `getAnthropicCredentials()` / `getModel()`。

图片/视频/语音模型 P0 只存配置与 UI，实际 provider 路由 P1 接入。

### 5.2 用量记录

- `runTurn` 结束后写 `usage`：cost/turns/status/model/session/source；有 `usage` 字段时记录 input/output tokens。
- `agents/agent.mjs` result 透传 SDK `usage`（若有）。
- App 的 usage 面板只读自己的记录。

### 5.3 工具目录

- 来源：`system`、`user`、`external`、`native`。
- 字段：id/name/description/icon/category/source/risk/access/enabled/configurable/available/tags。
- 系统工具图标映射；用户工具 manifest 可带 `icon`；未知用 🧰。
- `buildMcpServers` 过滤用户禁用的工具（P0 支持系统/用户工具启用开关）。
- external/native 先作为目录项显示（Amap、闹钟、通知、日历），标注「待接入」；不进入 MCP。

---

## 6. API 设计（/api/v1）

鉴权：`Authorization: Bearer <access token>`；owner 测试：`X-Owner-Token`；路由：`X-Client-Id`。

- `GET /api/v1/me` → `{ principalId, displayName, role, owner, testMode, device }`
- `GET /api/v1/session/current` → `{ session, messages, owner }`
- `POST /api/v1/session/message` → `{ text, attachmentIds? }`
- `POST /api/v1/upload`（binary；`X-File-Name`、`Content-Type`）→ `{ id, fileName, mime, size, url }`
- `GET /api/v1/media/:id`（token query 可）→ 文件流
- `GET /api/v1/settings` → settings + models（masked）+ toolConfigs 摘要
- `PUT /api/v1/settings` → 更新非敏感设置
- `GET /api/v1/settings/models`；`POST /api/v1/settings/models`；`PUT /api/v1/settings/models/:id`；`DELETE`
- `POST /api/v1/settings/models/:id/test` → 简单连通性测试（provider `/models` 或保存成功占位）
- `GET /api/v1/tools?q=` → 目录（含 enabled/accessible）
- `GET /api/v1/tools/:id` → 详情/schema/config
- `PUT /api/v1/tools/:id` → `{ enabled?, config?, secrets? }`
- `GET /api/v1/usage/summary?range=month` → 汇总
- `GET /api/v1/usage/records?limit=50` → 记录
- `GET /api/v1/devices` → 设备列表
- `WS /ws?token=&device=&ownerToken=` → hello `{ clientId, deviceId, owner }`；assistant/file/notice 事件

兼容：保留 `/api/history`、`/api/message`、`/api/file/:id` 旧接口，直到新 UI 切换完成。

---

## 7. App 前端

### 7.1 结构

- 底部四 Tab：会话 / 工具 / 用量 / 设置。
- 移除独立历史页；会话首屏自动读 `/api/v1/session/current`。
- 顶部：连接状态、当前模型、测试模式、Owner 标识。

### 7.2 会话

- 消息：文字/图片/视频/语音/文件；工具卡片；系统提示。
- 附件：拍照/相册/文件；上传 `/api/v1/upload`；发送 `attachmentIds`。
- 语音：MediaRecorder（HTTPS 或原生）；P0 先支持文件上传，录音按钮按安全上下文提示。
- 视频：文件上传/播放；P0 不压缩转码。
- 状态：发送中/失败/重试；自动重连；clientId 路由。

### 7.3 设置

- 连接：URL、设备、访问令牌、Owner 令牌、状态。
- 模型：列表 + 添加/编辑（能力、provider、baseUrl、model、apiKey、enabled）；保存后掩码；测试按钮。
- 工具服务：外部 API Key（P1）跳工具详情。
- 通知/外观/关于/测试模式。

### 7.4 工具

- 搜索；我的/全部；分类；卡片图标/来源/风险/开关。
- 详情：描述、schema、配置、启用、测试、最近调用（P1）。
- external/native 显示「待接入」。

### 7.5 用量

- 今日/本月 cards：调用数、token、费用、成功率、平均延迟。
- 简单柱状图（CSS）；记录列表；筛选/导出 P1。

---

## 8. 安全与权限

- 微信天然 owner；App owner token 仅测试；不映射微信会话。
- 访问令牌/owner token/模型 Key 均掩码；Key 加密、不进日志/prompt。
- `config/app-secrets.key`、`config/credentials.json`、`config/agent.json` 文件工具 deny。
- 每用户数据隔离；App/微信不同 principal、不同会话。
- 工具风险/权限；高风险二次确认（P1）。
- 上传大小/频率限制；媒体短期签名 URL。
- 审计关键设置/令牌/工具变更（P1）。

---

## 9. 分期与测试

### P0（本次实现）

- 四 Tab、无历史、会话自动读取。
- 后端 app-store（settings/models/secrets/tools/usage/devices/media）。
- 设置：连接/令牌/模型 CRUD/掩码；chat 模型覆盖。
- 工具目录/图标/搜索/启用；禁用工具从 MCP 过滤。
- 用量汇总/记录；runTurn 写 usage。
- 上传图片/视频/语音/文件；消息发送/显示；文件下载。
- clientId 路由；App/微信隔离。
- 测试：curl API、App 页面、发送各类型附件、重启首条消息。

### P1

- 图片/视频/语音模型实际 provider 路由；测试连接真实调用。
- 工具配置/外部 API Key；最近调用；风险审批。
- 用量筛选/导出/预算；设备 token 轮换/扫码配对。
- 语音录制（HTTPS/原生）、视频压缩/封面。

### P2

- Android 原生桥：闹钟、通知、定位、高德深链/地图、日历。
- 多用户/额度/审计；工具市场；推送；离线增强。

---

## 10. 实施检查表

- [ ] app-store + secrets + usage + tool catalog
- [ ] /api/v1 路由与 auth/clientId
- [ ] runTurn chat 模型覆盖 + usage
- [ ] buildMcpServers 工具禁用过滤
- [ ] App 四 Tab UI
- [ ] 上传/媒体/消息
- [ ] 设置/模型 CRUD
- [ ] 工具列表/搜索/详情/启用
- [ ] 用量面板
- [ ] 测试、重启、交付

---

## 11. 风险

- WebView 媒体/语音需要 HTTPS 或原生桥；P0 先文件上传，录音后续。
- 图片/视频模型 API 差异大；P1 用 provider adapter。
- 每用户 Key 的硬隔离受 Agent Bash 信任边界限制；P2 沙箱。
- 文件存储并发/备份；P1 SQLite 评估。
- 改动后需重启；重启首条消息已有重试/兜底。
