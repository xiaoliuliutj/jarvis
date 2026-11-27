/**
 * 心情状态：读写 workspace/mood.json。
 *
 * 背景：心情规则之前只写在 persona 里，依赖 Agent 每轮自己读/写文件，
 * 实际经常忘，导致 mood 从早上开始一直不变。
 *
 * 现在改成代码兜底：
 *   - 每轮聊天自动做睡眠结算、夜间打断计数、基础情绪渐变
 *   - 把【内部心情状态】拼到本轮消息尾部，Agent 只负责语气表达
 *   - 明显转折仍可由 Agent 自己 Write mood.json 覆盖
 */

import fs from 'fs'
import path from 'path'
import { workspaceDir, ensureDir } from './paths.mjs'

const DEFAULT_NOTE = 'mood: -5~+5 底色；Jarvis 24:00睡 07:00醒；nightInterruptions=0-7点主人主动互动次数（定时任务不算）；grumpyUntil 起床气截止时间'
const GRUMPY_MS = 20 * 60 * 1000

function moodFile(principalId) {
  return path.join(workspaceDir(principalId), 'mood.json')
}

function clamp(value, min = -5, max = 5) {
  return Math.max(min, Math.min(max, value))
}

function moodLabel(value) {
  const m = Number(value) || 0
  if (m >= 4.5) return '极度开心'
  if (m >= 3) return '开心'
  if (m >= 1) return '平静愉快'
  if (m > -1) return '平静'
  if (m > -2.5) return '有点闷'
  if (m > -3.5) return '不爽'
  if (m > -4.5) return '生气'
  return '冷战'
}

function defaultMood() {
  return {
    mood: 0,
    state: '平静',
    lastTalkAt: null,
    lastWakeupAt: null,
    nightInterruptions: 0,
    grumpyUntil: null,
    updatedAt: null,
    note: DEFAULT_NOTE,
  }
}

export function readMood(principalId) {
  try {
    const data = JSON.parse(fs.readFileSync(moodFile(principalId), 'utf-8'))
    return {
      ...defaultMood(),
      ...data,
      mood: clamp(Number(data.mood) || 0),
      state: String(data.state || '') || moodLabel(data.mood),
      nightInterruptions: Math.max(0, Number(data.nightInterruptions) || 0),
      note: String(data.note || DEFAULT_NOTE),
    }
  } catch {
    return defaultMood()
  }
}

function writeMood(principalId, mood) {
  ensureDir(workspaceDir(principalId))
  const data = {
    ...mood,
    mood: Number(Number(mood.mood).toFixed(2)),
    updatedAt: mood.updatedAt || new Date().toISOString(),
    note: mood.note || DEFAULT_NOTE,
  }
  fs.writeFileSync(moodFile(principalId), JSON.stringify(data, null, 2), 'utf-8')
  return data
}

function todayAt7(now) {
  const d = new Date(now)
  d.setHours(7, 0, 0, 0)
  return d
}

/** 07:00 后的第一次聊天做睡眠结算；cron 不触发。 */
function settleWakeup(mood, now) {
  const today7 = todayAt7(now)
  if (now.getTime() < today7.getTime()) return false
  const last = mood.lastWakeupAt ? new Date(mood.lastWakeupAt).getTime() : 0
  if (last && last >= today7.getTime()) return false

  const interruptions = Math.max(0, Number(mood.nightInterruptions) || 0)
  let delta = 2 + Math.random() * 1 // +2~3
  const naturalBad = Math.random() < 0.25
  if (naturalBad) delta = -1
  if (interruptions === 1) delta -= 0.5 + Math.random() * 0.5
  else if (interruptions >= 2) delta -= 1 + Math.random()

  mood.mood = clamp((Number(mood.mood) || 0) + delta)
  mood.nightInterruptions = 0
  mood.lastWakeupAt = today7.toISOString()
  mood.grumpyUntil = (naturalBad || interruptions >= 2)
    ? new Date(now.getTime() + GRUMPY_MS).toISOString()
    : null
  mood.state = mood.grumpyUntil ? '没睡好，有点起床气' : moodLabel(mood.mood)
  mood.updatedAt = now.toISOString()
  return true
}

function computeDelta(mood, text) {
  const value = String(text || '').trim()
  if (!value) return -0.1
  if (/(滚|废物|闭嘴)/.test(value)) return -1.5
  if (/(凶|烦死|好烦|笨|蠢|不满|失望|生气|太慢|快点|别废话|没用|讨厌)/.test(value)) {
    return mood.mood > 0 ? -0.8 : -0.5
  }
  if (/(谢谢|感谢|辛苦|夸奖|厉害|棒|聪明|可爱|乖|爱你|抱抱|摸摸|喜欢你|做得好|不错|太棒|优秀|牛|好看)/.test(value)) {
    return mood.mood < 0 ? 0.6 : 1
  }
  // 没有明显刺激时，向 0 自然回落
  if (Math.abs(mood.mood) < 0.2) return 0
  return mood.mood > 0 ? -0.2 : 0.2
}

function moodLine(mood, now) {
  const value = Number(mood.mood) || 0
  const parts = [
    `mood=${value >= 0 ? '+' : ''}${value.toFixed(1)}`,
    `state=${mood.state || moodLabel(value)}`,
  ]
  if (mood.grumpyUntil && Date.parse(mood.grumpyUntil) > now.getTime()) {
    parts.push('起床气中')
  }
  if (mood.nightInterruptions > 0) {
    parts.push(`夜间被打断${mood.nightInterruptions}次`)
  }
  return `【内部心情状态｜只用于语气，不要向用户播报数值】${parts.join('｜')}\n`
}

/**
 * 每轮调用：
 *   - isChat=true：睡眠结算、夜间计数、基础渐变、写回 mood.json
 *   - isChat=false（cron）：只读取，不改状态
 * @returns {{mood: object, line: string}}
 */
export function prepareMood(principalId, { text = '', isChat = true, now = new Date() } = {}) {
  const mood = readMood(principalId)
  let dirty = false

  if (isChat) {
    if (settleWakeup(mood, now)) dirty = true

    const hour = now.getHours()
    if (hour >= 0 && hour < 7) {
      mood.nightInterruptions = (Number(mood.nightInterruptions) || 0) + 1
      dirty = true
    }

    const delta = computeDelta(mood, text)
    if (delta) {
      mood.mood = clamp((Number(mood.mood) || 0) + delta)
      dirty = true
    }

    if (mood.grumpyUntil && Date.parse(mood.grumpyUntil) <= now.getTime()) {
      mood.grumpyUntil = null
      dirty = true
    }

    const nextState = (mood.grumpyUntil && Date.parse(mood.grumpyUntil) > now.getTime())
      ? '没睡好，有点起床气'
      : moodLabel(mood.mood)
    if (mood.state !== nextState) {
      mood.state = nextState
      dirty = true
    }

    mood.lastTalkAt = now.toISOString()
    mood.updatedAt = now.toISOString()
    dirty = true
  }

  if (dirty) writeMood(principalId, mood)
  return { mood, line: moodLine(mood, now) }
}
