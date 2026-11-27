/**
 * admin_request —— 管理员权限远程授权工具（仅 owner/main）
 *
 * 工作原理：
 *   1. setup：以管理员身份（UAC 点一次「是」）注册计划任务 JarvisAdminBridge，
 *      该任务以「最高权限」运行 run.ps1。之后触发该任务不再需要 UAC。
 *   2. run：向本机 Bridge 发起授权请求 → Bridge 推送到主人手机（Jarvis App 弹出
 *      允许/拒绝卡片 + 系统通知）→ 主人远程点「允许」后：
 *      写 request.json + cmd-<id>.ps1 → schtasks /run → 轮询 result-<id>.json → 返回输出。
 *   3. status：查看任务是否注册、最近一次执行、审计日志。
 *
 * 说明：这是「主人知情并手动授权」的自动化通道，不是安全边界——
 * 计划任务注册后，本机任何以该用户身份运行的代码都能触发它。请仅信任本机环境。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execFile } from 'child_process'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const SCRIPTS = path.join(import.meta.dirname, 'scripts')
const BRIDGE_DIR = path.join(ROOT, 'userdata', 'admin-bridge')
const TASK_NAME = 'JarvisAdminBridge'
const POWERSHELL = 'powershell.exe'
const BRIDGE_HTTP = 'http://127.0.0.1:7779'
const DEFAULT_APPROVAL_TIMEOUT_SEC = 300

function ensureDir() {
  fs.mkdirSync(BRIDGE_DIR, { recursive: true })
}

function stripBom(s) {
  return typeof s === 'string' && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

/** 执行外部命令，返回 {code, stdout, stderr, error}，不因非零退出码抛异常。 */
function run(file, args, opts = {}) {
  return new Promise(resolve => {
    execFile(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
      resolve({ code, stdout: stdout || '', stderr: stderr || '', error: error || null })
    })
  })
}

async function taskExists() {
  const r = await run('schtasks.exe', ['/query', '/tn', TASK_NAME])
  return r.code === 0
}

/**
 * 向手机推送授权请求并等待决定。
 * 返回 'allow' | 'deny' | 'timeout' | 'phone_offline'
 */
async function askRemoteApproval({ summary, command, timeoutSec }) {
  const principalId = String(process.env.JARVIS_PRINCIPAL_ID || '')
  const timeout = Math.min(Math.max(Number(timeoutSec) || DEFAULT_APPROVAL_TIMEOUT_SEC, 30), 1800)
  let res
  try {
    res = await fetch(BRIDGE_HTTP + '/admin-approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ principalId, summary, command, timeoutSec: timeout }),
    })
  } catch (err) {
    throw new Error(`Bridge 内部通道不可用（${err.message}）——无法发起远程授权`)
  }
  let data = {}
  try { data = await res.json() } catch {}
  if (!res.ok) throw new Error(data.error || `Bridge 返回 HTTP ${res.status}`)
  return String(data.decision || 'timeout')
}

/** 触发计划任务并等待结果文件。 */
async function runElevated({ summary, command, workDir, timeoutSec }) {
  ensureDir()
  const id = Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex')
  const resultFile = path.join(BRIDGE_DIR, `result-${id}.json`)
  const cmdFile = path.join(BRIDGE_DIR, `cmd-${id}.ps1`)

  // 命令写成 .ps1 文件执行（带 BOM，保证中文正常）
  fs.writeFileSync(cmdFile, '\uFEFF' + command, 'utf8')

  const request = {
    id,
    summary,
    commandFile: cmdFile,
    commandPreview: command.slice(0, 2000),
    workDir: workDir || null,
    timeoutSec: Math.min(Math.max(Number(timeoutSec) || 120, 10), 1800),
    createdAt: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(BRIDGE_DIR, 'request.json'), JSON.stringify(request, null, 2), 'utf8')

  const trigger = await run('schtasks.exe', ['/run', '/tn', TASK_NAME])
  if (trigger.code !== 0) {
    return {
      ok: false,
      error: `触发计划任务失败（${trigger.code}）：${(trigger.stderr || trigger.stdout).trim() || '未知错误'}`,
    }
  }

  const deadline = Date.now() + (request.timeoutSec + 90) * 1000
  let result = null
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 400))
    if (fs.existsSync(resultFile)) {
      try {
        const raw = stripBom(fs.readFileSync(resultFile, 'utf8'))
        const parsed = JSON.parse(raw)
        if (parsed && parsed.id === id) { result = parsed; break }
      } catch {}
    }
  }

  try { fs.unlinkSync(cmdFile) } catch {}

  if (!result) {
    return {
      ok: false,
      error: `等待结果超时（任务可能未运行、被系统取消，或命令超过 ${request.timeoutSec}s 仍在执行）。审计日志：${path.join(BRIDGE_DIR, 'audit.log')}`,
    }
  }

  try { fs.unlinkSync(resultFile) } catch {}

  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    timedOut: !!result.timedOut,
    durationMs: result.durationMs,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  }
}

function clip(text, max) {
  const s = String(text || '')
  if (s.length <= max) return s
  return s.slice(0, max) + `\n…（已截断，共 ${s.length} 字符）`
}

const server = new McpServer({ name: 'admin_request', version: '1.1.0' })

server.tool(
  'admin_request',
  '申请管理员权限执行命令：向主人手机（Jarvis App）推送授权请求，主人远程点「允许」后以管理员权限运行并返回输出。' +
  '首次使用前需执行 action=setup 注册计划任务（在电脑上点一次 UAC）。仅 owner/main 可用。',
  {
    action: z.enum(['setup', 'run', 'status']).optional().describe('setup=注册计划任务（一次性）；run=申请授权并执行；status=查看状态'),
    summary: z.string().optional().describe('run：向主人说明要做什么、为什么（显示在手机授权卡片里）'),
    command: z.string().optional().describe('run：要执行的 PowerShell 命令/脚本'),
    workDir: z.string().optional().describe('run：工作目录，默认 C:\\Windows\\System32'),
    timeoutSec: z.number().optional().describe('run：命令超时秒数，默认 120，最大 1800'),
  },
  async ({ action = 'run', summary, command, workDir, timeoutSec } = {}) => {
    try {
      if (action === 'setup') {
        const already = await taskExists()
        if (already) {
          return { content: [{ type: 'text', text: `✅ 计划任务 ${TASK_NAME} 已存在，无需重复注册。\n（如需重建，先用 schtasks /delete /tn ${TASK_NAME} 删除后重跑 setup）` }] }
        }
        const r = await run(POWERSHELL, [
          '-NoProfile', '-ExecutionPolicy', 'Bypass',
          '-File', path.join(SCRIPTS, 'launch-setup.ps1'),
        ], { timeout: 200 * 1000 })
        if (r.code !== 0) {
          const hint = r.code === 1223 ? '（主人在 UAC 弹窗点了「否」或未处理）' : ''
          return { content: [{ type: 'text', text: `❌ 注册计划任务失败，退出码 ${r.code}${hint}\n${clip((r.stderr || r.stdout).trim(), 1500)}` }] }
        }
        const okNow = await taskExists()
        return {
          content: [{
            type: 'text',
            text: okNow
              ? `✅ 已注册计划任务 ${TASK_NAME}（最高权限，按需运行）。以后 admin_request 会推送授权卡片到手机，主人手机上点「允许」即执行。`
              : `⚠️ 脚本执行完成但未查到任务 ${TASK_NAME}，请检查 setup-task.ps1 输出：\n${clip((r.stdout || r.stderr).trim(), 1500)}`,
          }],
        }
      }

      if (action === 'status') {
        const exists = await taskExists()
        let lastRun = ''
        try { lastRun = stripBom(fs.readFileSync(path.join(BRIDGE_DIR, 'last-run-id.txt'), 'utf8')).trim() } catch {}
        let auditTail = ''
        try {
          const lines = stripBom(fs.readFileSync(path.join(BRIDGE_DIR, 'audit.log'), 'utf8')).trim().split('\n')
          auditTail = lines.slice(-5).join('\n')
        } catch {}
        const q = await run('schtasks.exe', ['/query', '/tn', TASK_NAME, '/fo', 'LIST', '/v'])
        return {
          content: [{
            type: 'text',
            text: [
              `计划任务：${exists ? '已注册' : '未注册（先执行 action=setup）'}`,
              exists ? clip(q.stdout.trim(), 1200) : '',
              `最近执行请求ID：${lastRun || '（无记录）'}`,
              auditTail ? `最近审计记录：\n${clip(auditTail, 1500)}` : '（暂无审计日志）',
            ].filter(Boolean).join('\n\n'),
          }],
        }
      }

      // action === 'run'
      if (!command || !command.trim()) {
        return { isError: true, content: [{ type: 'text', text: '❌ 缺少 command：请提供需要管理员权限执行的 PowerShell 命令。' }] }
      }
      if (!summary || !summary.trim()) {
        return { isError: true, content: [{ type: 'text', text: '❌ 缺少 summary：请说明要做什么、为什么（会显示在手机授权卡片里）。' }] }
      }
      if (!(await taskExists())) {
        return { isError: true, content: [{ type: 'text', text: '⚠️ 尚未注册管理员通道。请先调用 admin_request（action=setup），在电脑上点一次 UAC「是」即可。' }] }
      }

      const approval = await askRemoteApproval({ summary: summary.trim(), command, timeoutSec })
      if (approval === 'phone_offline') {
        return { isError: true, content: [{ type: 'text', text: '📵 手机 App 不在线，无法远程授权。请打开 Jarvis App（或等它重连）后重试。' }] }
      }
      if (approval === 'deny') {
        return { content: [{ type: 'text', text: '🚫 主人拒绝了本次管理员授权，命令未执行。' }] }
      }
      if (approval === 'timeout') {
        return { content: [{ type: 'text', text: '⏰ 授权请求超时（主人在手机上未及时处理），命令未执行。' }] }
      }

      const result = await runElevated({ summary, command, workDir, timeoutSec })
      if (!result.ok && result.error) {
        return { isError: true, content: [{ type: 'text', text: `❌ ${result.error}` }] }
      }
      const parts = [
        result.ok ? `✅ 执行成功（退出码 0，用时 ${result.durationMs ?? '?'}ms）` : `⚠️ 执行完成但退出码 ${result.exitCode}${result.timedOut ? '（命令超时被终止）' : ''}`,
      ]
      if (result.stdout) parts.push(`输出：\n${clip(result.stdout.trim(), 6000)}`)
      if (result.stderr) parts.push(`错误输出：\n${clip(result.stderr.trim(), 4000)}`)
      if (!result.stdout && !result.stderr) parts.push('（无输出）')
      return { content: [{ type: 'text', text: parts.join('\n\n') }] }
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `❌ admin_request 失败：${err.message}` }] }
    }
  }
)

await server.connect(new StdioServerTransport())
