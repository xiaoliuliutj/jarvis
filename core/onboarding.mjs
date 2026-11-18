/**
 * 新用户风格引导。
 *
 * 新 principal 的第一条消息先不进入模型，而是由 Bridge 直接发送选择菜单；
 * 用户选择预设或提交自定义描述后写入 persona.md，再恢复正常聊天。
 *
 * 状态文件：userdata/<principalId>/onboarding.json
 * 完成后删除；已存在的用户不会补发。
 */

import fs from 'fs'
import { onboardingFile, principalDir, ensureDir } from './paths.mjs'
import { writePersona } from './user-store.mjs'
import {
  PERSONA_PRESETS,
  PERSONA_MENU,
  welcomeText,
  customPersona,
} from './persona-presets.mjs'

function readState(principalId) {
  const file = onboardingFile(principalId)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

function writeState(principalId, state) {
  ensureDir(principalDir(principalId))
  fs.writeFileSync(onboardingFile(principalId), JSON.stringify(state, null, 2), 'utf-8')
}

function clearState(principalId) {
  fs.rmSync(onboardingFile(principalId), { force: true })
}

function presetFromText(text) {
  if (/^1$|默认|default|随便|跳过|不设置|不用设置/i.test(text)) return 'default'
  if (/^2$|简洁|高效|concise/i.test(text)) return 'concise'
  if (/^3$|温柔|陪伴|warm/i.test(text)) return 'warm'
  if (/^4$|元气|活泼|lively/i.test(text)) return 'lively'
  return null
}

function customTextFromInput(text) {
  const match = text.match(/^(?:自定义|custom)\s*[:：]?\s*([\s\S]*)$/i)
  return match ? match[1].trim() : null
}

function applyPreset(principalId, key) {
  const preset = PERSONA_PRESETS[key]
  writePersona(principalId, preset.content)
  clearState(principalId)
  return `✅ 已设置为「${preset.label}」。现在可以直接开始聊天，之后随时可以让我调整。`
}

function applyCustom(principalId, content) {
  writePersona(principalId, customPersona(content))
  clearState(principalId)
  return '✅ 已按你的描述设置好人设。现在可以直接开始聊天，之后随时可以让我调整。'
}

function askForCustom(principalId) {
  writeState(principalId, { status: 'awaiting_custom', updatedAt: new Date().toISOString() })
  return '请回复「自定义：你希望我说话的语气、风格或称呼」，例如：自定义：温柔一点，叫我小明。'
}

function showMenu() {
  return `请回复 1-4 选择预设风格，或回复「自定义：...」。\n\n${PERSONA_MENU}`
}

function handleReply(principalId, text) {
  const state = readState(principalId)
  if (!state) return { handled: false }

  const raw = String(text ?? '').trim()
  if (!raw) return { handled: true, reply: showMenu() }

  const preset = presetFromText(raw)
  if (preset) {
    return { handled: true, done: true, reply: applyPreset(principalId, preset) }
  }

  const customText = customTextFromInput(raw)
  if (customText !== null) {
    if (customText) {
      return { handled: true, done: true, reply: applyCustom(principalId, customText) }
    }
    return { handled: true, reply: askForCustom(principalId) }
  }

  if (/^5$/.test(raw)) {
    return { handled: true, reply: askForCustom(principalId) }
  }

  // 正在等待自定义描述时，任何非空文本都视为风格描述
  if (state.status === 'awaiting_custom') {
    return { handled: true, done: true, reply: applyCustom(principalId, raw) }
  }

  return { handled: true, reply: showMenu() }
}

/**
 * @param {object} opts
 * @param {string} opts.principalId
 * @param {boolean} opts.isNew  本次是否刚自动创建
 * @param {string} opts.text
 * @returns {{handled:boolean, reply?:string, done?:boolean}}
 */
export function handleIncomingOnboarding({ principalId, isNew, text }) {
  if (isNew) {
    writeState(principalId, { status: 'pending', createdAt: new Date().toISOString() })
    return { handled: true, reply: welcomeText(), started: true }
  }
  return handleReply(principalId, text)
}
