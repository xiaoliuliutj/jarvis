/**
 * 只读查询 worker。
 *
 * 把会话读取/用量汇总这类「查询」放到独立线程，主线程只负责执行
 * （对话、工具、调度、写消息）。即使主线程在跑同步重活，查询也不排队。
 *
 * 协议：{ id, op, args } -> { id, ok, result | error }
 */

import { parentPort } from 'node:worker_threads'
import * as readModel from './read-model.mjs'
import * as appStore from './app-store.mjs'

const OPS = {
  uiTail: a => readModel.tailUiMessages(a.principalId, a.sessionId, a.limit, a.readCursor),
  uiBefore: a => readModel.beforeUiMessages(a.principalId, a.sessionId, a.before, a.limit),
  uiAfter: a => readModel.afterUiMessages(a.principalId, a.sessionId, a.after, a.limit, a.readCursor),
  readInfo: a => readModel.uiReadInfo(a.principalId, a.sessionId, a.cursor),
  history: a => readModel.historyTexts(a.principalId, a.sessionId, a.limit),
  usageSummary: a => appStore.usageSummaryRange(a.principalId, {
    from: a.from,
    to: a.to,
    messageLimit: a.messageLimit,
    pricing: a.pricing,
  }),
  usageByTurn: a => appStore.listUsageByTurn(a.principalId, a.turnId, a.pricing),
}

parentPort.on('message', msg => {
  const handler = OPS[msg?.op]
  if (!handler) {
    parentPort.postMessage({ id: msg?.id, ok: false, error: `unknown op: ${msg?.op}` })
    return
  }
  Promise.resolve()
    .then(() => handler(msg.args || {}))
    .then(
      result => parentPort.postMessage({ id: msg.id, ok: true, result }),
      err => parentPort.postMessage({ id: msg.id, ok: false, error: err?.message || String(err) }),
    )
})
