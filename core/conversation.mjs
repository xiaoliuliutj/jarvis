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
} from './app-store.mjs'
import { readTranscriptUsage } from './usage-transcript.mjs'
import { compactSessionContext } from './context-compactor.mjs'
import { sanitizeOutgoingText } from './text-filter.mjs'

const locks = new Map()
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200000

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

/**
 * @param {object} opts
 * @param {string} opts.principalId
 * @param {string} opts.prompt
 * @param {string|null} opts.sessionId   指定续接的会话；为空时用当前会话
 * @param {boolean} opts.forceNew        强制新会话
 * @param {(event: object) => void} opts.emit
 * @returns {Promise<{text, cost, turns, isError, sessionId}>}
 */
export async function runTurn({ principalId, prompt, displayText = null, userAttachments = [], sessionId = null, forceNew = false, source = 'chat', emit = () => {}, roleOverride = null }) {
  const basePrincipal = getPrincipal(principalId)
  const principal = roleOverride
    ? {
        ...basePrincipal,
        role: roleOverride,
        capabilities: {
          ...basePrincipal.capabilities,
          editJarvisCode: roleOverride === 'owner' || roleOverride === 'maintainer',
          useGlobalModel: roleOverride === 'owner' || roleOverride === 'maintainer',
        },
      }
    : basePrincipal

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
    const displaySessionId = forceNew ? null : (sessionId || current?.sessionId || null)
    const resumeId = displaySessionId
    const sessionRecord = displaySessionId ? store.getSession(principalId, displaySessionId) : null
    let agentSessionId = forceNew ? null : (sessionRecord?.agentSessionId || displaySessionId || null)
    // 定时任务不续接聊天 Agent 会话：每次用全新的轻量 Agent 会话。
    // 这样巡检不会把日常聊天历史带进来，也不会覆盖主会话的 agentSessionId。
    if (isCron) agentSessionId = null
    let rotateAgent = false
    let handoffBlock = ''

    const persona = store.readPersona(principalId)
    const rules = store.readRulesText()

    const userModel = getChatRuntime(principalId)
    const canUseGlobal = !!principal.capabilities?.useGlobalModel
      || principal.role === 'owner'
      || principal.role === 'maintainer'

    // 普通用户没有自己的模型 Key 时，不能静默使用 owner 的全局 Key。
    if (!userModel && !canUseGlobal) {
      const hasChatConfig = listModels(principalId).some(m => m.capability === 'chat' && m.enabled !== false)
      return {
        text: hasChatConfig
          ? '你的对话模型还没有配置 API Key，请在 App 设置 → 模型与能力里补上。'
          : '当前账号还没有配置对话模型 API，请在 App 设置 → 模型与能力里添加自己的模型。',
        cost: 0,
        turns: 0,
        isError: true,
        sessionId: resumeId,
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
        text: userModel
          ? '模型配置里没有可用的 API Key，请检查配置。'
          : sanitizeForUser(principal, '未配置 API Key（config/agent.json 或 config/credentials.json）'),
        cost: 0,
        turns: 0,
        isError: true,
        sessionId: resumeId,
      }
    }

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
    const promptSnapshot = (!isCron && displaySessionId)
      ? store.readPromptSnapshot(principalId, displaySessionId)
      : null
    const snapshotMatchesAgent = !!(
      promptSnapshot
      && (!promptSnapshot.agentSessionId
        || !agentSessionId
        || promptSnapshot.agentSessionId === agentSessionId)
    )
    // 记忆渲染时已按 2%-4% 预算压缩、文件操作最多 40 条，
    // 渲染后的记忆不会超限；所以只在换挡/压缩时更新快照。
    const useSnapshot = snapshotMatchesAgent
    let memory = useSnapshot
      ? promptSnapshot.memoryText
      : store.formatMemory(principalId, {
          contextWindowTokens,
          deterministic: true,
          maxProjectFiles: 40,
        })
    let memorySnapshotDirty = !useSnapshot
    let systemPrompt = buildSystemPrompt({ principal, rules, persona, memory })
    const mcpServers = buildServers()
    const canUseTool = buildCanUseTool({ principal, workspace })
    let toolChars = 0
    try { toolChars = JSON.stringify(mcpServers || {}).length } catch {}
    let contextHints = {
      systemChars: Math.max(0, systemPrompt.length - memory.length),
      memoryChars: memory?.length || 0,
      toolChars,
    }

    // 上下文达到窗口 75% 时，把较早对话压成长期记忆，并换一个新的 Agent 会话；
    // App 的显示会话保持不变，所以历史聊天记录不会消失。
    // 定时任务使用一次性 Agent 会话，不参与聊天历史的压缩/换挡。
    if (!isCron && !forceNew && displaySessionId && agentSessionId) {
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
          systemPrompt = buildSystemPrompt({ principal, rules, persona, memory })
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
    const agentPrompt = `${handoffBlock}${buildTimeLine()}${prompt}`

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
    // 定时任务的 Agent 会话是一次性的，不能覆盖主会话的 agentSessionId。
    if (!isCron) {
      store.setSessionAgentId(principalId, finalSessionId, finalAgentSessionId)
      if (memorySnapshotDirty) {
        store.writePromptSnapshot(principalId, finalSessionId, {
          memoryText: memory,
          agentSessionId: finalAgentSessionId,
        })
      }
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
    // 定时任务的 Agent 上下文是一次性的，不能覆盖主会话的上下文统计/压缩比例。
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
