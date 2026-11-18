/**
 * Claude Code Agent
 *
 * 这一层只负责“调用 Claude Agent SDK 并产出事件”，不再负责：
 *   - 读取全局记忆 / 用户记忆（由 core/prompt 注入）
 *   - 会话存储（由 core/user-store + core/conversation 负责）
 *   - 工具注册（由 core/tools 注入 mcpServers）
 *   - 权限规则（由 core/permissions 注入 canUseTool）
 *
 * 插件接口：
 *   name / description / models / permissionModes
 *   run(prompt, options) -> async generator
 *     yield { type: 'tool',   name, input }
 *     yield { type: 'text',   text }
 *     yield { type: 'memory', action, entry }
 *     yield { type: 'result', text, cost, turns, isError, sessionId }
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import path from 'path'
import fs from 'fs'

export const name = 'Claude Code'
export const description = '基于 Claude Agent SDK，内置完整 Claude Code 工具集（Read/Bash/Edit/Grep/Glob…）'

export const models = [
  { id: 'claude-opus-5-5',   label: 'Opus 5.5',   desc: '最强 · $4/$20',    default: false },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', desc: '均衡 · $2/$10',    default: true  },
  { id: 'claude-haiku-5-5',  label: 'Haiku 5.5',  desc: '快速 · $0.1/$0.5', default: false },
]

export const permissionModes = [
  { id: 'default', label: '规则控制（core/permissions）' },
]

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MEMORY_TRIGGER_RE = /记住|记一下|别忘了|记录一下|remember\s+that|make\s+a\s+note/i
const SIGNAL_FILE = path.join(import.meta.dirname, 'tools', '_reload.signal')

/**
 * @param {string} prompt
 * @param {object} options
 * @param {string} options.model
 * @param {string} options.apiKey
 * @param {string} options.baseUrl
 * @param {string} options.cwd
 * @param {string|null} options.resumeSessionId
 * @param {string} options.systemPrompt        由 core/prompt 生成的完整 prompt
 * @param {object} options.mcpServers          由 core/tools 生成的 MCP 配置
 * @param {Function} options.canUseTool        由 core/permissions 生成的权限回调
 * @param {{append: Function}} options.memory  记忆写入回调（按 principal）
 * @param {Function} options.reloadMcpServers  工具热加载回调
 */
export async function* run(prompt, options = {}) {
  const {
    model,
    apiKey,
    baseUrl,
    cwd,
    resumeSessionId,
    systemPrompt = '',
    mcpServers = {},
    canUseTool,
    memory,
    reloadMcpServers,
  } = options

  if (!apiKey) {
    yield { type: 'result', text: '未配置 API Key（config/credentials.json）', cost: 0, turns: 0, isError: true, sessionId: null }
    return
  }

  // Claude Agent SDK 通过 PATH 找 node 来启动 MCP server；把当前 node 目录补进去。
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

  const queryOptions = {
    cwd,
    model,
    permissionMode: 'default',
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    env: injectedEnv,
    systemPrompt,
    mcpServers,
    canUseTool,
  }

  let collectedText = ''
  const fileOpsThisTurn = []
  let signalWatcher = null
  let activeSessionId = resumeSessionId || null

  try {
    const q = query({ prompt, options: queryOptions })

    // 确保热加载信号文件存在（_meta 创建用户工具后会写它）
    if (!fs.existsSync(SIGNAL_FILE)) fs.writeFileSync(SIGNAL_FILE, '', 'utf-8')

    let lastSignal = ''
    signalWatcher = fs.watch(SIGNAL_FILE, async () => {
      try {
        const sig = fs.readFileSync(SIGNAL_FILE, 'utf-8').trim()
        if (sig === lastSignal) return
        lastSignal = sig
        if (reloadMcpServers) await q.setMcpServers(reloadMcpServers())
      } catch (err) {
        console.error('[agent] 工具热加载失败:', err.message)
      }
    })

    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
        activeSessionId = msg.session_id
      }

      if (msg.type === 'assistant') {
        for (const block of (msg.message?.content ?? [])) {
          if (block.type === 'tool_use') {
            yield { type: 'tool', name: block.name, input: block.input }

            if (WRITE_TOOLS.has(block.name)) {
              const filePath = block.input?.path || block.input?.file_path || ''
              if (filePath) fileOpsThisTurn.push({ tool: block.name, path: filePath })
            }
          } else if (block.type === 'text' && block.text) {
            const cleanText = block.text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim()
            if (cleanText) {
              collectedText += cleanText
              yield { type: 'text', text: cleanText }
            }
          }
        }
        continue
      }

      if (msg.type === 'result') {
        const text = msg.result || collectedText

        // [MEMORY:type:content] → 当前用户长期记忆
        const memoryMatches = [...text.matchAll(/\[MEMORY:(\w+):([^\]]+)\]/g)]
        for (const [, mType, mContent] of memoryMatches) {
          if (!memory?.append) continue
          const entry = memory.append({ content: mContent.trim(), type: mType, refs: [] })
          yield { type: 'memory', action: 'append', entry }
        }

        // 文件写操作也记入当前用户记忆
        for (const op of fileOpsThisTurn) {
          if (!memory?.append) continue
          const entry = memory.append({
            content: `${op.tool === 'Write' ? '创建' : '编辑'}了文件 ${op.path}`,
            type: 'project_file',
            refs: [op.path],
          })
          yield { type: 'memory', action: 'file_op', entry }
        }

        if (MEMORY_TRIGGER_RE.test(prompt) && !memoryMatches.length && memory?.append) {
          const entry = memory.append({ content: `用户要求记住：${prompt.slice(0, 200)}`, type: 'fact', refs: [] })
          yield { type: 'memory', action: 'append', entry }
        }

        yield {
          type: 'result',
          text,
          cost: msg.total_cost_usd ?? 0,
          turns: msg.num_turns ?? 0,
          isError: msg.is_error ?? (msg.subtype !== 'success'),
          sessionId: msg.session_id ?? activeSessionId,
        }
        return
      }
    }

    yield {
      type: 'result',
      text: collectedText,
      cost: 0,
      turns: 0,
      isError: !collectedText,
      sessionId: activeSessionId,
    }
  } catch (err) {
    yield { type: 'result', text: `Error: ${err.message}`, cost: 0, turns: 0, isError: true, sessionId: activeSessionId }
  } finally {
    signalWatcher?.close()
  }
}
