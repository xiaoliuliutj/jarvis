# Jarvis App 产品方案 v1

> 状态：产品设计稿（2026-11-25）
> 当前阶段：App 仅作测试/备用客户端，微信端是正常使用的主渠道。
> 原则：微信端天然 owner；App 的 owner 令牌只用于测试。App 记录与微信记录隔离，不混写。

---

## 0. 定位与边界

- **微信端**：正常使用渠道，天然 owner，不需要令牌；提醒、日程、日常对话以微信为主。
- **App 端**：测试/备用客户端。App 功能健全前，不接管正常使用；App 的 owner 令牌只用于测试 owner 能力。
- **数据**：App 和微信使用不同 principal / 会话；App 的测试消息不写进微信记录。
- **内核**：现有 Jarvis 内核保持稳定；App 通过 Bridge 的 App adapter 接入，后续再演进数据/控制面。
- **目标**：把 App 做成「会话 + 工具 + 用量 + 设置」的移动管理台，而不是第二个微信。

---

## 1. 信息架构

底部四个页签：

1. **会话**：默认直接读取当前会话，不做独立历史页。
2. **工具**：我的工具 / 全部工具，搜索、图标、配置、外部 SDK。
3. **用量**：自己的 token 用量、费用、LLM 调用记录。
4. **设置**：账号令牌、Owner 令牌、模型 API、外部服务、通知、外观、关于。

顶部状态栏：连接状态、当前模型、测试模式标识、Owner 标识（如启用）。

---

## 2. 会话

### 2.1 展示方式

- 打开 App 直接进入**当前会话**，自动拉取最近消息，不做「历史消息」独立页。
- 下拉刷新；上滑加载当前会话更早的消息（属于当前会话滚动，不是历史功能）。
- 不提供会话列表、归档、搜索历史；需要换会话时在设置里「新会话/清空当前会话」。
- 消息实时通过 WS 推送；断线自动重连；重连后补拉当前会话。

### 2.2 消息类型

- 文字、图片、视频、语音、文件。
- 图片：相册/拍照，缩略图、点击预览、保存。
- 视频：相册/拍摄，封面、时长、播放、压缩上传。
- 语音：按住录音、波形/时长、播放、可选转文字。
- 文件：任意类型，文件卡片，下载/打开/分享。
- 工具调用卡片：工具名、图标、状态、结果摘要；高风险工具显示审批卡片。
- 系统提示：连接、错误、重试、测试模式提示。

### 2.3 发送与状态

- 附件托盘：拍照、相册、文件、语音。
- 上传进度、发送中/已发送/失败/重试；失败可重发。
- 单条文本上限、附件数量/大小上限；图片/视频自动压缩，原图可选。
- 离线队列：无网时排队，恢复后发送。
- 消息去重、幂等 ID，避免重连重复。

### 2.4 媒体与安全上下文

- 语音/摄像头在 WebView 中需要 **HTTPS 安全上下文**；建议用 Tailscale Serve 提供 `https://<node>.ts.net`，或走原生 Android 桥。
- 媒体存储在用户隔离目录；下载使用短期签名 URL；不做跨用户访问。
- 语音转文字、视频转码作为可选能力，由用户配置的模型/服务提供。

---

## 3. 设置

设置是**所有配置的唯一入口**（工具详情里的「配置」也跳回这里对应的分区）。

### 3.1 账号与安全

- 用户资料：昵称、头像、显示名。
- **访问令牌**：App 连接令牌（每设备/每用户），掩码显示，轮换、吊销。
- **Owner 令牌**：仅 owner 可生成/使用；掩码显示，轮换；仅用于 App 测试 owner 能力；微信端不依赖它。
- 设备管理：设备列表、最后在线、解绑；扫码配对（后续）。
- 退出登录/清除本机数据。

### 3.2 模型与能力

按能力分区，每个用户独立配置：

- **对话 LLM**：provider、base URL、API Key、模型名、温度、最大 token、超时、重试、fallback。
- **图片模型**：provider、Key、模型、尺寸、风格、数量。
- **视频模型**：provider、Key、模型、时长、分辨率。
- **语音模型**：TTS/STT、Key、音色、语言。
- **Embedding/RAG**（可选）：provider、Key、模型、知识库。
- 每个能力：启用开关、测试连接、设为默认、优先级/fallback、预算上限。
- 密钥只显示「已配置/掩码」；服务端加密存储，绝不下发明文、不进日志/prompt。
- 支持 OpenAI-compatible、Anthropic、Google 等预设；允许自定义 base URL。

### 3.3 工具与外部服务

- 外部 API Key：高德地图、天气、日历、邮件等；按工具展示所需配置。
- 原生能力权限：通知、闹钟、定位、相机、麦克风、通讯录（按需）。
- 每个外部服务有启用开关、权限说明、风险等级、测试按钮。

### 3.4 通知与外观

- 本地通知/推送开关；免打扰；提醒声音。
- 深色/浅色、字号、语言；测试模式标识。

### 3.5 关于与诊断

- 版本、连接信息、日志导出（脱敏）、帮助/反馈。
- 当前套餐/额度（后续）。

---

## 4. 工具管理

### 4.1 列表

- 两个视图：**我的工具**（我创建/我启用）、**全部工具**（系统+用户+外部）。
- 搜索：名称、描述、标签、分类。
- 每个工具卡片：图标、名称、来源徽标、风险等级、启用状态、一句话描述、最近使用。
- 分类：系统工具、我的工具、外部服务、手机原生能力、MCP。

### 4.2 工具详情

- 描述、输入/输出 schema、示例。
- 来源/版本/权限/风险。
- 配置：API Key、参数、默认值（跳转设置对应分区）。
- 启用/禁用、测试运行、最近调用记录、使用次数。
- 删除（仅自己创建的工具）；系统工具只读。

### 4.3 图标

- 工具注册表增加 `icon` 字段：emoji、SVG、URL 或首字母兜底。
- 列表/详情/消息卡片统一使用同一图标。

### 4.4 外部 SDK / 服务

- **手机原生能力**：闹钟、通知、定位、相机/麦克风、分享；Android 原生桥接（JS Bridge），权限逐项申请。
- **高德地图**：REST API/MCP + Key；地点搜索、路线、导航深链。
- **日历/提醒**：系统日历或 Jarvis 日程；读写权限。
- **其他**：天气、邮件、智能家居等，按工具注册表接入。
- 高风险动作（拨号、付款、删除、定位上报）必须二次确认。

---

## 5. Token 与调用管理

> 这里的「Token」指 LLM/媒体模型的用量，不是访问令牌。

### 5.1 概览

- 今日/本月：输入 token、输出 token、总费用、调用次数、成功率、平均延迟。
- 按模型/能力（对话/图片/视频/语音）拆分。
- 预算/额度进度条；超限提醒。

### 5.2 调用记录

- 时间、模型、provider、输入/输出 token、费用、延迟、工具调用、状态、会话/任务。
- 图片/视频生成记录：数量、尺寸、费用。
- 筛选：日期、模型、能力、状态；导出 CSV。
- 只展示自己的记录；owner 可看聚合（不读其他用户私密内容）。

### 5.3 数据与计费

- 每次模型调用落 `usage_records`；provider 返回 usage 优先，缺失时估算。
- 价格表可配置；费用按用户/模型/任务归因。
- 失败/重试去重；缓存命中单独标记。

---

## 6. 外部 SDK 与工具的结合

- 所有外部能力统一抽象为**工具**：名称、图标、schema、权限、配置、风险。
- App 原生桥负责手机能力；Bridge 工具层负责服务端/外部 API；MCP 作为扩展协议。
- 工具配置与密钥集中在设置；工具详情只展示「需要配置」并跳转。
- 权限模型：首次使用弹窗说明；可随时关闭；敏感权限单独确认。
- 外部 SDK 的可用性受平台限制：Android 先做，iOS 后续；Web/PWA 仅支持浏览器能力。

---

## 7. 架构与 API

### 7.1 链路

```
App (PWA/Android)
  │ HTTPS + WS（access token / owner token / clientId）
  ▼
Bridge App Adapter (/api/v1)
  │ 会话、消息、上传、工具、设置、用量
  ▼
Jarvis 内核（Agent / 工具 / 模型网关）
  │
  ├─ 模型 provider（对话/图片/视频/语音）
  ├─ 工具注册表（系统/用户/外部/原生）
  └─ 用户数据（隔离）
```

### 7.2 关键数据模型

- `users`：id、displayName、role、status。
- `devices`：id、userId、name、clientId、tokenHash、lastSeen、revoked。
- `sessions` / `messages`：按 user 隔离；消息含 type、content、attachments、status、clientMsgId。
- `attachments`：id、userId、mime、size、storageKey、thumbKey、createdAt。
- `model_configs`：userId、capability、provider、baseUrl、model、params、enabled、priority。
- `secrets`：userId、name、ciphertext、provider；只写不读。
- `tools`：id、name、icon、category、source、version、schema、risk、permissions。
- `tool_configs`：userId、toolId、enabled、config、secretRefs。
- `usage_records`：userId、sessionId、turnId、capability、model、inputTokens、outputTokens、cost、latency、status、createdAt。
- `audit_logs`：userId、action、target、result、createdAt。

### 7.3 API 草案

- `POST /api/v1/auth/pair`：扫码/令牌配对。
- `GET /api/v1/me`：用户、角色、测试模式。
- `GET /api/v1/session/current`、`GET /api/v1/session/messages`、`POST /api/v1/session/messages`、`WS /api/v1/ws`。
- `POST /api/v1/uploads`：媒体上传，返回 attachment id。
- `GET/PUT /api/v1/settings`；`GET/PUT /api/v1/settings/models`；`POST /api/v1/settings/models/test`。
- `GET /api/v1/tools`、`GET /api/v1/tools/:id`、`PUT /api/v1/tools/:id/config`、`POST /api/v1/tools/:id/enable`。
- `GET /api/v1/usage/summary`、`GET /api/v1/usage/records`。
- `GET /api/v1/devices`、`DELETE /api/v1/devices/:id`。

### 7.4 返回路由

- 不用客户端自报的 `device` 作为回复路由 key。
- App 连接 WS 时服务端下发 `clientId`；后续请求带 `X-Client-Id`；Bridge 按 `clientId` 回复。
- `device` 只做测试用户/设备展示，不决定路由和 owner。

---

## 8. 安全与权限

- **微信端天然 owner**；App 的 owner 令牌只用于测试，不改变微信权限。
- 访问令牌、owner 令牌、模型 Key 均掩码显示；服务端加密；不进日志、不进 prompt。
- 每用户数据隔离；owner 也不能读其他用户的会话/记忆。
- 工具风险分级；高风险动作二次确认；外部 SDK 权限逐项授权。
- 设备配对、令牌轮换、远程吊销；审计关键操作。
- 频率限制、附件大小限制、模型预算限制。
- App 测试模式：显式标识，避免误当正式渠道。

---

## 9. 分阶段

### P0（测试阶段，先能用）

- 去掉独立「历史」页，打开即当前会话。
- 设置：访问令牌、Owner 令牌、基础 LLM 配置。
- 工具：列表、图标、搜索、启用/禁用（只读配置）。
- 用量：今日/本月概览 + 最近调用。
- 消息：文字、图片、文件；发送状态/重试。
- App 记录与微信隔离；测试模式标识。

### P1（可日常测试）

- 语音、视频；HTTPS/Tailscale Serve 或原生媒体桥。
- 每用户模型 API：对话/图片/视频；测试连接。
- 工具配置、外部 API Key、工具详情。
- 用量明细/筛选/导出；预算提醒。
- clientId 路由；设备列表/扫码配对。

### P2（可独立使用）

- 原生 SDK：闹钟、通知、定位、高德地图、日历。
- 多用户/额度/审计；工具市场；版本化。
- 推送、后台任务、离线增强。
- 安全加固、备份/恢复、发布流程。

---

## 10. 与当前实现的差距

- 当前 App：聊天/历史/设置三页，历史页需移除；`device` 作为路由 key，需改 clientId。
- 当前设置：只有访问令牌、Owner 令牌、连接信息；需扩展模型/工具/通知。
- 当前工具：注册表 JSON，无图标/搜索/用户配置；需补元数据与配置层。
- 当前用量：只有 turn cost；需 usage_records 与面板。
- 当前消息：文字、图片、文件；语音/视频/原生 SDK 未做。
- 当前鉴权：访问令牌 + owner 令牌；需设备配对/轮换。
- 当前数据：App 与微信已开始隔离；旧测试消息可能已混入微信会话，需要时可另开新会话。

---

## 11. 待确认

1. 语音/视频走 HTTPS（Tailscale Serve）还是 Android 原生桥？
2. 每用户模型 Key 由服务端代理调用，还是 App 直连 provider？建议服务端代理，便于计费/审计。
3. 工具市场是否允许用户发布工具？先只做自用/系统工具。
4. Owner 令牌的生成入口放在 App 设置还是 PC 管理台？
5. App 正式接管前，提醒是否始终微信优先？（当前是微信优先）
