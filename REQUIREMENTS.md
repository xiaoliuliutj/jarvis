# Jarvis 多用户后端需求与实现方案

> 本文件是当前实现基线。后续改动先改这里，再改代码。
> 个人项目：优先简单、可扩展、可读；不做过度防御性编程，问题暴露出来再修。

---

## 1. 目标

Jarvis 是一个本机运行的 AI 助手，包含：

- **一个 PC 主会话**：用于维护 Jarvis 本身，可以修改项目代码（受保护文件除外）。
- **多个外部数据源**：微信、QQ、邮件等；数据源只负责收发消息，不参与 AI 逻辑。
- **多个用户**：每个用户有自己的会话、工作区、长期记忆、AI 人设和定时任务。
- **统一模型调用**：主会话和所有用户共用同一套 `agent.run` 和 `ConversationService`，只是 principal/权限/数据目录不同。

---

## 2. 角色与权限

| 角色 | 说明 | 工具 | 项目代码 | 受保护文件 |
|---|---|---|---|---|
| `maintainer` | PC 主会话，唯一 | 全部 | ✅ 可改 | 只读，不可外传 |
| `owner` | 手机上的你 | 与 main 相同 | ✅ 可改 | 只读，不可外传 |
| `user` | 家人等普通用户 | 全部可用 | ❌ 不可改 | 只读，不可外传 |

- owner 和普通用户在 persona/记忆/工作区上没有区别，只是能力位不同。
- 所有用户都不能修改项目代码（除 maintainer/owner）。
- 代码修改权限是 prompt/策略级，不做 OS 沙箱。
- 所有工具对所有用户可用；创建者可改/删自己的工具，main 可管理全部。

---

## 3. 数据目录

```text
E:\Jarvis\
├─ config\
│   ├─ credentials.json      # 微信 token + 可选 API Key fallback；Agent 不可读写
│   ├─ agent.json            # Claude Code settings 格式（env/model/effort）；Agent 不可读写
│   ├─ bridge.json           # 端口、adapter、系统配置（不含 token）
│   ├─ rules.md              # 全局 rules；可读，只人工改
│   ├─ principals.json       # source/account → principal、角色、能力
│   └─ *.example.*           # 入库模板
├─ userdata\                 # 全部 gitignore
│   ├─ pc-main\
│   │   ├─ persona.md
│   │   ├─ sessions\         # index.json + *.messages.jsonl
│   │   ├─ workspace\
│   │   ├─ memory\long-term.jsonl
│   │   ├─ crons.json
│   │   └─ schedules.json    # 当前用户自己的日程
│   ├─ <principalId>\        # 每个用户同结构
│   └─ tools\
│       └─ <ownerId>\<toolName>\   # 用户工具，所有用户加载
└─ agents\
    ├─ agent.mjs
    ├─ tools\                # 系统工具，所有用户可用，仅 maintainer/owner 可改
    ├─ memory\               # 历史全局记忆（停用，gitignore）
    └─ sessions\             # 历史全局会话（停用，gitignore）
```

---

## 4. 需求表

| ID | 类别 | 需求 | 实现 |
|---|---|---|---|
| A1 | 身份 | PC 主会话唯一 | `pc-main` principal，maintainer，独立 main lane |
| A2 | 身份 | 手机 owner | 普通用户数据 + `editJarvisCode` 能力 |
| A3 | 身份 | 家人用户 | 普通用户，全工具，无代码修改 |
| A4 | 身份 | 模型不感知数据源 | prompt 只含 displayName；source/account 仅路由和 UI |
| A5 | 身份 | 多数据源/多用户 | `principals.json` 映射 source+account+externalUserId |
| B1 | 会话 | 每用户独立会话 | `userdata/<id>/sessions`；支持多会话，main 只有主会话 |
| B2 | 工作区 | 每用户独立工作区 | `userdata/<id>/workspace` |
| B3 | 记忆 | 每用户独立长期记忆 | `userdata/<id>/memory/long-term.jsonl` |
| B4 | 人设 | 每用户独立 persona | `persona.md`；用户可让 AI 通过 `persona__update` 改自己 |
| B5 | 规则 | 全局 rules | `config/rules.md`；可读；只人工写；优先级高于 persona |
| C1 | 配置 | 模型配置兼容 Claude Code settings | 整个 settings 对象可直接粘到 `agent.json`，`env` 映射到 Agent 子进程 |
| C2 | 保密 | 凭证不可读写/外传 | prompt + Read/Glob/Grep/Write/Edit 路径拒绝；Bash 为信任级绕过点 |
| C3 | 无感 | 用户对 API 无感 | 回复/错误/UI 不出现 Key、供应商、token |
| C4 | 规则 | 全局 rules 只读 | Agent 不可写 |
| C5 | 授权 | principals.json 不保护 | 可正常编辑 |
| C6 | 仓库 | 配置不入库 | 实际配置、userdata 全部 gitignore |
| D1 | 工具 | 工具全局可用 | 所有启用工具对所有会话加载 |
| D2 | 工具 | 工具所有权 | 创建者改/删；main 全权；系统工具仅 maintainer/owner 改 |
| D3 | 工具 | 用户工具目录 | `userdata/tools/<ownerId>/<toolName>`；名字全局唯一 |
| D4 | 工具 | 不做沙箱 | 用户工具与主进程同权限，信任家人 |
| D5 | 权限 | 代码修改 | 仅 maintainer/owner |
| E1 | Cron | 每用户定时任务 | `userdata/<id>/crons.json`；用 owner 上下文执行 |
| E2 | Cron | Cron 权限 | 用户管自己；main 管全部；只能发回自己的账号 |
| E3 | Cron | 现有任务迁移 | 现有 `test-greeting` 迁移到微信 principal |
| F1 | 并发 | main lane + 用户池 | main 并发 1；Bridge 用户池并发 2 |
| F2 | 并发 | 同用户串行 | 每 principal FIFO/锁；不同用户并行 |
| F3 | 并发 | Cron | 用户 cron 走用户池；main cron 走 main lane |
| G1 | Adapter | 统一接口 | manifest/自动发现；统一入站/出站 |
| G2 | Bridge | 只跑本机 | HTTP/WS 绑定 127.0.0.1 |
| G3 | 事件 | 前端契约 | 事件带 principalId/sessionId/source |
| H1 | 权限 | 凭证读取拒绝 | 所有 Agent（含 main）不可读 `credentials.json` / `agent.json` |
| H2 | 规则 | 全局 rules 只读 | 仅人工修改 |
| H3 | 主会话 | 权限模式 | 不用 rulesOnly，maintainer 可写项目代码 |
| I1 | 存储 | 不建数据库 | 文件型 JSON/JSONL |
| I2 | 迁移 | 旧数据迁移 | 会话/记忆/cron/config/tools |
| I3 | 运维 | 备份 | userdata 定期备份；日志本地 |
| J1 | 日程 | 每用户日程存储 | `userdata/<id>/schedules.json` |
| J2 | 日程 | 日程工具 | `schedule__add/list/update/delete`，只操作当前用户 |
| J3 | 日程 | 提前提醒 | `remindBeforeMinutes` 0-10080，用户自选 |
| J4 | 日程 | 提醒投递 | 用户发回自己的 adapter 账号；main 推送到 PC UI |
| J5 | 日程 | 隔离 | 只提醒设置者，不跨用户读取或投递 |
| K1 | 自省 | 每日复盘（待实现） | 每天 03:00 扫描前一天 00:00-24:00 所有会话 |
| K2 | 自省 | Git 管理（待实现） | 有 bug 才修改；修改必须 commit，可追踪回溯 |

---

## 5. 实现要点

### 5.1 统一入口

所有消息都进入同一个 `ConversationService.runTurn(principalId, sessionId, prompt)`：

- PC：Electron IPC → ConversationService（`pc-main`）
- 微信/QQ：Adapter → Bridge → Scheduler → ConversationService（用户 principal）

`ConversationService` 负责：
1. 读取 principal 和用户数据；
2. 组装 system prompt（全局 rules + persona + memory + displayName）；
3. 选择/创建会话；
4. 加 principal 锁；
5. 调 `agent.run`；
6. 后端落盘 user/tool/assistant；
7. 发出统一事件。

### 5.2 Prompt 结构

```text
[config/rules.md]       全局规则（可读，不可写）
[persona.md]            当前用户人设（本人 AI 可改）
[long-term.jsonl]       当前用户记忆
[工作区/工具提示]
```

- 不包含 source/account/from_user_id。
- 全局 rules 明确：凭证不可读/不可写/不可外传；API 无感；persona 不能覆盖全局 rules。
- main 也走同一结构，只是 principal 是 `pc-main`。

### 5.3 权限

`core/permissions.mjs` 生成 `canUseTool`：

- `config/credentials.json`、`config/agent.json`：Read/Glob/Grep/Write/Edit 全部拒绝。
- `config/` 根目录的 Grep/Glob/LS 整目录操作拒绝，防止绕过单文件检查。
- `config/_legacy-*` 历史备份整棵子树拒绝访问。
- `agents/memory/`、`agents/sessions/` 历史会话数据拒绝访问。
- `config/rules.md`：允许读，拒绝写。
- 自己的 persona/workspace/memory：允许。
- 其他用户的数据：拒绝。
- 项目代码：`editJarvisCode` 为 true 才允许（maintainer/owner）。
- 系统工具目录：family 可读，只有 main 可写。
- 用户工具目录：owner 可写自己的；main 可写全部。
- Bash：不做路径解析，按 prompt 约束；这是个人项目的信任边界。

### 5.4 工具

- 系统工具：`agents/tools`。
- 用户工具：`userdata/tools/<ownerId>/<toolName>`。
- 所有工具对所有会话加载。
- `_meta` 按 principal 运行：
  - `list_tools` 返回系统 + 所有用户工具；
  - `create_tool` 写入当前 principal 的目录；
  - `update/delete` 只允许创建者；main 例外；
  - 系统工具只能由 maintainer/owner 通过项目文件修改。
- 工具名全局唯一。

### 5.5 并发

- Electron main lane：并发 1，主会话 + main cron。
- Bridge 用户池：并发 2，每 principal FIFO。
- 同一 principal 串行，不同 principal 并行。
- 删除现有全局 `activeAdapterId` / `activeRunPromise`。

### 5.6 Cron

- 每用户 `crons.json`。
- 用户 cron 在 Bridge 执行；main cron 在 Electron 执行。
- 任务使用 owner 的 persona/记忆/工作区/权限。
- 结果发回 owner 自己的账号。
- 现有全局 inactivity 暂不启用；后续按用户实现。

### 5.7 存储

- 不建数据库；JSON/JSONL。
- 会话：`index.json` + `*.messages.jsonl`。
- 记忆：`long-term.jsonl`。
- 配置：JSON。
- 备份：复制 `userdata/` 即可。

### 5.8 模型配置

- `config/agent.json` 直接使用 Claude Code settings 格式，可以整段粘贴。
- `env` 以及顶层 `ANTHROPIC_*` / `CLAUDE_CODE_*` 会注入 Agent 子进程。
- 顶层 `effortLevel` / `autoCompactWindow` 在 env 未设置时映射为对应的 `CLAUDE_CODE_*`。
- 模型解析：`ANTHROPIC_MODEL` 优先；`opus` / `sonnet` / `haiku` 别名映射到 `ANTHROPIC_DEFAULT_*_MODEL`。
- 密钥解析：`ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > 旧 `apiKey` > `credentials.json`。
- `AUTH_TOKEN` 走 Bearer；`API_KEY` 走 x-api-key；旧配置两者都注入。
- 启动 Jarvis 的 shell 中的 `ANTHROPIC_*` / `CLAUDE_CODE_*` 不会带入，避免串用当前 CLI 的凭证。
- `agent.json` 可能包含 token，因此对所有 Agent 禁止读写。

### 5.9 自重启

- 开发模式由 `scripts/dev-supervisor.mjs` 托管 Vite + Electron，替代 `concurrently -k`。
- `restart__electron` → Bridge → Electron：主会话回合结束后再执行重启，消息先落盘。
- Electron 再调用 supervisor `/restart-electron`：只重启 Electron，Vite 保持运行。
- 重启前运行 `scripts/restart-preflight.mjs`：后端语法 + 配置 JSON + 前端构建，失败则拒绝重启。
- `restart__bridge` 重启后会轮询 `/health`，确认新 Bridge 已恢复。
- `force` 参数可立即重启；普通请求等待超过 10 分钟也会强制重启。
- `restart__all` 同时重启 Bridge 和 Electron，适合 `core/` 两端都引用的改动；同样支持 `force`。
- 自行 detach 的常驻后台进程不在等待范围内，重启前应避免启动。
- 用户关闭窗口时 supervisor 一并退出，不留下后台 Vite。
- 打包模式没有 supervisor 时回退到 `app.relaunch()`。
- Electron 异常崩溃会在 60 秒内最多自动拉起 3 次。

### 5.10 日程系统

- 每个用户自己的日程存 `userdata/<principalId>/schedules.json`，字段见 `core/schedule-store.mjs`。
- `schedule__add/list/update/delete` 只操作 `JARVIS_PRINCIPAL_ID` 自己的数据，没有跨用户参数。
- `remindBeforeMinutes` 由用户选择，范围 0-10080 分钟；`0` 表示准时。
- 提醒窗口：`[startAt - remindBefore, startAt + 15 分钟]`，错过窗口不补发，避免重启刷屏。
- 用户日程在 Bridge 进程轮询，提醒发回该用户自己的 adapter 账号。
- main 日程在 Electron 进程轮询，提醒推送到 PC UI 的提醒卡片。
- 提醒只发给设置者，不广播给其他用户。
- PC 端不做日程管理面板；用户通过聊天里的 schedule 工具查看和管理。
- `notes` 工具里的 schedule 只是纯文本记录，不负责提醒。

### 5.11 每日自我复盘（待实现）

需求：主会话每天 03:00 运行一次，采集前一天 00:00-24:00 的**所有 principal** 会话，检查是否有 Jarvis 自身的 bug 或问题；没有问题就不改，有问题才修复。修复必须进入 git，能够追踪和回溯。

设计约束（未实现）：

1. main cron 在 Electron 里触发，使用独立复盘 session，不影响正常主会话。
2. 会话读取使用系统级只读读取器，绕过普通 Agent 的用户隔离，但只把分析结果交给 main；不要把其他用户的会话内容写进代码或提交。
3. 无问题时只写一段复盘结论，不产生 commit。
4. 有问题时：
   - 从当前 main 创建分支 `auto-review/YYYY-MM-DD`
   - 只修改代码/配置模板，不提交 userdata、config 实际文件或会话内容
   - 运行 `scripts/restart-preflight.mjs`
   - 提交 `auto-review: YYYY-MM-DD ...`
   - 将分支 fast-forward 合回 main，并保留分支用于回溯
   - 需要生效时调用 `restart__electron` / `restart__all`
5. 当前状态：仅记录需求，未创建 cron，也未实现会话采集器。

---

## 6. 迁移

1. 旧 `config/agent.json` 的 `env` 密钥格式继续兼容；现在也可以把完整的 Claude Code settings 对象直接粘到 `agent.json`（文件受保护，不入库）。
2. 旧 `config/bridge.json` 的微信 token → `credentials.json`；端口/adapter/crons 拆分。
3. 旧 `config/global.md` → `config/rules.md`（规则）+ `userdata/pc-main/persona.md`（主会话人设）。
4. PC 主会话消息 → `userdata/pc-main/sessions/`。
5. 微信会话 → `userdata/<weixin-principal>/sessions/`；如有多用户按 `from` 拆分。
6. 旧全局 `long-term.jsonl` 按 cwd/来源归属到 main 或微信用户。
7. 旧 `test-greeting` cron → 微信 principal 的 `crons.json`。
8. 旧工具全部视为系统工具。

---

## 7. 不做的事情

- 不建数据库（SQLite/Postgres）。
- 不做 Redis/消息队列/Docker。
- 不做密钥 vault/模型代理/OS 沙箱。
- 不做跨进程锁（main 与用户数据分进程处理）。
- 不做过度防御性编程；出错直接暴露日志。

---

## 8. 实施顺序

1. 配置拆分、`userdata/`、principals、rules/persona、迁移。
2. 用户存储层 + principal 上下文 + prompt/permissions。
3. `ConversationService` + main/Bridge 接入。
4. 工具全局加载 + `_meta` 所有权 + persona/cron 工具。
5. 调度器（并发 2）+ per-user cron。
6. Adapter 注册、localhost、事件。
7. PC 前端适配；删除不可复用代码。
8. 测试与重启。

---

## 9. 实现状态（2026-11-19）

### 已完成

- 配置：`agent.json` 兼容 Claude Code settings（env/model/effort）；`agent.json` 与 `credentials.json` 均受保护；`bridge.json` / `rules.md` / `principals.json` 普通配置
- `userdata/` 结构：`pc-main` + 外部 principal，各自的 persona / sessions / workspace / memory / crons
- 一次性迁移：主会话、微信会话、长期记忆、test-greeting cron、旧配置备份
- `core/` 模块：paths / config / principals / user-store / prompt / permissions / tools / conversation / scheduler / cron / adapters
- 统一 `ConversationService.runTurn`：PC 主会话和 Bridge 用户共用
- 每用户工具：所有工具全局可用；创建者/main 所有权；用户工具在 `userdata/tools/<ownerId>`
- 人设工具：用户可以让 AI 修改自己的 persona
- 每用户 cron：`crons.json`；用户 cron 在 Bridge，main cron 在 Electron
- 并发：Bridge 用户池 2，每 principal FIFO；main 在 Electron 独立 lane
- Bridge 绑定 127.0.0.1；adapter 自动发现；微信 adapter 从 credentials 读取 token
- PC 前端：主会话 + 用户只读会话；Markdown/工具折叠；删除旧 renderer/InputBar/styles
- 启动：`npm run dev` 由 `scripts/dev-supervisor.mjs` 托管 Vite + Electron，自重启不会杀掉 Vite
- 重启：preflight 检查、回合感知、force、10 分钟兜底、restart__all
- 权限：config 根目录整目录搜索拒绝、`_legacy-*` 备份保护
- 目录整理：旧设计文档归档到 `docs/archive/`，README 重写，移除 wait-for-vite 和未使用的 concurrently
- agents 拍平：`agents/agent.mjs` + `agents/tools/`；旧全局记忆/会话移到 `agents/memory`、`agents/sessions`
- 日程：每用户 `schedules.json` + schedule 工具 + Bridge/Electron 提醒器 + main PC 提醒卡片

### 验证

- `vite build` 通过
- 真实模型端到端：`runTurn` 返回 OK、落盘 user/assistant
- 真实工具调用：`_meta.list_tools` 在精简 env 下工作
- 工具所有权：创建者/main 可改，其他用户不可改
- per-user cron 调度器触发并 deliver
- 真实 Electron + Bridge + Vite 启动，主会话/owner 会话渲染正常，无前端异常

### 暂未实现 / 已知边界

- 旧的全局 inactivity 主动消息已停用；后续需要按 principal 重做
- 一个 adapter 当前一个账号；多 bot 账号需要账号实例层
- 用户工具不做 OS 沙箱（按决定）
- 凭证保护是 prompt + 文件工具路径级；Bash 仍可绕过（按决定）；`agent.json` 与 `credentials.json` 同等保护
- `config/rules.md` 里仍有旧的“系统工具仅主维护会话修改”表述，需要人类手动同步为 maintainer/owner；Agent 不得修改 rules.md
- PC UI 只能查看用户当前会话；多会话切换/新建 UI 未做（存储层已支持）
- principal 管理通过 `config/principals.json` 手动编辑；没有 UI
- 旧 `agents/memory`、`agents/sessions`、`config/_legacy-*` 作为历史数据保留（gitignore）
- 每日自我复盘（K1/K2）尚未实现，也没有创建 03:00 cron；本次只写入需求
- main cron 只推送到 PC UI，不主动发外部渠道
