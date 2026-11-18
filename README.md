# Jarvis

本机运行的 AI 助手：一个 PC 主维护会话，加上微信等外部数据源和多个独立用户。主会话和所有用户共用同一套 `ConversationService` / `agent.run`，区别只在 principal、权限和数据目录。

完整实现基线见 [REQUIREMENTS.md](REQUIREMENTS.md)。

## 快速启动

```powershell
npm install
npm run dev
```

`npm run dev` 由 [scripts/dev-supervisor.mjs](scripts/dev-supervisor.mjs) 托管 Vite + Electron：

- Electron 自重启时 Vite 不会退出
- 关闭窗口时一起退出，不留后台 Vite
- 控制端口只在 `127.0.0.1:7781`

微信等外部消息需要另外启动 Bridge：

```powershell
powershell -ExecutionPolicy Bypass -File bridge/start-bridge.ps1
```

Bridge 只绑定 `127.0.0.1`，HTTP `7779` / WS `7780`。

## 目录

```text
config/                 实际配置（gitignore，只保留 *.example.* 模板）
  agent.json            Claude Code settings 格式；含 token，Agent 不可读写
  credentials.json      微信 token + 可选 API Key fallback；Agent 不可读写
  bridge.json           端口 / adapter / 并发
  rules.md              全局规则；可读，只有人类能改
  principals.json       source/account → principal、角色、能力

core/                   通用后端：paths / config / principals / user-store /
                        prompt / permissions / tools / conversation / scheduler / cron / adapters
agents/claude-cc/       Claude Agent SDK 适配层和系统工具
bridge/                 Bridge Server、adapter、启动脚本
electron/               Electron 主进程 / preload
src/                    React 前端
scripts/                dev supervisor、重启前检查、迁移、图标生成
docs/                   当前扩展计划；archive/ 是历史设计
userdata/               每用户数据 + 用户工具（gitignore）
  pc-main/              persona、sessions、workspace、memory、crons
  <principalId>/        外部用户，结构相同
  tools/<ownerId>/      用户创建的工具，所有用户加载
```

## 配置

- 模型调用：直接编辑 [config/agent.json](config/agent.json)，支持整段粘贴 Claude Code settings。
- 微信凭证：编辑 [config/credentials.json](config/credentials.json)。
- 全局规则：[config/rules.md](config/rules.md)。Agent 只能读，不能改；需要人工修改。
- 模板：[config/agent.example.json](config/agent.example.json)、[config/credentials.example.json](config/credentials.example.json)、[config/bridge.example.json](config/bridge.example.json)。
- 实际配置和 `userdata/` 都不会入库。

## 重启

Jarvis 的工具：

- `restart__renderer`：只刷新 React。
- `restart__bridge`：重启 Bridge。
- `restart__electron`：重启 Electron，等待当前主回合结束；`force` 可强制中断。
- `restart__all`：同时重启 Bridge 和 Electron。

重启前默认运行 [scripts/restart-preflight.mjs](scripts/restart-preflight.mjs)：后端语法、配置 JSON、前端构建。失败不会重启。回合卡死超过 10 分钟会自动强制重启。重启会等待当前回合结束，但不会等待自行 detach 的常驻后台进程。

## 开发约定

- 不建数据库，使用 JSON/JSONL。
- 每个用户的数据在 `userdata/<principalId>/`，互不读取。
- 受保护配置（`agent.json` / `credentials.json` / `rules.md`）的规则见 `core/permissions.mjs` 和 `config/rules.md`。
- 个人项目不做 OS 沙箱；Bash 是信任边界。
- UI 配色和字体集中在 [src/theme.js](src/theme.js)。
