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
import { buildSystemPrompt } from './prompt.mjs'
import { buildCanUseTool } from './permissions.mjs'
import { buildMcpServers } from './tools.mjs'
import {
  getAgentEnv,
  getAnthropicCredentials,
  getModel,
  resolveAnthropicCredentials,
  resolveModel,
  buildAgentEnv,
} from './config.mjs'
import { logInfo, logWarn, logError } from './logger.mjs'
import { getChatRuntime, listModels, appendUsage } from './app-store.mjs'

const locks = new Map()

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
    store.ensureUser(principalId)

    const workspace = store.workspaceDir(principalId)
    const current = store.getCurrentSession(principalId)
    const resumeId = forceNew ? null : (sessionId || current?.sessionId || null)

    const persona = store.readPersona(principalId)
    const memory = store.formatMemory(principalId, 6000)
    const rules = store.readRulesText()
    const systemPrompt = buildSystemPrompt({ principal, rules, persona, memory })
    const mcpServers = buildMcpServers(principal)
    const canUseTool = buildCanUseTool({ principal, workspace })

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

    // cron 的内部 prompt 不是用户发的消息，不写入聊天记录。
    const includeUser = source !== 'cron'
    // 首次会话的名称：主会话固定叫“主会话”；用户 chat 取第一条消息；cron 叫“定时任务”
    const sessionName = principal.role === 'maintainer'
      ? '主会话'
      : (includeUser ? prompt.slice(0, 20) : '定时任务')
    const isMain = principal.role === 'maintainer'

    // ── 进行中即落盘 ─────────────────────────────────────────────────────────
    // 用户消息和工具记录不等回合结束才写。否则回合进行中切换会话/刷新历史时，
    // 已发出的消息和已执行的工具会“消失”，回合结束后才重新出现。
    let persistSessionId = resumeId        // 当前可落盘的会话 ID（新会话等 init 事件带回）
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
    const { run } = await import('../agents/agent.mjs')

    const runOnce = async () => {
      result = null
      for await (const event of run(prompt, {
        model: activeModel,
        apiKey,
        baseUrl,
        authMode,
        agentEnv,
        cwd: workspace,
        resumeSessionId: persistSessionId || resumeId,
        systemPrompt,
        mcpServers,
        canUseTool,
        reloadMcpServers: () => buildMcpServers(principal),
        memory: { append: (entry) => store.appendMemory(principalId, entry) },
      })) {
        if (event.type === 'session' && event.sessionId) {
          // 新会话首次运行：init 带回 sessionId，立刻补写用户消息
          if (!persistSessionId) persistSessionId = event.sessionId
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

    const finalSessionId = result.sessionId || persistSessionId
    if (!finalSessionId) throw new Error('Agent 没有返回 sessionId')

    let text = result.isError
      ? sanitizeForUser(principal, result.text)
      : result.text
    if (!text && !result.isError) {
      logWarn('turn.empty', '', { principalId, source, turns: result.turns ?? 0 })
      text = '刚才那条没处理成功，再说一遍喵～'
    }

    store.ensureSession(principalId, finalSessionId, {
      name: sessionName,
      isMain,
    })
    // 补写还没落盘的记录（新会话 sessionId 来得太晚 / cron 等场景）
    if (includeUser && !userPersisted) {
      store.appendMessage(principalId, finalSessionId, userRecord)
    }
    if (toolsPersisted < toolRecords.length) {
      for (const rec of toolRecords.slice(toolsPersisted)) {
        store.appendMessage(principalId, finalSessionId, rec)
      }
    }
    store.appendMessage(principalId, finalSessionId, {
      type: 'assistant',
      text,
      isError: !!result.isError,
      timestamp: new Date().toISOString(),
    })
    store.touchSession(principalId, finalSessionId)

    try {
      appendUsage(principalId, {
        sessionId: finalSessionId,
        source,
        capability: 'chat',
        model: userModel?.model || activeModel,
        provider: userModel?.provider || '',
        inputTokens: result.usage?.input_tokens ?? result.usage?.prompt_tokens ?? 0,
        outputTokens: result.usage?.output_tokens ?? result.usage?.completion_tokens ?? 0,
        cost: result.cost ?? 0,
        turns: result.turns ?? 0,
        latencyMs: Date.now() - turnStartedAt,
        status: result.isError ? 'error' : 'ok',
        tools: toolRecords.map(r => r.name),
      })
    } catch (err) {
      logWarn('usage.append.fail', err.message, { principalId })
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
