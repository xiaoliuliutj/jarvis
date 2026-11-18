/**
 * Claude Code Agent
 *
 * 插件接口约定（所有 agents/<agentId>/agent.mjs 必须导出）：
 *   - name:        string
 *   - description: string
 *   - models:      array  [{id, label, desc, default}]
 *   - permissionModes: array  [{id, label}]
 *   - run(prompt, options): async generator
 *       yield { type: 'tool',   name, input }
 *       yield { type: 'result', text, cost, turns, isError }
 *       yield { type: 'memory', action, entry }   ← 记忆操作事件（可选消费）
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import path from 'path'
import fs from 'fs'
import Anthropic from '@anthropic-ai/sdk'
import {
  ensureMemoryDirs,
  readGlobalMemory,
  formatLongTermMemory,
  appendMemoryEntry,
  getCompressibleEntries,
  applyCompression,
  readCurrentSession,
  createSession,
  touchCurrentSession,
  isInWorkspace,
  isInDefaultWorkspace,
  isInSessionWorkDirs,
  isToolsPath,
  isConfigPath,
  isMemoryPath,
  isGlobalMemoryPath,
  isJarvisCodePath,
  DEFAULT_WORKSPACE,
} from './memory-store.mjs'

export const name = 'Claude Code'
export const description = '基于 Claude Agent SDK，内置完整 Claude Code 工具集（Read/Bash/Edit/Grep/Glob…）'


export const models = [
  { id: 'claude-opus-5-5',   label: 'Opus 5.5',   desc: '最强 · $4/$20',    default: false },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', desc: '均衡 · $2/$10',    default: true  },
  { id: 'claude-haiku-5-5',  label: 'Haiku 5.5',  desc: '快速 · $0.1/$0.5', default: false },
]

export const permissionModes = [
  { id: 'bypassPermissions', label: '自动执行（bypass）' },
  { id: 'auto',              label: 'AI 分类审批（auto）' },
  { id: 'default',           label: '每次询问（default）' },
]

// ── 关键词检测（触发记忆写入） ────────────────────────────────────────────────
const MEMORY_TRIGGER_RE = /记住|记一下|别忘了|记录一下|remember\s+that|make\s+a\s+note/i

// ── 模型上下文窗口查询（带缓存） ──────────────────────────────────────────────
const modelContextCache = new Map()

async function getModelContextTokens(modelId, apiKey, baseUrl) {
  if (modelContextCache.has(modelId)) return modelContextCache.get(modelId)
  try {
    const client = new Anthropic({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    })
    const info = await client.models.retrieve(modelId)
    const tokens = info.max_input_tokens ?? 200_000
    modelContextCache.set(modelId, tokens)
    return tokens
  } catch {
    return 200_000  // 保守回退
  }
}

// ── 写操作工具集合 ────────────────────────────────────────────────────────────
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * 构建权限回调
 * @param {object} opts
 * @param {boolean} opts.isMain            是否是主会话
 * @param {string[]} opts.workDirs         当前会话的工作目录列表
 * @param {boolean} opts.jarvisCodeWritable 是否允许写 Jarvis 项目文件（默认跟随 isMain）
 * @param {boolean} opts.noAsk             true = 把所有 ask 转为 deny（无头进程用）
 */
function buildCanUseTool({ isMain = false, workDirs = [], jarvisCodeWritable = isMain, noAsk = false }) {
  const ask = noAsk
    ? { behavior: 'deny', message: '该操作需要用户确认，无头会话中自动拒绝。' }
    : { behavior: 'ask' }

  return async (toolName, input) => {
    // 只拦截写操作工具
    if (!WRITE_TOOLS.has(toolName)) return { behavior: 'allow' }

    const filePath = input?.file_path || input?.path || input?.file_path || ''
    if (!filePath) return { behavior: 'allow' }

    // ── 工具目录：所有会话都可以写 ──
    if (isToolsPath(filePath)) return { behavior: 'allow' }

    // ── 全局记忆 / 配置目录：只读（含 API Key、微信 token） ──
    if (isGlobalMemoryPath(filePath)) {
      return { behavior: 'deny', message: '全局记忆（config/global.md）只能由用户手动修改。' }
    }
    if (isConfigPath(filePath)) {
      return { behavior: 'deny', message: '配置文件（config/）只能由用户手动修改。' }
    }

    // ── 记忆目录：所有会话都可以写 ──
    if (isMemoryPath(filePath)) return { behavior: 'allow' }

    // ── 工作空间内 ──────────────────────────────────────────────────────────
    if (isInWorkspace(filePath)) {
      if (isMain) return { behavior: 'allow' }
      if (isInDefaultWorkspace(filePath)) return { behavior: 'allow' }
      if (isInSessionWorkDirs(filePath, workDirs)) return { behavior: 'allow' }
      return { behavior: 'deny', message: `该路径不在当前会话的工作目录内。如需修改，请先将该目录加入会话工作目录。` }
    }

    // ── Jarvis 代码目录 ──────────────────────────────────────────────────────
    if (isJarvisCodePath(filePath)) {
      if (!jarvisCodeWritable) {
        return { behavior: 'deny', message: 'Jarvis 项目文件只能由 PC 端修改。' }
      }
      return ask  // PC 端主会话需要确认（无头模式下转为 deny）
    }

    // ── 工作空间外的任意路径 ────────────────────────────────────────────────
    if (isMain) return ask
    return { behavior: 'deny', message: '该路径不在工作空间内，普通会话无写入权限。' }
  }
}

// ── 工具注册表路径 ────────────────────────────────────────────────────────────
const TOOLS_DIR   = path.join(import.meta.dirname, 'tools')
const REGISTRY    = path.join(TOOLS_DIR, '_registry.json')
const SIGNAL_FILE = path.join(TOOLS_DIR, '_reload.signal')

/** 读取所有已启用的自定义工具，构建 mcpServers 配置 */
function loadEnabledMcpServers() {
  const servers = {
    // _meta 始终注册
    '_meta': {
      command: 'node',
      args: [path.join(TOOLS_DIR, '_meta', 'index.mjs')],
    }
  }
  try {
    if (fs.existsSync(REGISTRY)) {
      const entries = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'))
      for (const e of entries) {
        if (!e.enabled) continue
        const toolIndex = path.join(TOOLS_DIR, e.name, 'index.mjs')
        if (fs.existsSync(toolIndex)) {
          servers[e.name] = { command: 'node', args: [toolIndex] }
        }
      }
    }
  } catch (err) {
    console.error('[agent] 加载工具注册表失败:', err.message)
  }
  return servers
}

// 保存当前 Query 对象，供热加载使用
let activeQuery = null

// ── 主 run 函数 ───────────────────────────────────────────────────────────────

export async function* run(prompt, options = {}) {
  const { model, permissionMode, apiKey, baseUrl, cwd, systemPromptAppend, isMain = false, workDirs = [], jarvisCodeWritable = isMain } = options

  if (!apiKey) {
    yield { type: 'result', text: '未配置 API Key（config/agent.json 中的 env.ANTHROPIC_AUTH_TOKEN）。', cost: 0, turns: 0, isError: true }
    return
  }

  ensureMemoryDirs()

  // ── 1. 读取记忆，构建 system prompt 追加内容 ──────────────────────────────
  const modelContextTokens = await getModelContextTokens(model, apiKey, baseUrl)
  const maxMemoryTokens = Math.max(20_000, Math.floor(modelContextTokens * 0.1))

  const globalMem = readGlobalMemory()
  const longTermMem = formatLongTermMemory(maxMemoryTokens)

  const memorySection = [
    globalMem ? `## 全局记忆（必须遵守）\n${globalMem}` : '',
    longTermMem || '',
  ].filter(Boolean).join('\n\n')

  // ── 2. 会话管理（按 cwd 分割，resume 上一次会话） ─────────────────────────
  // resumeSessionId: 由调用方显式指定要恢复的 session（PC 主会话专用）
  // forceNew: true 时不续接任何会话（新建会话场景）
  // 其余情况走 readCurrentSession
  const { resumeSessionId, forceNew } = options
  const existingSession = resumeSessionId
    ? { sessionId: resumeSessionId }
    : (forceNew ? null : readCurrentSession(cwd))
  const sessionOpts = existingSession?.sessionId
    ? { resume: existingSession.sessionId }
    : {}

  // ── 3. 构建 query 选项 ────────────────────────────────────────────────────
  const isAutoMode = permissionMode === 'auto' || permissionMode === 'default'
  // "rulesOnly" 模式：自动放行但受 buildCanUseTool 规则约束（不弹权限确认，deny 时直接拒绝）
  // 适合无头进程（Bridge Server），既不卡在等待确认，又能限制写权限范围
  const isRulesOnlyMode = permissionMode === 'rulesOnly'

  const nodeBinDir = path.dirname(process.execPath)
  const envPATH = process.env.PATH || ''
  const patchedPATH = envPATH.includes(nodeBinDir) ? envPATH : `${nodeBinDir}${path.delimiter}${envPATH}`

  const injectedEnv = {
    ...process.env,
    PATH: patchedPATH,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_AUTH_TOKEN: apiKey,
  }
  if (baseUrl) injectedEnv.ANTHROPIC_BASE_URL = baseUrl

  // 构建完整自定义 system prompt
  // 使用 string 形式完全替换 Claude Code 的默认 system prompt，
  // 确保角色设定优先级最高。工具（Bash/Edit/Read 等）不依赖 system prompt，仍正常可用。
  const TOOL_USAGE_HINT = `
## 工具使用规范
你拥有完整的 Claude Code 工具集，包括 Read（读文件）、Edit（编辑文件）、Write（创建文件）、Bash（执行命令）、Glob（搜索文件名）、Grep（搜索内容）等。
需要查看文件、执行操作时，直接调用对应工具，不要假设或猜测文件内容。

## 自定义工具管理（重要）
你有一个专属工具库，可以创建、更新、管理自定义工具。工具以 MCP server 形式实现，存储在 agents/claude-cc/tools/ 目录。

**何时创建新工具：**
- 用户说"封装一个工具""记住这个操作""以后每次都要做 X"
- 你发现自己重复执行相同的 Bash 命令超过 2 次
- 需要调用外部 API 或系统能力，且该需求会反复出现

**创建工具的步骤：**
1. 先调用 _meta__get_tool_template 获取标准模板
2. 根据需求填写实现代码
3. 调用 _meta__create_tool 创建并注册（系统会自动热加载）

**管理工具：**
- _meta__list_tools：查看所有已有工具
- _meta__update_tool：修复或改进已有工具
- _meta__toggle_tool：启用/禁用工具

## 记忆写入规范
当用户说"记住"、"记一下"、"别忘了"等关键词时，在回复中用以下格式标记：
[MEMORY:type:content]
type: preference（偏好）/ fact（事实）/ session_summary（总结）
示例：[MEMORY:preference:用户偏好使用 TypeScript]
`

  const fullSystemPrompt = [
    memorySection,         // 全局记忆（角色设定）在最前面，权重最高
    TOOL_USAGE_HINT,
    systemPromptAppend || '',
  ].filter(Boolean).join('\n\n')

  const queryOptions = {
    cwd: cwd || process.cwd(),
    model,
    permissionMode: isAutoMode ? permissionMode : (isRulesOnlyMode ? 'default' : 'bypassPermissions'),
    ...(isAutoMode || isRulesOnlyMode ? {} : { allowDangerouslySkipPermissions: true }),
    ...sessionOpts,
    env: injectedEnv,
    systemPrompt: fullSystemPrompt,
    mcpServers: loadEnabledMcpServers(),
    // ── 权限回调 ────────────────────────────────────────────────────────────
    canUseTool: isAutoMode
      ? undefined
      : buildCanUseTool({ isMain, workDirs, jarvisCodeWritable, noAsk: isRulesOnlyMode }),
  }

  // ── 4. 运行 query，启动 signal 文件监听（热加载） ─────────────────────────
  let collectedText = ''
  const fileOpsThisTurn = []
  let signalWatcher = null

  try {
    const q = query({ prompt, options: queryOptions })
    activeQuery = q

    // 确保 signal 文件存在（供 _meta server 写入）
    if (!fs.existsSync(SIGNAL_FILE)) fs.writeFileSync(SIGNAL_FILE, '', 'utf-8')

    // 监听 _reload.signal 文件变化，触发 MCP 热加载
    let lastSignal = ''
    signalWatcher = fs.watch(SIGNAL_FILE, async () => {
      try {
        const sig = fs.readFileSync(SIGNAL_FILE, 'utf-8').trim()
        if (sig === lastSignal) return
        lastSignal = sig
        await q.setMcpServers(loadEnabledMcpServers())
      } catch {}
    })

    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        // 保存 session ID，并通过 result 返回给渲染进程
        const sid = msg.session_id
        if (sid) {
          if (!existingSession || !existingSession.sessionId) {
            createSession(cwd, sid)
          } else {
            touchCurrentSession(cwd)
          }
        }
      }

      if (msg.type === 'assistant') {
        for (const block of (msg.message?.content ?? [])) {
          if (block.type === 'tool_use') {
            yield { type: 'tool', name: block.name, input: block.input }

            // 记录文件操作
            if (WRITE_TOOLS.has(block.name)) {
              const filePath = block.input?.path || block.input?.file_path || ''
              if (filePath) {
                fileOpsThisTurn.push({ tool: block.name, path: filePath })
              }
            }
          } else if (block.type === 'text' && block.text) {
            // 过滤掉 <thinking>...</thinking> 标签（Opus 模型有时把思考过程放在 text block 里）
            const cleanText = block.text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim()
            if (cleanText) {
              collectedText += cleanText
              yield { type: 'text', text: cleanText }
            }
          }
        }
      } else if (msg.type === 'result') {
        const text = msg.result || collectedText

        // ── 5. 解析 [MEMORY:type:content] 标记并写入长期记忆 ──────────────
        const memoryMatches = [...text.matchAll(/\[MEMORY:(\w+):([^\]]+)\]/g)]
        for (const [, mType, mContent] of memoryMatches) {
          const entry = appendMemoryEntry({ content: mContent.trim(), type: mType, refs: [], cwd })
          yield { type: 'memory', action: 'append', entry }
        }

        // ── 6. 记录文件操作到长期记忆 ─────────────────────────────────────
        for (const op of fileOpsThisTurn) {
          const entry = appendMemoryEntry({
            content: `${op.tool === 'Write' ? '创建' : '编辑'}了文件 ${op.path}`,
            type: 'project_file',
            refs: [op.path],
            cwd,
          })
          yield { type: 'memory', action: 'file_op', entry }
        }

        // ── 7. 检测 prompt 是否含记忆触发词 ──────────────────────────────
        if (MEMORY_TRIGGER_RE.test(prompt) && !memoryMatches.length) {
          // prompt 触发但模型没有输出 MEMORY 标记 → 把 prompt 本身记录为 fact
          const entry = appendMemoryEntry({
            content: `用户要求记住：${prompt.slice(0, 200)}`,
            type: 'fact',
            refs: [],
            cwd,
          })
          yield { type: 'memory', action: 'append', entry }
        }

        // ── 8. 压缩检查 ───────────────────────────────────────────────────
        const { needsCompression, entries: toCompress } = getCompressibleEntries(modelContextTokens)
        if (needsCompression && toCompress.length > 0) {
          yield { type: 'memory', action: 'compress_needed', count: toCompress.length }
          // 压缩在后台异步进行，不阻塞回复
          compressMemoryBackground(toCompress, model, apiKey, baseUrl, cwd).catch(console.error)
        }

        yield {
          type: 'result',
          text,
          cost: msg.total_cost_usd ?? 0,
          turns: msg.num_turns ?? 0,
          isError: msg.is_error ?? (msg.subtype !== 'success'),
          sessionId: msg.session_id ?? existingSession?.sessionId ?? null,
        }
        return
      }
    }

    yield { type: 'result', text: collectedText, cost: 0, turns: 0, isError: !collectedText }
  } catch (err) {
    yield { type: 'result', text: `Error: ${err.message}`, cost: 0, turns: 0, isError: true }
  } finally {
    signalWatcher?.close()
    activeQuery = null
  }
}

// ── 后台压缩（异步，不阻塞主流程） ───────────────────────────────────────────

async function compressMemoryBackground(entries, model, apiKey, baseUrl, cwd) {
  if (!entries.length) return
  try {
    const client = new Anthropic({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    })

    const entriesText = entries.map((e, i) => `${i + 1}. [${e.type}] ${e.content}`).join('\n')

    const resp = await client.messages.create({
      model,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `以下是需要压缩的记忆条目，请合并为一条简洁的摘要（不超过 200 字），保留最重要的信息：\n\n${entriesText}\n\n请直接输出摘要文本，不要加任何前缀。`,
      }],
    })

    const summary = resp.content.find(b => b.type === 'text')?.text?.trim()
    if (summary) {
      applyCompression(entries.map(e => e.id), `[压缩摘要] ${summary}`)
    }
  } catch (err) {
    console.error('[memory] 压缩失败:', err.message)
  }
}

// ── 导出工具函数供外部调用 ────────────────────────────────────────────────────

export { appendMemoryEntry, readGlobalMemory, formatLongTermMemory } from './memory-store.mjs'
