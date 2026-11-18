/**
 * Bridge 用户池调度器。
 *
 * 规则：
 *   - 全局并发 = concurrency（当前 2）
 *   - 同一 principal 串行（FIFO），不同 principal 可并行
 *   - main 会话不走这里，它在 Electron 进程里独占 main lane
 */

export class Scheduler {
  constructor({ concurrency = 2, onEvent = () => {} } = {}) {
    this.concurrency = concurrency
    this.onEvent = onEvent
    this.chains = new Map()   // principalId -> Promise
    this.active = 0
    this.waiters = []
  }

  _acquire() {
    if (this.active < this.concurrency) {
      this.active++
      return Promise.resolve()
    }
    return new Promise(resolve => this.waiters.push(resolve))
  }

  _release() {
    const next = this.waiters.shift()
    if (next) next()          // 把槽位直接交给等待者，active 不变
    else this.active--
  }

  enqueue(principalId, fn) {
    this.onEvent({ type: 'queued', principalId })

    const prev = this.chains.get(principalId) || Promise.resolve()
    const next = prev.catch(() => {}).then(async () => {
      await this._acquire()
      this.onEvent({ type: 'active', principalId })
      try {
        return await fn()
      } finally {
        this.onEvent({ type: 'released', principalId })
        this._release()
      }
    })

    this.chains.set(principalId, next)
    return next.finally(() => {
      if (this.chains.get(principalId) === next) this.chains.delete(principalId)
    })
  }

  getStatus() {
    return {
      concurrency: this.concurrency,
      active: this.active,
      principals: [...this.chains.keys()],
    }
  }
}
