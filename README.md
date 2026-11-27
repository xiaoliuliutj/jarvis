# Jarvis

本机运行的个人 AI 助手：一个 PC 主维护会话，加上手机 App / 浏览器、微信等外部入口和多个独立用户。所有入口共用同一套 `ConversationService` / `agent.run`，区别只在 principal、权限和数据目录。

仓库：<https://github.com/xiaoliuliutj/jarvis>

完整实现基线见 [REQUIREMENTS.md](REQUIREMENTS.md)，产品与技术方案见 [docs/](docs/)。

## 功能

- **多入口聊天**：PC（Electron + React）、手机 App / 手机浏览器（PWA + 安卓壳）、微信（可选 adapter）
- **多用户隔离**：每个用户独立的人设、会话、长期记忆、工作区、定时任务、日程和文件
- **工具系统**：内置系统工具、用户自定义工具（`_meta` 创建、所有用户可用）、外接工具（安卓原生能力、第三方 MCP/HTTP）
- **安卓原生能力**：系统通知、闹钟静默创建/自动确认、定位、短信只读
- **日程与提醒**：日程提醒、定时任务（cron），支持按空闲时长触发的主动关心；提醒优先投递到 App（离线时排队、重连补发），App 不可用时回退微信
- **用量统计**：按轮/按次记录 token 用量，展示缓存读利用率，并按用户自填价格表估算费用
- **心情与人设**：`core/mood.mjs` 心情刻度、睡觉/打断结算；人设 Markdown 完全可改
- **文件收发**：收件箱自动解析 txt/md/docx/pdf/xlsx，发件箱自动发送；截图 7 天、收发归档 30 天清理
- **图片能力**：AI 插图 / 图生图、抽象表情包家庭共享库

## 架构

```text
Electron（PC，React + Vite）
        │
手机 App / 浏览器 ── Bridge Server ── 微信（可选 adapter）
        │                 │
        └─────────────┬───┘
                      ▼
            ConversationService
          （principal / 权限 / 人设 / 记忆 / 工具）
                      │
                      ▼
            Claude Agent SDK ── 模型（全局配置或每用户配置）
```

- 每个入口是独立 adapter（`bridge/adapters/app.mjs`、`weixin.mjs`），共用同一个 Bridge 和用户体系。
- 不建数据库，全部使用 JSON / JSONL；每用户数据在 `userdata/<principalId>/`，互不读取。

## 快速开始

```powershell
npm install
npm run dev
```

首次运行前要先初始化配置（仓库只保留 `*.example.*` 模板，缺少实际配置时 Bridge 会直接退出，手机端表现为白屏）：

```powershell
Copy-Item config/bridge.example.json config/bridge.json
Copy-Item config/agent.example.json config/agent.json
Copy-Item config/credentials.example.json config/credentials.json
Copy-Item config/principals.example.json config/principals.json
Copy-Item config/rules.example.md config/rules.md
```

然后按「配置」一节填写模型 Key；要用手机 App / 手机浏览器，还要把 `config/bridge.json` 里的 `adapters.app.enabled` 改成 `true`（示例模板默认是 `false`，不改 17779 端口不会监听）。

开发模式请用 `npm run dev`。如果直接运行 `npm start` 或 `electron .`，Vite 没启动时 Electron 会回退加载 `dist/index.html`；`npm start` 会先构建 dist。

`npm run dev` 由 [scripts/dev-supervisor.mjs](scripts/dev-supervisor.mjs) 托管 Vite + Electron：

- Electron 自重启时 Vite 不会退出
- 关闭窗口时一起退出，不留后台 Vite
- 控制端口只在 `127.0.0.1:7781`

微信等外部消息需要另外启动 Bridge：

```powershell
powershell -ExecutionPolicy Bypass -File bridge/start-bridge.ps1
```

Bridge 只绑定 `127.0.0.1`，HTTP `7779` / WS `7780`，`/health` 可做存活检查。

### 手机端

1. 在 `config/bridge.json` 中开启 `adapters.app`（默认端口 `17779`）。
2. 重启 Bridge 后，令牌在 `userdata/app-adapter/owner-token.txt`（自动生成，勿外传）。
3. 手机与电脑同一局域网，浏览器打开 `http://<电脑IP>:17779`，在「设置」里填地址和令牌。
4. 或用 Android Studio 打开 `app/android` 构建安装（当前版本 0.3.5）。

App 支持注册 / 登录（昵称 + 账号 + 密码，密码只存 scrypt hash，见 `userdata/_auth/`）；每个账号对应自己的 principal。owner 权限**只由 owner token 决定**，与账号的 ownerId 无关。

细节见 [app/README.md](app/README.md)。

## 目录

```text
config/                 实际配置（不入库，只保留 *.example.* 模板）
  agent.json            全局模型配置，Claude Code settings 格式；含 token，Agent 不可读写
  credentials.json      微信 token + API Key fallback；Agent 不可读写
  bridge.json           端口 / adapter / 并发
  principals.json       source/account → principal、角色、能力
  rules.md              全局规则；可读，只有人类能改
  external-tools.json   外接工具覆盖/新增（可选，内置定义在代码里）
  app-secrets.key       每用户模型/工具密钥的加密主密钥（自动生成，勿入库）

core/                   通用后端：config / principals / user-store / prompt /
                        permissions / conversation / scheduler / cron / mood /
                        app-store / external-tools / delivery / usage 等
agents/                 Claude Agent SDK 适配层（agent.mjs）、系统工具 tools/
bridge/                 Bridge Server、adapter（app / weixin）、启动脚本
electron/               Electron 主进程 / preload
src/                    React 前端（PC 端）
app/                    手机端：移动页面（web/）+ 安卓原生壳（android/）
scripts/                dev supervisor、重启前检查、图标生成
docs/                   产品/技术方案；legacy/ 为历史文档

userdata/               每用户数据 + 用户工具（不入库）
  <principalId>/        persona.md、sessions/、memory/、workspace/、
                        crons.json、schedules.json、files/、app/
    app/                settings、models.json、tools.json、devices.json、
                        usage/*.jsonl、pricing.json、media/
  _secrets/             加密后的每用户密钥
  tools/<ownerId>/      用户创建的工具，所有用户加载
  app-adapter/          App 设备令牌、临时文件
```

## 配置

- **全局模型**：直接编辑 `config/agent.json`，支持整段粘贴 Claude Code settings；模板见 [config/agent.example.json](config/agent.example.json)。
- **每用户模型**：App「模型与能力」里管理。展示元数据在 `userdata/<id>/app/models.json`，API Key 等敏感内容加密存 `userdata/_secrets/`，都不入库。模板见 [config/model-config.example.json](config/model-config.example.json)（可整段粘贴到 App 的 LLM 配置）。
- **微信凭证**：编辑 `config/credentials.json`；模板见 [config/credentials.example.json](config/credentials.example.json)。
- **全局规则**：`config/rules.md`，Agent 只能读不能改。
- **模板**：`config/*.example.json|md` 是唯一入库的配置文件；其余配置和 `userdata/`、`backups/` 都在 `.gitignore` 中。

### 家人微信账号

iLink 不支持分享机器人名片。每个家人的微信账号需要单独绑定一个机器人：

```powershell
node bridge/adapters/weixin.mjs invite family_xiaoming
```

扫码确认后会自动写入 `credentials.json`、加入 `bridge.json` 的 `accounts` 并重启 Bridge。每个家人使用不同的 `accountKey`（如 `family_mom`），消息最终都进入同一个 Jarvis。

## 新用户引导

新用户第一次发消息时，Bridge 会先发送风格选择菜单（默认 / 简洁高效 / 温柔陪伴 / 元气活泼 / 自定义），选择后写入 `userdata/<principalId>/persona.md`，之后恢复正常聊天。已存在的用户不会补发。

## 工具

- **系统工具**：`agents/tools/`，随项目代码维护。包括聊天/文件/日程/定时任务、截图、键鼠模拟、重启、图片生成、抽象表情等；键鼠类高危工具仅 owner 可见。
- **用户自定义工具**：通过 `_meta` 工具创建，存 `userdata/tools/<ownerId>/`，默认所有用户可用；只有创建者或主会话能改。
- **外接工具**：全局定义，内置安卓通知/闹钟/定位/短信；也支持以 MCP / HTTP 形式接入自定义外接工具。启用状态按用户保存在 `userdata/<id>/app/tools.json`；只有 owner / 主会话能增删改定义。

启用与管理入口在 App「工具」页。

## 用量与费用

- 每次 LLM 调用写入 `userdata/<id>/app/usage/YYYY-MM.jsonl`（轮级 + 调用级）。
- 价格设置是每用户的 `userdata/<id>/app/pricing.json`，`input / output / cacheRead / cacheWrite` 按每 1M token 自填，货币支持 CNY / USD；代码中**不内置任何供应商价格**。
- 用量页展示：轮数、LLM 调用次数、token 总量、缓存读利用率、按价格表估算的费用，可展开查看每次调用明细。

## 日程

通过聊天里的 `schedule__add / list / update / delete` 管理自己的日程，`remindBeforeMinutes` 选择提前多久提醒。

- 日程只属于设置者，其他用户不可见
- 提醒优先投递到 App（离线时排队、重连补发）；App 投递异常时回退微信等渠道

## 重启

Jarvis 的工具：

- `restart__renderer`：只刷新 React。
- `restart__bridge`：重启 Bridge，并等待 `/health` 恢复。
- `restart__electron`：重启 Electron，等待当前主回合结束；`force` 可强制中断。
- `restart__all`：同时重启 Bridge 和 Electron。

重启前默认运行 [scripts/restart-preflight.mjs](scripts/restart-preflight.mjs)：后端语法、配置 JSON、前端构建。失败不会重启。回合卡死超过 10 分钟会自动强制重启。重启会等待当前回合结束，但不会等待自行 detach 的常驻后台进程。

## 安全与隐私

- 受保护配置（`agent.json` / `credentials.json` / `app-secrets.key` / `rules.md`）的规则见 `core/permissions.mjs` 和 `config/rules.md`。
- 所有个人数据只在本地 `userdata/`，不入库；敏感密钥使用 `app-secrets.key` 加密。
- 手机 App 的 HTTP + Bearer token 只适合家庭局域网，**不要直接映射到公网**；公网访问需要 HTTPS 反向代理 / 隧道 + 独立鉴权。
- 个人项目不做 OS 沙箱；Bash 是信任边界。

## 开发约定

- 不建数据库，使用 JSON/JSONL。
- 每个用户的数据在 `userdata/<principalId>/`，互不读取。
- 改代码先建分支，自测后提交；合并 main、推送远程要经过确认。
- UI 配色和字体集中在 [src/theme.js](src/theme.js)。
