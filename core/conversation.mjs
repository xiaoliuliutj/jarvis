/**
 * 统一的对话入口。
 *
 * 主会话（Electron）和所有 adapter 用户（Bridge）都调用 runTurn：
 *   - 读取 principal / persona / 记忆 / 全局 rules
 *   - 组装 system prompt 和 MCP 工具
 *   - 选择或创建会话
 *   - 调 agent.run
 *   - 后端落盘 user/tool/assistant
 *   - 通过 emit 发统一事件
 *
 * 同一 principal 的 runTurn 在进程内串行；不同 principal 可并行。
 */

import { getPrincipal } from './principals.mjs'
import * as store from './user-store.mjs'
import { buildSystemPrompt, buildTimeLine } from './prompt.mjs'
import { prepareMood } from './mood.mjs'
import { buildCanUseTool } from './permissions.mjs'
import { buildMcpServers, getToolProfileSettings } from './tools.mjs'
import {
  getAgentEnv,
  getAnthropicCredentials,
  getModel,
  resolveAnthropicCredentials,
  resolveModel,
  buildAgentEnv,
} from './config.mjs'
import { logInfo, logWarn, logError } from './logger.mjs'
import {
  getChatRuntime,
  listModels,
  appendUsage,
  setSessionContext,
  getSessionContext,
  markSessionContextCompacted,
} from './app-store.mjs'
import { readTranscriptUsage } from './usage-transcript.mjs'
import { compactSessionContext } from './context-compactor.mjs'
import { sanitizeOutgoingText } from './text-filter.mjs'

const locks = new Map()
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200000
// 定时任务不建可见会话：结果写进当前聊天会话，用户只看到一个会话。
// 但 cron 的 system prompt 快照用 __cron__ 作为内部 key（不写 session 索引）。
// 每次 cron 用全新 Agent 会话，不积累历史；只复用稳定的 system+tools 前缀。
const CRON_SNAPSHOT_ID = '__cron__'
const CRON_PROMPT_TTL_MS = 24 * 60 * 60 * 1000

function resolveContextWindowTokens(lastContext, agentEnv) {
  const fromSession = Number(lastContext?.maxTokens) || Number(lastContext?.rawMaxTokens) || 0
  const fromEnv = Number(agentEnv?.CLAUDE_CODE_AUTO_COMPACT_WINDOW) || 0
  return fromSession || fromEnv || DEFAULT_CONTEXT_WINDOW_TOKENS
}

function withPrincipalLock(principalId, fn) {
  const prev = locks.get(principalId) || Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  locks.set(principalId, next)
  return next.finally(() => {
    if (locks.get(principalId) === next) locks.delete(principalId)
  })
}

function sanitizeForUser(principal, text) {
  // 家庭用户看不到底层 API/凭证细节
  if (principal.role === 'user') return '服务暂时不可用，请稍后再试。'
  return text
}

/** App / 微信普通用户按 user 执行；带 owner token 时按 owner 执行。 */
function buildEffectivePrincipal(principalId, roleOverride) {
  const basePrincipal = getPrincipal(principalId)
  if (!roleOverride) return basePrincipal
  return {
    ...basePrincipal,
    role: roleOverride,
    capabilities: {
      ...basePrincipal.capabilities,
      editJarvisCode: roleOverride === 'owner' || roleOverride === 'maintainer',
      useGlobalModel: roleOverride === 'owner' || roleOverride === 'maintainer',
    },
  }
}

/**
 * 解析对话模型凭证；runTurn 和手动压缩共用。
 * 返回 { error } 或 { apiKey, baseUrl, authMode, activeModel, agentEnv }。
 */
function resolveChatModel({ principalId, principal }) {
  const userModel = getChatRuntime(principalId)
  const canUseGlobal = !!principal.capabilities?.useGlobalModel
    || principal.role === 'owner'
    || principal.role === 'maintainer'

  // 普通用户没有自己的模型 Key 时，不能静默使用 owner 的全局 Key。
  if (!userModel && !canUseGlobal) {
    const hasChatConfig = listModels(principalId).some(m => m.capability === 'chat' && m.enabled !== false)
    return {
      error: hasChatConfig
        ? '你的对话模型还没有配置 API Key，请在 App 设置 → 模型与能力里补上。'
        : '当前账号还没有配置对话模型 API，请在 App 设置 → 模型与能力里添加自己的模型。',
    }
  }

  let apiKey, baseUrl, authMode, activeModel, agentEnv
  if (userModel?.rawConfig) {
    // 用户整段配置：按 Claude Code settings 的同一套解析逻辑使用
    const rawCreds = resolveAnthropicCredentials(userModel.rawConfig, {})
    apiKey = rawCreds.apiKey
    baseUrl = rawCreds.baseUrl
    authMode = rawCreds.authMode
    activeModel = resolveModel(userModel.rawConfig)
    agentEnv = buildAgentEnv(userModel.rawConfig)
  } else {
    const globalCreds = canUseGlobal
      ? getAnthropicCredentials()
      : { apiKey: '', baseUrl: '', authMode: 'both' }
    apiKey = userModel?.apiKey || globalCreds.apiKey
    baseUrl = userModel?.baseUrl || (canUseGlobal ? globalCreds.baseUrl : '')
    authMode = userModel?.authMode || (canUseGlobal ? globalCreds.authMode : 'both')
    activeModel = userModel?.model || (canUseGlobal ? getModel() : '')
    agentEnv = canUseGlobal ? getAgentEnv() : {}
  }
  // 上下文窗口按模型配置/模型能力决定，不在这里强制覆盖。
  // 模型支持 1M 就用 1M；配置里没有就沿用模型/SDK 的默认值。
  if (!apiKey) {
    return {
      error: userModel
        ? '模型配置里没有可用的 API Key，请检查配置。'
        : sanitizeForUser(principal, '未配置 API Key（config/agent.json 或 config/credentials.json）'),
    }
  }
  return { apiKey, baseUrl, authMode, activeModel, agentEnv }
}

/**
 * @param {object} opts
 * @param {string} opts.principalId
 * @param {string} opts.prompt
 * @param {string|null} opts.sessionId   指定续接的会话；为空时用当前会话
 * @param {boolean} opts.forceNew        强制新会话
 * @param {(event: object) => void} opts.emit
 * @returns {Promise<{text, cost, turns, isError, sessionId}>}
 */
export async function runTurn({ principalId, prompt, displayText = null, userAttachments = [], sessionId = null, forceNew = false, source = 'chat', taskLabel = null, emit = () => {}, roleOverride = null }) {
  const principal = buildEffectivePrincipal(principalId, roleOverride)

  return withPrincipalLock(principalId, async () => {
    const turnStartedAt = Date.now()
    const turnId = `t_${turnStartedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const messagePreview = source === 'cron'
      ? '定时任务'
      : (String(displayText ?? prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || '（媒体消息）')
    store.ensureUser(principalId)

    const workspace = store.workspaceDir(principalId)
    const isCron = source === 'cron'
    const current = store.getCurrentSession(principalId)
    // 定时任务的结果写进当前聊天会话，用户只看到一个会话；
    // 每次 cron 用全新 Agent 会话（不积累历史），只复用固定的 system+tools 前缀。
    const displaySessionId = isCron
      ? (sessionId || current?.sessionId || null)
      : (forceNew ? null : (sessionId || current?.sessionId || null))
    const resumeId = displaySessionId
    const sessionRecord = displaySessionId ? store.getSession(principalId, displaySessionId) : null
    let agentSessionId = isCron
      ? null
      : (forceNew ? null : (sessionRecord?.agentSessionId || displaySessionId || null))
    // 手动压缩（App 按钮）已完成：本回合换新 Agent 会话，并注入最近对话交接。
    const pendingHandoff = !isCron && sessionRecord
      && typeof sessionRecord.pendingHandoff === 'string'
      ? sessionRecord.pendingHandoff
      : null
    let rotateAgent = pendingHandoff !== null
    let handoffBlock = pendingHandoff || ''

    const persona = store.readPersona(principalId)
    const rules = store.readRulesText()

    const modelConfig = resolveChatModel({ principalId, principal })
    if (modelConfig.error) {
      return {
        text: modelConfig.error,
        cost: 0,
        turns: 0,
        isError: true,
        sessionId: resumeId,
      }
    }
    const { apiKey, baseUrl, authMode, activeModel, agentEnv } = modelConfig

    // 长期记忆预算按当前上下文窗口的 2%-4% 计算：
    // 低于 4% 原样保留，超过 4% 压缩到 2%，保证摘要/偏好始终有一席之地。
    const lastContext = displaySessionId
      ? getSessionContext(principalId, displaySessionId)
      : null
    const contextWindowTokens = resolveContextWindowTokens(lastContext, agentEnv)

    // 工具按场景裁剪：主维护会话 full，普通用户 chat，定时任务 cron。
    const toolProfile = isCron
      ? 'cron'
      : ((principal.role === 'maintainer' || principal.role === 'owner') ? 'full' : 'chat')
    const toolSettings = getToolProfileSettings(toolProfile)
    const buildServers = () => buildMcpServers(principal, { profile: toolProfile })

    // 长期记忆快照：会话内冻结，只有换挡（agentSessionId 变化）或压缩时重建。
    // 记忆写入仍然实时落库，只是不再每轮改写 system prompt。
    // cron 的快照用内部 key，不存在可见会话；聊天用显示会话 ID。
    const snapshotReadId = isCron ? CRON_SNAPSHOT_ID : displaySessionId
    const promptSnapshot = snapshotReadId
      ? store.readPromptSnapshot(principalId, snapshotReadId)
      : null
    const snapshotAgeMs = promptSnapshot?.builtAt
      ? Date.now() - Date.parse(promptSnapshot.builtAt)
      : Infinity
    const snapshotMatchesAgent = !!(
      promptSnapshot
      && (!promptSnapshot.agentSessionId
        || !agentSessionId
        || promptSnapshot.agentSessionId === agentSessionId)
    )
    // cron 每次都是新 Agent 会话、没有历史；快照只按 TTL 刷新，让 system/tools 保持稳定。
    // 聊天会话按换挡（agentSessionId 变化）/压缩刷新。
    const useSnapshot = isCron
      ? !!(promptSnapshot && snapshotAgeMs < CRON_PROMPT_TTL_MS)
      : snapshotMatchesAgent
    let memory = useSnapshot
      ? promptSnapshot.memoryText
      : store.formatMemory(principalId, {
          contextWindowTokens,
          deterministic: true,
          maxProjectFiles: 40,
        })
    let memorySnapshotDirty = !useSnapshot
    let systemPrompt = buildSystemPrompt({ principal, rules, persona, memory, toolProfile })
    const mcpServers = buildServers()
    const canUseTool = buildCanUseTool({ principal, workspace })
    let toolChars = 0
    try { toolChars = JSON.stringify(mcpServers || {}).length } catch {}
    let contextHints = {
      systemChars: Math.max(0, systemPrompt.length - memory.length),
      memoryChars: memory?.length || 0,
      toolChars,
    }

    // 上下文达到窗口 75%（或历史兜底）时，把较早对话压成长期记忆，
    // 并换一个新的 Agent 会话；App 的显示会话保持不变，所以历史聊天记录不会消失。
    // 手动压缩（App 按钮）已经在待命，本回合跳过重复压缩。
    // 定时任务走独立的共享会话，不参与聊天历史的压缩/换挡。
    if (pendingHandoff === null && !isCron && !forceNew && displaySessionId && agentSessionId) {
      const ratio = lastContext
        ? (Number(lastContext.percentage) || (
          Number(lastContext.maxTokens) > 0
            ? Number(lastContext.totalTokens) / Number(lastContext.maxTokens) * 100
            : 0
        ))
        : 0
      // 首次启用压缩、还没有 context 数据时，用历史消息数量兜底，避免老会话一直不压缩。
      const bootCompact = !lastContext
        && displaySessionId
        && store.readMessages(principalId, displaySessionId).length >= 400
      if (ratio >= 75 || bootCompact) {
        const compacted = await compactSessionContext({
          principalId,
          displaySessionId,
          apiKey,
          baseUrl,
          authMode,
          model: activeModel,
        })
        if (compacted) {
          if (compacted.partial) {
            // 还有旧消息没压完：先不换 Agent 会话，避免最近那段未压缩消息被手交丢掉。
            // 下一回合上下文仍超阈值，会从 compactedUpto 继续压。
            logInfo('context.compact.partial', '', {
              principalId,
              sessionId: displaySessionId,
              ratio: Math.round(ratio),
              compactedUpto: compacted.compactedUpto,
            })
          } else {
            rotateAgent = true
            handoffBlock = compacted.handoffBlock || ''
            memory = store.formatMemory(principalId, {
              contextWindowTokens,
              deterministic: true,
              maxProjectFiles: 40,
            })
            memorySnapshotDirty = true
            // 先写一个不绑定 Agent 会话的临时快照：即使本回合失败，
            // 下一回合也不会继续用压缩前的旧记忆。
            store.writePromptSnapshot(principalId, displaySessionId, {
              memoryText: memory,
              agentSessionId: null,
            })
            systemPrompt = buildSystemPrompt({ principal, rules, persona, memory, toolProfile })
            contextHints = {
              systemChars: Math.max(0, systemPrompt.length - memory.length),
              memoryChars: memory?.length || 0,
              toolChars,
            }
            logInfo('context.compact.rotate', '', {
              principalId,
              sessionId: displaySessionId,
              ratio: Math.round(ratio),
            })
          }
        }
      }
    }

    // cron 的内部 prompt 不是用户发的消息，不写入聊天记录。
    const includeUser = source !== 'cron'
    // 首次会话的名称：主会话固定叫“主会话”；用户 chat 取第一条消息；cron 叫“定时任务”
    const sessionName = isCron
      ? '定时任务'
      : (principal.role === 'maintainer'
        ? '主会话'
        : (includeUser ? prompt.slice(0, 20) : '定时任务'))
    // 定时任务新建的显示会话不抢主会话的 isCurrent / isMain
    const isMain = !isCron && principal.role === 'maintainer'

    // ── 进行中即落盘 ─────────────────────────────────────────────────────────
    // 用户消息和工具记录不等回合结束才写。否则回合进行中切换会话/刷新历史时，
    // 已发出的消息和已执行的工具会“消失”，回合结束后才重新出现。
    let persistSessionId = displaySessionId // App 显示会话 ID；新会话等 init 事件带回
    let userPersisted = false
    let toolsPersisted = 0

    const userRecord = includeUser
      ? {
          type: 'user',
          text: displayText !== null ? displayText : prompt,
          ...(userAttachments.length ? { attachments: userAttachments } : {}),
          timestamp: new Date().toISOString(),
        }
      : null

    if (includeUser && persistSessionId) {
      store.ensureSession(principalId, persistSessionId, { name: sessionName, isMain })
      store.appendMessage(principalId, persistSessionId, userRecord)
      userPersisted = true
    }

    let result = null
    const toolRecords = []
    const llmUsageRecords = []
    const { run } = await import('../agents/agent.mjs')
    // 时间放在本轮用户消息的最前面（压缩交接之后），只动尾部，不动 system 前缀。
    // 定时任务加一个醒目标记；聊天回合在尾部带上最近一次 cron 结果，方便接话。
    const cronLabelText = String(taskLabel || '后台任务').replace(/\s+/g, ' ').trim().slice(0, 40) || '后台任务'
    const cronPromptLabel = isCron ? `【定时任务｜${cronLabelText}｜只执行本轮】\n` : ''
    const lastCronResult = !isCron ? store.readLastCronResult(principalId) : null
    const recentCronBlock = lastCronResult?.text
      && (Date.now() - (Date.parse(lastCronResult.at) || 0)) < 2 * 60 * 60 * 1000
      ? `【最近的定时任务结果（供你接话用，不要主动重复）】\n${lastCronResult.text.slice(0, 800)}\n\n`
      : ''
    // 心情由代码兜底更新；只拼在尾部，system prompt 保持不变。
    let moodLine = ''
    try {
      moodLine = prepareMood(principalId, {
        text: String(displayText ?? prompt ?? ''),
        isChat: !isCron,
      }).line
    } catch {}
    const agentPrompt = `${handoffBlock}${buildTimeLine()}${moodLine}${recentCronBlock}${cronPromptLabel}${prompt}`

    const runOnce = async () => {
      result = null
      llmUsageRecords.length = 0
      for await (const event of run(agentPrompt, {
        model: activeModel,
        apiKey,
        baseUrl,
        authMode,
        agentEnv,
        cwd: workspace,
        resumeSessionId: rotateAgent ? null : (agentSessionId || null),
        systemPrompt,
        mcpServers,
        builtinTools: toolSettings.builtinTools,
        disallowedTools: toolSettings.disallowedTools,
        canUseTool,
        contextHints,
        reloadMcpServers: () => buildServers(),
        memory: { append: (entry) => store.appendMemory(principalId, entry) },
      })) {
        if (event.type === 'session' && event.sessionId) {
          agentSessionId = event.sessionId
          // 新的显示会话：init 带回 sessionId，立刻补写用户消息
          if (!persistSessionId) persistSessionId = event.sessionId
          // 压缩后的首轮已经创建了新 Agent 会话，后续重试应续接它
          rotateAgent = false
          if (includeUser && !userPersisted) {
            store.ensureSession(principalId, persistSessionId, { name: sessionName, isMain })
            store.appendMessage(principalId, persistSessionId, userRecord)
            userPersisted = true
          }
        } else if (event.type === 'tool') {
          const rec = {
            type: 'tool',
            name: event.name,
            input: event.input,
            timestamp: new Date().toISOString(),
          }
          toolRecords.push(rec)
          logInfo('tool.call', event.name, { principalId })
          if (persistSessionId) {
            store.appendMessage(principalId, persistSessionId, rec)
            toolsPersisted++
          }
          emit({ ...event, principalId, sessionId: persistSessionId })
        } else if (event.type === 'text') {
          emit({ ...event, principalId, sessionId: persistSessionId })
        } else if (event.type === 'llm_usage') {
          llmUsageRecords.push(event)
        } else if (event.type === 'memory') {
          emit({ ...event, principalId, sessionId: persistSessionId })
        } else if (event.type === 'result') {
          result = event
        }
      }
    }

    await runOnce()

    if (!result) throw new Error('Agent 没有返回 result')

    // Bridge 重启后的首条消息：SDK 的 resume 有时会先返回一个空的 0 回合 result。
    // 这里重试一次；仍为空则给用户一句兜底，避免静默丢消息。
    if (!result.text && !result.isError && (result.turns ?? 0) === 0 && toolRecords.length === 0) {
      logWarn('turn.empty.retry', '', { principalId, source })
      await runOnce()
      if (!result) throw new Error('Agent 没有返回 result')
    }

    logInfo('turn.result', '', {
      principalId,
      source,
      isError: !!result.isError,
      cost: result.cost ?? 0,
      turns: result.turns ?? 0,
    })

    const finalAgentSessionId = result.sessionId || agentSessionId || persistSessionId
    const finalSessionId = persistSessionId || finalAgentSessionId
    if (!finalSessionId || !finalAgentSessionId) throw new Error('Agent 没有返回 sessionId')

    let text = result.isError
      ? sanitizeForUser(principal, result.text)
      : result.text
    let silentTurn = false
    if (!result.isError) {
      // 所有面向用户的回复统一清理控制标记；cron 的 silent 表示本次不打扰。
      const clean = sanitizeOutgoingText(text)
      if (source === 'cron' && clean.silent) {
        text = ''
        silentTurn = true
      } else {
        text = clean.text
      }
    }
    if (!text && !result.isError && !silentTurn) {
      logWarn('turn.empty', '', { principalId, source, turns: result.turns ?? 0 })
      text = '刚才那条没处理成功，再说一遍喵～'
    }

    store.ensureSession(principalId, finalSessionId, {
      name: sessionName,
      isMain,
      makeCurrent: !isCron,
    })
    // cron 的 Agent 会话是一次性的，不能覆盖聊天会话的 agentSessionId。
    if (!isCron) {
      store.setSessionAgentId(principalId, finalSessionId, finalAgentSessionId)
      // 手动压缩的交接已经进入新 Agent 会话，清掉暂存，避免下回合重复换挡。
      if (pendingHandoff !== null) {
        store.clearSessionPendingHandoff(principalId, finalSessionId)
      }
    }
    if (memorySnapshotDirty) {
      const snapshotWriteId = isCron ? CRON_SNAPSHOT_ID : finalSessionId
      store.writePromptSnapshot(principalId, snapshotWriteId, {
        memoryText: memory,
        agentSessionId: isCron ? null : finalAgentSessionId,
      })
    }
    // 补写还没落盘的记录（新会话 sessionId 来得太晚 / cron 等场景）
    if (includeUser && !userPersisted) {
      store.appendMessage(principalId, finalSessionId, userRecord)
    }
    if (toolsPersisted < toolRecords.length) {
      for (const rec of toolRecords.slice(toolsPersisted)) {
        store.appendMessage(principalId, finalSessionId, rec)
      }
    }
    // cron 的 silent 回合没有正文，不写入会话，避免之后在 App/通知里露出来。
    if (text) {
      store.appendMessage(principalId, finalSessionId, {
        type: 'assistant',
        text,
        source,
        isError: !!result.isError,
        timestamp: new Date().toISOString(),
      })
    }
    // 记下最近一次 cron 结果；下一轮聊天在尾部带上，方便主人追问时接话。
    if (source === 'cron' && text && !silentTurn && !result.isError) {
      try {
        store.writeLastCronResult(principalId, {
          text,
          at: new Date().toISOString(),
          source,
        })
      } catch {}
    }
    // 每次 cron 运行都写一条 workspace/cron-history.md，静默/失败也留痕。
    if (source === 'cron') {
      try {
        store.appendCronHistory(principalId, {
          at: new Date().toISOString(),
          task: taskLabel || '定时任务',
          text: text || '',
          silent: silentTurn,
          isError: !!result.isError,
          tools: toolRecords.map(record => record.name),
        })
      } catch {}
    }
    store.touchSession(principalId, finalSessionId)

    try {
      let transcriptEvents = []
      try {
        transcriptEvents = readTranscriptUsage(finalAgentSessionId, { sinceMs: turnStartedAt - 100 })
      } catch (err) {
        logWarn('usage.transcript.fail', err.message, { principalId })
      }

      // transcript 有本次回合的完整逐次 usage（含 output），优先使用；
      // 只有 transcript 不可用时，才退回流事件并按 messageId 去重。
      let callEvents = []
      if (transcriptEvents.length) {
        callEvents = transcriptEvents.filter(event => {
          const usage = event.usage || {}
          return (Number(usage.input_tokens) || 0)
            + (Number(usage.output_tokens) || 0)
            + (Number(usage.cache_read_input_tokens) || 0)
            + (Number(usage.cache_creation_input_tokens) || 0) > 0
        })
      } else {
        const callMap = new Map()
        for (const event of llmUsageRecords) {
          const usage = event.usage || {}
          const key = event.messageId
            || `${event.ts || ''}|${event.model || ''}|${usage.input_tokens || 0}|${usage.cache_read_input_tokens || 0}`
          if (!callMap.has(key)) {
            callMap.set(key, {
              ...event,
              messageId: key,
              usage: {
                input_tokens: Number(usage.input_tokens) || 0,
                output_tokens: Number(usage.output_tokens) || 0,
                cache_creation_input_tokens: Number(usage.cache_creation_input_tokens) || 0,
                cache_read_input_tokens: Number(usage.cache_read_input_tokens) || 0,
              },
              tools: Array.isArray(event.tools) ? [...event.tools] : [],
            })
            continue
          }
          const existing = callMap.get(key)
          for (const field of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
            existing.usage[field] = Math.max(
              existing.usage[field] || 0,
              Number(usage[field]) || 0,
            )
          }
          for (const tool of (event.tools || [])) {
            if (tool && !existing.tools.includes(tool)) existing.tools.push(tool)
          }
          existing.subagent = !!(existing.subagent || event.subagent)
          if (!existing.model && event.model) existing.model = event.model
        }
        callEvents = [...callMap.values()].filter(event => {
          const usage = event.usage || {}
          return (Number(usage.input_tokens) || 0)
            + (Number(usage.output_tokens) || 0)
            + (Number(usage.cache_read_input_tokens) || 0)
            + (Number(usage.cache_creation_input_tokens) || 0) > 0
        }).sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0))
      }

      if (callEvents.length) {
        for (const [callIndex, event] of callEvents.entries()) {
          const usage = event.usage || {}
          appendUsage(principalId, {
            sessionId: finalSessionId,
            turnId,
            level: 'call',
            messagePreview: callIndex === 0 ? messagePreview : '',
            source,
            capability: 'chat',
            model: event.model || userModel?.model || activeModel,
            provider: userModel?.provider || '',
            inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
            outputTokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
            turns: 1,
            latencyMs: 0,
            status: 'ok',
            tools: event.tools || [],
            subagent: !!event.subagent,
            ts: event.ts,
          })
        }
        logInfo('usage.calls', '', {
          principalId,
          sessionId: finalSessionId,
          count: callEvents.length,
          inputTokens: callEvents.reduce((sum, e) => sum + (Number(e.usage?.input_tokens) || 0), 0),
          outputTokens: callEvents.reduce((sum, e) => sum + (Number(e.usage?.output_tokens) || 0), 0),
          aggInputTokens: result.usage?.input_tokens ?? 0,
          aggOutputTokens: result.usage?.output_tokens ?? 0,
        })
      } else {
        // 没拿到逐次 usage 时退回整轮汇总记录，保证用量不丢
        appendUsage(principalId, {
          sessionId: finalSessionId,
          turnId,
          level: 'turn',
          messagePreview,
          source,
          capability: 'chat',
          model: userModel?.model || activeModel,
          provider: userModel?.provider || '',
          inputTokens: result.usage?.input_tokens ?? result.usage?.prompt_tokens ?? 0,
          outputTokens: result.usage?.output_tokens ?? result.usage?.completion_tokens ?? 0,
          cacheReadTokens: result.usage?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: result.usage?.cache_creation_input_tokens ?? 0,
          turns: result.turns ?? 0,
          latencyMs: Date.now() - turnStartedAt,
          status: result.isError ? 'error' : 'ok',
          tools: toolRecords.map(r => r.name),
        })
      }
    } catch (err) {
      logWarn('usage.append.fail', err.message, { principalId })
    }

    let savedContext = null
    // cron 的 Agent 上下文是一次性的，不覆盖聊天会话的上下文统计/压缩比例。
    if (!isCron && result.context) {
      try {
        savedContext = setSessionContext(principalId, finalSessionId, result.context)
        if (savedContext) {
          emit({ type: 'context', principalId, sessionId: finalSessionId, context: savedContext })
        }
      } catch (err) {
        logWarn('context.save.fail', err.message, { principalId })
      }
    }

    const finalResult = {
      text,
      cost: result.cost ?? 0,
      turns: result.turns ?? 0,
      isError: !!result.isError,
      sessionId: finalSessionId,
    }
    emit({ type: 'result', principalId, sessionId: finalSessionId, ...finalResult })
    return finalResult
  })
}

/**
 * 手动压缩当前会话上下文（App 顶部上下文条的按钮）。
 *
 * 与自动压缩共用 compactSessionContext：把较早消息压成长期记忆摘要。
 * 压缩完成后不立即换 Agent 会话，而是暂存「最近对话交接」；
 * 下一回合由 runTurn 换新 Agent 会话并注入，App 的聊天历史保持不变。
 *
 * @returns {Promise<{ok: boolean, error?: string, partial?: boolean, compactedUpto?: number}>}
 */
export async function compactSessionNow({ principalId, roleOverride = null } = {}) {
  if (!principalId) return { ok: false, error: '缺少用户信息' }
  const principal = buildEffectivePrincipal(principalId, roleOverride)

  return withPrincipalLock(principalId, async () => {
    const current = store.getCurrentSession(principalId)
    const displaySessionId = current?.sessionId || null
    if (!displaySessionId) {
      return { ok: false, error: '还没有会话，先发一条消息再来压缩喵' }
    }
    const modelConfig = resolveChatModel({ principalId, principal })
    if (modelConfig.error) {
      return { ok: false, error: modelConfig.error }
    }
    const compacted = await compactSessionContext({
      principalId,
      displaySessionId,
      apiKey: modelConfig.apiKey,
      baseUrl: modelConfig.baseUrl,
      authMode: modelConfig.authMode,
      model: modelConfig.activeModel,
    })
    if (!compacted) {
      return { ok: false, error: '没有可压缩的内容（消息太少，或已经处理过了）' }
    }
    if (compacted.partial) {
      // 旧消息还没压完：保留旧 Agent 会话，用户再点一次继续。
      return { ok: true, partial: true, compactedUpto: compacted.compactedUpto }
    }
    // 丢弃旧快照，下一回合按含压缩摘要的最新长期记忆重建 system prompt。
    store.clearPromptSnapshot(principalId, displaySessionId)
    store.setSessionPendingHandoff(principalId, displaySessionId, compacted.handoffBlock || '')
    // 上下文条跟着整理：压缩后旧历史会缩成交接块，先写一份预估快照，
    // 下一轮回复拿到真实 usage 后自然覆盖。pendingCompact 用于 App 标出「压缩后」。
    try {
      markSessionContextCompacted(principalId, displaySessionId, {
        handoffChars: String(compacted.handoffBlock || '').length,
      })
    } catch (err) {
      logWarn('context.compact.snapshot.fail', err.message, { principalId })
    }
    logInfo('context.compact.manual', '', {
      principalId,
      sessionId: displaySessionId,
      compactedUpto: compacted.compactedUpto,
      handoffChars: (compacted.handoffBlock || '').length,
    })
    return { ok: true, partial: false, compactedUpto: compacted.compactedUpto }
  })
}
