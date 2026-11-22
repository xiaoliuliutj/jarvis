# Jarvis 手机 App（安卓 Demo）

不经过微信，直接连本机 Bridge 的手机端入口。当前是 **Demo 级**：手机浏览器/PWA + 安卓 WebView 壳，先验证「自有 App」的体验和链路，后续再考虑原生 UI、推送和多用户。

```
app/
  web/        移动端聊天页（PWA，Bridge 的 app adapter 直接托管）
  android/    安卓 WebView 壳（Android Studio 工程，Java）
```

## 架构

```text
安卓 App / 手机浏览器
        │  HTTP + WebSocket（token 鉴权）
        ▼
bridge/adapters/app.mjs（独立端口，默认 0.0.0.0:17779）
        │  onMessage（复用 Bridge 的 routeIncoming）
        ▼
principal（当前映射到 owner：user_1efb13a1ec）
        ▼
ConversationService / 工具链 / 记忆 / 工作区
        │
        └─ 回复经 adapter.send / sendFile 推回手机
```

- App 与微信是**两个 adapter**，共用同一套 principal、会话、记忆和权限。
- 微信照常可用；App 只是多了一个入口。
- 身份映射：`config/principals.json` 里 owner 的 `accounts` 增加了
  `{ "sourceType": "app", "accountId": "default", "externalUserId": "owner" }`；
  `core/principals.mjs` 的 `resolvePrincipal` 现在会匹配 `accounts` 数组。

## 启用步骤

1. 确认 `config/bridge.json` 中 `adapters.app.enabled = true`（默认已加好）：
   ```json
   "app": { "enabled": true, "accounts": ["default"], "port": 17779, "host": "0.0.0.0" }
   ```
2. 重启 Bridge（**会短暂中断当前微信会话**，建议没在聊天时操作）。
3. 查看访问令牌：`userdata/app-adapter/token.txt`（首次启动自动生成）。
4. 手机和电脑连同一个 Wi-Fi，浏览器打开：
   `http://<电脑局域网IP>:17779`
   - Windows 防火墙需要放行 17779（首次运行 Bridge 时可能弹窗，选择允许）。
   - 如果想用 App：Android Studio 打开 `app/android` 构建安装，填写同样的地址和 token。
5. 在页面「设置」里填入地址和 token，即可开始聊天。

> 电脑 IP 可用 `ipconfig` 查看（IPv4 地址，通常 192.168.x.x）。

## API（Demo）

鉴权：`Authorization: Bearer <token>`，文件下载用 `?token=`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 移动端聊天页 |
| GET | `/health` | 健康检查（免鉴权） |
| POST | `/api/message` | `{ text, attachments?: [{ fileName, kind, dataBase64 }] }` |
| GET | `/api/file/:id` | 下载 Jarvis 发来的文件（暂存 7 天 / 最多 100 个） |
| WS | `/ws?token=&device=` | 接收 `assistant` / `file` / `hello` 事件 |

限制：单条消息 20000 字；单附件 8MB、最多 3 个；每设备 30 条/分钟；WS 离线时内存队列保留最近 50 条。

## 安全边界（重要）

- 只适合**家庭局域网** Demo。当前是 HTTP + Bearer token，**不要直接映射到公网**。
- 后续做公网访问时，必须加：反向代理 HTTPS、独立鉴权、限流、审计日志，或走 Tailscale/Cloudflare Tunnel 之类的隧道。
- token 存在 `userdata/app-adapter/token.txt`（已在 gitignore 的 userdata 下），不要发到公开群里。
- App 端发来的文件走 Bridge 现有的收件箱落盘和 30 天清理策略。

## 安卓壳

- 位置：`app/android/`，Java + 平台 WebView，无第三方依赖（不需要 AndroidX）。
- `compileSdk 34`、`minSdk 24`；`usesCleartextTraffic=true` 仅为局域网 http Demo。
- 首次打开填写「服务器地址 + token + 设备标识」，之后自动加载。
- 支持网页里的文件选择（`onShowFileChooser`）。
- 构建：Android Studio 直接 Open `app/android`；或机器上装好 JDK 17 + Android SDK 后 `gradle assembleDebug`。
  > 当前开发机未安装 Android SDK / JDK，所以本仓库只提供工程源码，未在本地编译 APK。

## 已知限制 / 下一步

- 无系统级推送：切到后台后收不到通知（需要 APNs/厂商推送或长连接保活）。
- 会话历史只存在手机本地（localStorage）；跨设备/与微信不同步。
- 只映射了 owner；多用户（家人）需要增加 principal 和登录体系。
- 暂不支持语音/视频消息（可复用现有文件通道逐步加）。
- 建议路线：PWA 验证 → 原生 UI（可选）→ 推送 → 隧道与 HTTPS → 多用户。
