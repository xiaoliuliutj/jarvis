# 查询 / 执行分离（架构拆分）

> 状态：第一阶段已实现（读缓存 + 查询 worker）；执行进程拆分待做。
> 分支：`feat/query-exec-split`

## 背景

Bridge 的「查询」（App 打开会话、翻历史、用量统计）和「执行」（对话回合、工具调用、调度）
原本跑在同一个 Node 主线程里：

- 每次 App 刷新都会全量读取并解析 `sessions/<id>.messages.jsonl`（主会话 7000+ 条 / 5MB）
- 日志、用量、消息都是同步 I/O
- 执行中的回合、自检、大文件写入会占住事件循环，查询就排队变慢

## 目标

- 查询不阻塞执行，执行也不阻塞查询
- 不引入数据库、不引入外部中间件，保持单机 JSON/JSONL 架构

## 目标形态（四个进程/线程边界）

```text
jarvis-gateway（Bridge 收缩为网关：auth / 路由 / WS hub）
  ├─ app-adapter（17779）
  └─ weixin-adapter
jarvis-executor（唯一写方：ConversationService / Agent SDK / 工具 / 调度）
jarvis-query（只读：会话快照与切片、用量汇总；独立线程或进程）
共享：userdata/（JSONL）+ 本地内部通道（127.0.0.1）
```

约束：

- **单一写者**：只有 executor 写 `userdata/`；查询侧只读
- **认证在网关**：网关校验 token 后把 `principalId` 传给内部服务；内部端口仅本机
- **缓存失效**：读侧按 `size + mtime` 失效；写路径增量更新缓存

## 已实现（第一阶段）

### 1. 消息读缓存（`core/user-store.mjs`）

- `readMessages` 按文件 `size + mtime` 缓存解析结果，命中时直接返回只读快照
- `appendMessage` 在确认缓存与文件同步时增量追加（替换数组，不原地修改），
  跨进程写入（Electron 主会话）导致 size 不一致时自动失效重读

### 2. 会话只读模型（`core/read-model.mjs`）

- 把原始消息映射成 App UI 消息，并用 WeakMap 以「解析产出的 rows 数组」为 key 缓存映射结果
- 提供切片：`tailUiMessages` / `beforeUiMessages` / `afterUiMessages` / `uiReadInfo` / `historyTexts`
- bridge 与 query worker 共用同一套展示逻辑

### 3. 查询 worker（`core/query-worker.mjs` + `core/query-client.mjs`）

- `worker_threads` 独立线程执行查询 op：
  `uiTail` / `uiBefore` / `uiAfter` / `readInfo` / `history` / `usageSummary` / `usageByTurn`
- 懒加载；worker 不可用 / 超时 / 崩溃时 `queryOr()` 自动回退主线程同名实现
- App adapter 的查询端点全部改走 `queryOr`：
  `/api/v1/session/current`、`/api/v1/session/history`、`/api/v1/sync`、
  `/api/v1/read`、`/api/history`、`/api/v1/usage/summary`、`/api/v1/usage/message`

### 4. 静态资源缓存（`bridge/adapters/app.mjs`）

- `app.js` / `style.css` / `index.html`：`no-store` → `no-cache`（ETag 校验，未变返回 304）
- 冷启动仍会拿新版本，热加载不再重复传 173KB 的 app.js

## 实测

| 项目 | 结果 |
|---|---|
| worker `uiTail` 冷启动 | ~44ms（含 worker 启动与首次解析） |
| worker `uiTail` 缓存命中 | ~1ms |
| worker `usageSummary` | ~43ms |
| 主线程回退一致性 | 与 worker 结果逐字段一致 |
| 增量缓存 | 追加 1/2/3 条后 seq 连续且不重解析 |

## 待做

1. **前端增量同步**：WS 重连后改用 `/api/v1/sync?after=<cursor>` 只拉新消息，
   不再整页 `loadSession()`（服务端接口已就绪，前端尚未接入）
2. **工具记录拆分存储**：`tool` 记录占会话文件 ~91%，单独存 `tools.jsonl`，
   会话文件可降到百 KB 级
3. **executor 独立进程**（阶段 3）：Bridge 收缩为网关，执行与查询彻底分进程；
   崩溃隔离、独立重启
4. 真·多机微服务：仅在公网/多设备场景再考虑，当前不做
