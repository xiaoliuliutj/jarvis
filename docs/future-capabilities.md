# Jarvis 后续能力扩展计划

当前架构以 [REQUIREMENTS.md](../REQUIREMENTS.md) 为准。

## 1. Bridge Server（消息桥接层）

### 状态
- [x] Bridge Server（localhost HTTP/WS）
- [x] 微信 adapter
- [x] principal / 每用户会话 / 调度器 / cron
- [ ] QQ adapter
- [ ] 邮件 adapter

---

## 2. 图像生成能力

Claude 本身不支持图像生成，通过 MCP 工具接入外部模型。
**实现方式：让 Jarvis 自己写工具（调用 `_meta__create_tool`）。**

### 在线 API 方案

| 服务 | 能力 | 计费 | 适用场景 |
|---|---|---|---|
| **fal.ai** | FLUX、图生图、视频 | 按次，便宜 | 推荐首选 |
| **Replicate** | 几乎所有开源模型 | 按次 | 模型最全 |
| **Stability AI** | SD 系列 | 按次，有免费额度 | 经典选择 |
| **智谱 CogView** | 文生图，中文理解好 | 按次 | 国内使用 |

### 本地模型方案（需要 GPU）

| 服务 | 接入方式 | 说明 |
|---|---|---|
| **Stable Diffusion WebUI** | `localhost:7860` REST API | 最成熟，插件丰富 |
| **ComfyUI** | WebSocket API | 工作流更灵活 |

### 待决策
- [ ] 在线 API 还是本地模型？（有无 GPU）
- [ ] 首选服务商
- [ ] 让 Jarvis 自动生成工具代码

---

## 3. 视频生成能力

同样通过 MCP 工具接入，让 Jarvis 自己写工具。

### 在线 API 方案

| 服务 | 能力 | 计费 | 适用场景 |
|---|---|---|---|
| **fal.ai** | CogVideoX、Kling、HunyuanVideo | 按次 | 推荐首选，模型多 |
| **可灵（快手）** | 文生视频、图生视频 | 按次 | 国内，效果好 |
| **Runway ML** | 文生视频、图生视频 | 月费 | 商业质量 |
| **Vidu** | 文生视频 | 按次 | 国内 |

### 待决策
- [ ] 主要需求：文生视频还是图生视频？
- [ ] 首选服务商
- [ ] 让 Jarvis 自动生成工具代码

---

## 4. 其他潜在能力扩展

### 语音
- **语音转文字**：Whisper（本地）或 AssemblyAI（在线）
- **文字转语音**：Edge TTS（免费）、ElevenLabs（高质量）

### 数据与文档
- **搜索增强**：接入 Perplexity API 或 Brave Search API，提升 WebSearch 质量
- **PDF/Office 处理**：Claude Agent SDK 已内置，无需额外接入

### 智能家居 / IoT
- **Home Assistant** MCP 工具：控制家居设备
- **MQTT**：通用 IoT 协议

### 个人账号接入
- **Gmail / Outlook**：OAuth + Gmail API，读取/发送邮件
- **手机通知**：iOS 快捷指令 / Android Tasker → 本地 HTTP
- **企业微信**：官方 API，稳定
- **个人微信**：风险较高（封号风险），暂不推荐

---

## 实现原则

所有能力扩展都通过 **MCP 工具系统** 接入，不修改 Jarvis 核心代码：

1. 确定 API/服务
2. 告诉 Jarvis："帮我创建一个 XXX 工具，调用 YYY API"
3. Jarvis 调用 `_meta__create_tool` 自动写代码、注册、热加载
4. 立即可用
