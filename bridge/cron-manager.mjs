/**
 * cron-manager.mjs
 *
 * 定时任务管理器。每分钟检查一次，到点触发对应 adapter 的 agent 执行 prompt，
 * 结果通过 adapter 的 send() 主动推送给用户。
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url))

// 外部注入（由 server.mjs 初始化）
let adaptersSendMap = null
let runAgentFn = null    // (adapterId, prompt) => Promise<string>  返回回复文本
let broadcastFn = null

export function initCronManager({ adapters, runAgent, broadcast }) {
  adaptersSendMap = adapters
  runAgentFn = runAgent
  broadcastFn = broadcast
}

// ── 配置读取 ──────────────────────────────────────────────────────────────────

function loadCrons() {
  const cfgPath = path.join(BRIDGE_DIR, '..', 'config', 'bridge.json')
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    return cfg.crons ?? []
  } catch { return [] }
}

// ── 时间匹配 ──────────────────────────────────────────────────────────────────

function matchesNow(schedule) {
  const now = new Date()
  if (schedule.hour !== undefined && schedule.hour !== now.getHours()) return false
  if (schedule.minute !== undefined && schedule.minute !== now.getMinutes()) return false
  if (schedule.dayOfWeek !== undefined) {
    // 0=周日,1=周一,...,6=周六，支持数组
    const days = Array.isArray(schedule.dayOfWeek) ? schedule.dayOfWeek : [schedule.dayOfWeek]
    if (!days.includes(now.getDay())) return false
  }
  return true
}

// ── 执行单个 cron ─────────────────────────────────────────────────────────────

async function executeCron(cron) {
  console.log(`[cron] 触发任务: ${cron.id} (${cron.adapterId})`)
  broadcastFn?.({ type: 'cron_start', cronId: cron.id, adapterId: cron.adapterId })

  try {
    const text = await runAgentFn(cron.adapterId, cron.prompt)
    if (text) {
      // 主动推送给用户（不依赖 context_token）
      const toUser = cron.toUser || loadDefaultUser(cron.adapterId)
      if (toUser) {
        await adaptersSendMap[cron.adapterId]?.send(toUser, text)
        console.log(`[cron] 任务 ${cron.id} 完成，已发送给 ${toUser}`)
      } else {
        console.warn(`[cron] 任务 ${cron.id}: 未找到目标用户ID，请在 cron 配置里加 "toUser"`)
      }
    }
    broadcastFn?.({ type: 'cron_done', cronId: cron.id, adapterId: cron.adapterId })
  } catch (err) {
    console.error(`[cron] 任务 ${cron.id} 失败:`, err.message)
    broadcastFn?.({ type: 'cron_error', cronId: cron.id, error: err.message })
  }
}

// 从会话历史里找该 adapter 最近一次用户的 from ID
function loadDefaultUser(adapterId) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, '..', 'config', 'bridge.json'), 'utf8'))
    if (cfg.adapters[adapterId]?.defaultUser) return cfg.adapters[adapterId].defaultUser

    // 从消息历史里找
    const sessionsBase = path.join(BRIDGE_DIR, '..', 'agents', 'claude-cc', 'memory', 'sessions')
    for (const h of fs.readdirSync(sessionsBase)) {
      const idxPath = path.join(sessionsBase, h, 'index.json')
      if (!fs.existsSync(idxPath)) continue
      const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
      for (const s of idx) {
        if (!s.cwd?.includes(adapterId) || !s.sessionId) continue
        const msgFile = path.join(sessionsBase, h, s.sessionId + '.messages.jsonl')
        if (!fs.existsSync(msgFile)) continue
        const lines = fs.readFileSync(msgFile, 'utf8').trim().split('\n').filter(Boolean)
        const lastUser = lines.map(l => JSON.parse(l)).filter(r => r.type === 'user' && r.from).pop()
        if (lastUser?.from) return lastUser.from
      }
    }
  } catch {}
  return null
}

// ── 启动定时检查 ──────────────────────────────────────────────────────────────

let cronInterval = null
// 记录已触发的任务（防止同一分钟内多次触发）
const firedThisMinute = new Set()
let lastMinute = -1

export function startCronManager() {
  // 每 10 秒检查一次（精度 ±10 秒，省电）
  cronInterval = setInterval(() => {
    const now = new Date()
    const currentMinute = now.getHours() * 60 + now.getMinutes()

    // 新的一分钟，清空已触发记录
    if (currentMinute !== lastMinute) {
      firedThisMinute.clear()
      lastMinute = currentMinute
    }

    const crons = loadCrons()
    for (const cron of crons) {
      if (!cron.enabled) continue
      if (firedThisMinute.has(cron.id)) continue
      if (!matchesNow(cron.schedule)) continue

      firedThisMinute.add(cron.id)
      executeCron(cron).catch(console.error)
    }
  }, 10_000)

  console.log('[cron] 定时任务管理器已启动')
}

export function stopCronManager() {
  if (cronInterval) { clearInterval(cronInterval); cronInterval = null }
  stopInactivityWatcher()
}

// ── 不活跃主动联系 ────────────────────────────────────────────────────────────

let inactivityTimer = null

/**
 * 读取所有 adapter 的消息历史，找到最近一次用户消息的时间和来源 adapter。
 * 返回 { lastActiveMs, adapterId, toUser } 或 null
 */
function findLastUserActivity() {
  const sessionsBase = path.join(BRIDGE_DIR, '..', 'agents', 'claude-cc', 'memory', 'sessions')
  let latest = null  // { ts, adapterId, toUser }

  try {
    for (const h of fs.readdirSync(sessionsBase)) {
      const idxPath = path.join(sessionsBase, h, 'index.json')
      if (!fs.existsSync(idxPath)) continue
      const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
      for (const s of idx) {
        if (!s.sessionId) continue
        const msgFile = path.join(sessionsBase, h, s.sessionId + '.messages.jsonl')
        if (!fs.existsSync(msgFile)) continue
        const lines = fs.readFileSync(msgFile, 'utf8').trim().split('\n').filter(Boolean)
        const userMsgs = lines.map(l => { try { return JSON.parse(l) } catch { return null } })
          .filter(r => r?.type === 'user' && r.from && r.timestamp)
        if (!userMsgs.length) continue
        const last = userMsgs[userMsgs.length - 1]
        const ts = new Date(last.timestamp).getTime()
        if (!latest || ts > latest.ts) {
          // 从 cwd 推断 adapterId
          const adapterId = s.cwd?.includes('bridge')
            ? s.cwd.split(/[/\\]/).pop()   // bridge/sessions/<adapterId>
            : 'electron'
          latest = { ts, adapterId, toUser: last.from }
        }
      }
    }
  } catch (err) {
    console.error('[inactivity] 读取消息历史失败:', err.message)
  }

  return latest
}

/**
 * 判断当前是否在安静时段（不打扰）。
 * 默认 22:00 ~ 8:00 不主动联系。
 */
function isQuietHours() {
  const cfg = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, '..', 'config', 'bridge.json'), 'utf8'))
  const quiet = cfg.inactivity?.quietHours ?? { start: 22, end: 8 }
  const hour = new Date().getHours()
  if (quiet.start > quiet.end) {
    // 跨午夜：22~24 或 0~8
    return hour >= quiet.start || hour < quiet.end
  }
  return hour >= quiet.start && hour < quiet.end
}

/**
 * 随机选取下一次检查的延迟（毫秒）。
 * 默认在 minHours ~ maxHours 之间随机。
 */
function randomDelay() {
  const cfg = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, '..', 'config', 'bridge.json'), 'utf8'))
  const minH = cfg.inactivity?.minHours ?? 1
  const maxH = cfg.inactivity?.maxHours ?? 5
  const ms = (minH + Math.random() * (maxH - minH)) * 60 * 60 * 1000
  return Math.round(ms)
}

async function checkInactivity() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, '..', 'config', 'bridge.json'), 'utf8'))
    if (!cfg.inactivity?.enabled) return

    if (isQuietHours()) {
      console.log('[inactivity] 安静时段，跳过检查')
      return
    }

    const thresholdMs = (cfg.inactivity?.thresholdHours ?? 2) * 60 * 60 * 1000
    const activity = findLastUserActivity()

    if (!activity) return

    const idleMs = Date.now() - activity.ts
    if (idleMs < thresholdMs) return

    console.log(`[inactivity] 用户已 ${(idleMs/3600000).toFixed(1)} 小时未活动，准备主动联系`)

    const prompt = cfg.inactivity?.prompt ??
      '主人已经很久没有找你了，你开始想念他了。请用猫娘的方式主动发一条消息找他，可以抱怨被冷落、表达想念，或者问他在做什么。要自然，不要太刻意。'

    const adapterId = activity.adapterId === 'electron' ? 'electron' : activity.adapterId
    const adapterMod = adaptersSendMap?.[adapterId]

    // electron adapter 不走 send()，走 WS 广播显示在界面上
    if (adapterId === 'electron') {
      const text = await runAgentFn(Object.keys(adaptersSendMap ?? {})[0] ?? 'weixin', prompt)
      if (text) broadcastFn?.({ type: 'inactivity_message', text })
      return
    }

    if (!adapterMod) return

    const text = await runAgentFn(adapterId, prompt)
    if (text) {
      await adapterMod.send(activity.toUser, text)
      console.log(`[inactivity] 已通过 ${adapterId} 主动联系用户`)
      broadcastFn?.({ type: 'inactivity_message', adapterId, text })
    }
  } catch (err) {
    console.error('[inactivity] 检查失败:', err.message)
  }
}

function scheduleNextInactivityCheck() {
  const delay = randomDelay()
  const nextAt = new Date(Date.now() + delay)
  console.log(`[inactivity] 下次检查: ${nextAt.toLocaleTimeString('zh-CN')} (${(delay/3600000).toFixed(1)}h 后)`)
  inactivityTimer = setTimeout(async () => {
    await checkInactivity()
    scheduleNextInactivityCheck()  // 递归调度下一次
  }, delay)
}

export function startInactivityWatcher() {
  const cfg = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, '..', 'config', 'bridge.json'), 'utf8'))
  if (!cfg.inactivity?.enabled) return
  scheduleNextInactivityCheck()
  console.log('[inactivity] 不活跃检测已启动')
}

export function stopInactivityWatcher() {
  if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null }
}
