/**
 * 查询 worker 客户端。
 *
 * - 懒加载 worker（core/query-worker.mjs），调用方只关心 op + args
 * - worker 不可用 / 超时 / 崩溃时，queryOr() 会回退到主线程的同名实现，
 *   保证 App 查询功能不因拆线程而整体挂掉
 */

import { Worker } from 'node:worker_threads'

const WORKER_URL = new URL('./query-worker.mjs', import.meta.url)

let worker = null
let nextId = 1
let disabled = false
const pending = new Map()

function rejectAll(err) {
  for (const [, item] of pending) {
    clearTimeout(item.timer)
    item.reject(err)
  }
  pending.clear()
}

function ensureWorker() {
  if (disabled) return null
  if (worker) return worker
  try {
    worker = new Worker(WORKER_URL)
  } catch (err) {
    disabled = true
    console.warn('[query] worker 启动失败，查询回退主线程：', err.message)
    return null
  }
  worker.on('message', msg => {
    const item = pending.get(msg?.id)
    if (!item) return
    pending.delete(msg.id)
    clearTimeout(item.timer)
    if (msg.ok) item.resolve(msg.result)
    else item.reject(new Error(msg.error || '查询失败'))
  })
  worker.on('error', err => {
    console.warn('[query] worker 异常，查询回退主线程：', err.message)
    worker = null
    rejectAll(err)
  })
  worker.on('exit', () => {
    if (!worker) return
    worker = null
    rejectAll(new Error('query worker 已退出'))
  })
  return worker
}

export function callQuery(op, args, { timeoutMs = 20000 } = {}) {
  const w = ensureWorker()
  if (!w) return Promise.reject(new Error('query worker 不可用'))
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`query timeout: ${op}`))
    }, timeoutMs)
    timer.unref?.()
    pending.set(id, { resolve, reject, timer })
    w.postMessage({ id, op, args })
  })
}

/** 查询优先走 worker；失败时用 fallback 在主线程算，返回同样的结果。 */
export async function queryOr(op, args, fallback, options) {
  try {
    return await callQuery(op, args, options)
  } catch {
    return await fallback()
  }
}
