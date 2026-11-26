/**
 * 「正在处理」提示。
 *
 * 非主会话（adapter 用户）的消息如果超过一段时间还没拿到最终回复，
 * Bridge 会先发一句简短提示，告诉用户确实在处理中。
 *
 * 文案基于当前用户的 persona 动态生成，保证人设一致；
 * 生成失败或超时时退化为带人设特征的模板文案。
 */

import { getAnthropicCredentials, getModel } from './config.mjs'

const FALLBACK_CAT = '收到喵～正在努力处理，稍等一下 (>ω<)'
const FALLBACK_PLAIN = '收到～正在处理，稍等一下'

function looksLikeCat(persona = '') {
  return /喵|猫娘|nya|ฅ/i.test(persona)
}

/** 模型偶尔会忘记人设语气；猫娘人设下至少保证有喵。 */
function enforcePersonaTone(text, persona = '') {
  const value = String(text || '').trim()
  if (!value) return value
  if (looksLikeCat(persona) && !/喵|猫|nya|ฅ/i.test(value)) {
    return `${value.replace(/[。！!…\s]+$/u, '')}喵～`
  }
  return value
}

export function fallbackInterimNotice(persona = '') {
  return looksLikeCat(persona) ? FALLBACK_CAT : FALLBACK_PLAIN
}

function buildHeaders(apiKey, authMode) {
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
  if (authMode === 'auth_token') {
    headers.authorization = `Bearer ${apiKey}`
  } else if (authMode === 'api_key') {
    headers['x-api-key'] = apiKey
  } else {
    headers['x-api-key'] = apiKey
    headers.authorization = `Bearer ${apiKey}`
  }
  return headers
}

function sanitize(text) {
  if (!text) return ''
  return text
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

/**
 * 生成一句符合用户人设的「正在处理」提示。
 * @param {{persona?: string, displayName?: string}} opts
 * @returns {Promise<string>}
 */
export async function generateInterimNotice({ persona = '', displayName = '' } = {}) {
  const fallback = fallbackInterimNotice(persona)
  const { apiKey, baseUrl, authMode } = getAnthropicCredentials()
  if (!apiKey) return fallback

  try {
    const url = `${(baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(apiKey, authMode),
      body: JSON.stringify({
        model: getModel(),
        max_tokens: 60,
        system: `你是 Jarvis。下面是当前用户看到的你的人设：\n${persona || '（无特殊人设，语气自然、友好、简洁）'}`,
        messages: [{
          role: 'user',
          content: `用户「${displayName}」刚发来一条消息，你需要花一点时间处理。请生成一句不超过 18 个字的简短回应，表示已经收到、正在处理中。必须完全符合你的人设语气。只输出这句话本身，不要引号、不要解释、不要换行。`,
        }],
      }),
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const text = sanitize((data.content || []).map(c => c.text || '').join(''))
    return enforcePersonaTone(text, persona) || fallback
  } catch {
    return fallback
  }
}
