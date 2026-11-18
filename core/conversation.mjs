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
import { getAgentEnv, getAnthropicCredentials, getModel } from './config.mjs'

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
export async function runTurn({ principalId, prompt, sessionId = null, forceNew = false, source = 'chat', emit = () => {} }) {
  const principal = getPrincipal(principalId)

  return withPrincipalLock(principalId, async () => {
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

    const { apiKey, baseUrl, authMode } = getAnthropicCredentials()
    if (!apiKey) {
      return {
        text: sanitizeForUser(principal, '未配置 API Key（config/agent.json 或 config/credentials.json）'),
        cost: 0,
        turns: 0,
        isError: true,
        sessionId: resumeId,
      }
    }

    // cron 的内部 prompt 不是用户发的消息，不写入聊天记录。
    const includeUser = source !== 'cron'
    const turnRecords = includeUser
      ? [{ type: 'user', text: prompt, timestamp: new Date().toISOString() }]
      : []

    let result = null
    const { run } = await import('../agents/claude-cc/agent.mjs')

    for await (const event of run(prompt, {
      model: getModel(),
      apiKey,
      baseUrl,
      authMode,
      agentEnv: getAgentEnv(),
      cwd: workspace,
      resumeSessionId: resumeId,
      systemPrompt,
      mcpServers,
      canUseTool,
      reloadMcpServers: () => buildMcpServers(principal),
      memory: { append: (entry) => store.appendMemory(principalId, entry) },
    })) {
      if (event.type === 'tool') {
        turnRecords.push({
          type: 'tool',
          name: event.name,
          input: event.input,
          timestamp: new Date().toISOString(),
        })
        emit({ ...event, principalId, sessionId: resumeId })
      } else if (event.type === 'text') {
        emit({ ...event, principalId, sessionId: resumeId })
      } else if (event.type === 'memory') {
        emit({ ...event, principalId, sessionId: resumeId })
      } else if (event.type === 'result') {
        result = event
      }
    }

    if (!result) throw new Error('Agent 没有返回 result')

    const finalSessionId = result.sessionId || resumeId
    if (!finalSessionId) throw new Error('Agent 没有返回 sessionId')

    const text = result.isError
      ? sanitizeForUser(principal, result.text)
      : result.text

    // 首次会话的名称：主会话固定叫“主会话”；用户 chat 取第一条消息；cron 叫“定时任务”
    const sessionName = principal.role === 'maintainer'
      ? '主会话'
      : (includeUser ? prompt.slice(0, 20) : '定时任务')
    store.ensureSession(principalId, finalSessionId, {
      name: sessionName,
      isMain: principal.role === 'maintainer',
    })
    for (const rec of turnRecords) store.appendMessage(principalId, finalSessionId, rec)
    store.appendMessage(principalId, finalSessionId, {
      type: 'assistant',
      text,
      timestamp: new Date().toISOString(),
    })
    store.touchSession(principalId, finalSessionId)

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
