/**
 * 管理员授权请求（远程审批）。
 *
 * 流程：本地工具（admin_request）→ Bridge /admin-approval → 推送到手机 App →
 * 主人在手机上点「允许/拒绝」→ Bridge 把决定返回给工具 → 工具走计划任务提权执行。
 *
 * 仅内存保存（请求是短时事务，Bridge 重启后未决请求即失效，由工具超时兜底）。
 */

import crypto from 'crypto'

const approvals = new Map()
const MAX_PENDING = 20

function genId() {
  return 'ap_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex')
}

function publicView(a) {
  return {
    id: a.id,
    summary: a.summary,
    command: a.command,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
  }
}

function settle(id, decision) {
  const a = approvals.get(id)
  if (!a) return
  if (a.status === 'pending') a.status = 'settled'
  a.decision = decision
  try { clearTimeout(a.timer) } catch {}
  for (const waiter of a.waiters) {
    try { waiter(decision) } catch {}
  }
  a.waiters.clear()
  approvals.delete(id)
}

function sweepExpired() {
  const now = Date.now()
  for (const [id, a] of approvals) {
    if (a.expiresAt <= now) settle(id, 'timeout')
  }
}

/**
 * 创建一条待审批请求。
 * @returns {{id, summary, command, createdAt, expiresAt}}
 */
export function createApproval({ principalId, summary, command, timeoutSec = 300 }) {
  sweepExpired()
  if (approvals.size >= MAX_PENDING) {
    // 丢掉最旧的一条，避免无限堆积
    const oldest = [...approvals.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0]
    if (oldest) settle(oldest.id, 'timeout')
  }
  const timeout = Math.min(Math.max(Number(timeoutSec) || 300, 30), 1800)
  const id = genId()
  const now = Date.now()
  const record = {
    id,
    principalId: String(principalId || ''),
    summary: String(summary || '').slice(0, 2000),
    command: String(command || '').slice(0, 4000),
    status: 'pending',
    decision: null,
    createdAt: new Date(now).toISOString(),
    expiresAt: now + timeout * 1000,
    waiters: new Set(),
    timer: setTimeout(() => settle(id, 'timeout'), timeout * 1000),
  }
  record.timer.unref?.()
  approvals.set(id, record)
  return publicView(record)
}

/** 手机端提交决定。返回 false 表示请求不存在/过期/不属于该用户。 */
export function decideApproval(id, principalId, decision) {
  const a = approvals.get(String(id || ''))
  if (!a || a.status !== 'pending') return false
  if (principalId && a.principalId && a.principalId !== String(principalId)) return false
  if (a.expiresAt <= Date.now()) {
    settle(a.id, 'timeout')
    return false
  }
  settle(a.id, decision === 'allow' ? 'allow' : 'deny')
  return true
}

/** 等待决定：'allow' | 'deny' | 'timeout' */
export function waitForDecision(id, maxWaitMs = 300_000) {
  sweepExpired()
  const a = approvals.get(String(id || ''))
  if (!a) return Promise.resolve('timeout')
  if (a.status !== 'pending') return Promise.resolve(a.decision || 'timeout')
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      a.waiters.delete(waiter)
      resolve('timeout')
    }, Math.min(Math.max(Number(maxWaitMs) || 300_000, 1000), 1_900_000))
    timer.unref?.()
    const waiter = (decision) => {
      clearTimeout(timer)
      resolve(decision || 'timeout')
    }
    a.waiters.add(waiter)
  })
}

/** 列出某用户仍在等待的请求（App 重连后补拉）。 */
export function listPendingApprovals(principalId) {
  sweepExpired()
  const out = []
  for (const a of approvals.values()) {
    if (a.status !== 'pending') continue
    if (principalId && a.principalId && a.principalId !== String(principalId)) continue
    out.push(publicView(a))
  }
  return out.sort((x, y) => x.expiresAt - y.expiresAt)
}
