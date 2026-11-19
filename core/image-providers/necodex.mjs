/**
 * NeCodeX（OpenAI 兼容）图像生成 provider。
 *
 * 文档：POST {BASE_URL}/images/generations，Authorization: Bearer <APIKey>
 *   BASE_URL 形如 https://fast.sbbbbbbbbb.xyz/v1
 * 模型：gpt-image-2.5-flare / gpt-image-2.5-sunburst（固定价）；
 *       grok-imagine-image-2.0 仅 GrokHeavy 分组可用且固定 10 美元/次，不建议用。
 *
 * 响应兼容 OpenAI images API：
 *   { data: [{ url }] } 或 { data: [{ b64_json }] } 都支持。
 * 注：文档只提供 generations（文生图），edits（图生图）未文档化，暂不支持。
 */

const DEFAULT_BASE_URL = 'https://fast.sbbbbbbbbb.xyz/v1'
const DEFAULT_MODEL = 'gpt-image-2.5-flare'

function normalizeBaseUrl(url) {
  let base = String(url || DEFAULT_BASE_URL).replace(/\/+$/, '')
  if (!/\/v1$/i.test(base)) base += '/v1'
  return base
}

export default {
  id: 'necodex',
  label: 'NeCodeX 中转（OpenAI 兼容）',
  supportsImageInput: false,   // 文档未提供 edits 接口；后续可验证
  supportedModels: ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'grok-imagine-image-2.0'],

  async generate({ prompt, size, model }, config = {}) {
    const apiKey = config.apiKey
    if (!apiKey) throw new Error('未配置 NeCodeX API Key（config/credentials.json → imagegen.necodex.apiKey）')

    const baseUrl = normalizeBaseUrl(config.baseUrl)
    const useModel = model || config.model || DEFAULT_MODEL
    if (useModel === 'grok-imagine-image-2.0') {
      throw new Error('grok-imagine-image-2.0 每次固定 10 美元且需要 GrokHeavy 分组，已禁止使用')
    }

    const body = {
      model: useModel,
      prompt: String(prompt || '').slice(0, 1000),
      size: size || '1024x1024',
    }

    const res = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    })

    let data = {}
    try { data = await res.json() } catch {}
    if (!res.ok || data?.error) {
      const msg = data?.error?.message || `HTTP ${res.status}`
      throw new Error(`图像生成失败：${msg}`)
    }

    const item = data?.data?.[0]
    if (!item) throw new Error('图像生成失败：响应中没有图片数据')

    let buffer
    let mimeType = 'image/png'
    if (item.b64_json) {
      buffer = Buffer.from(item.b64_json, 'base64')
    } else if (item.url) {
      const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(120000) })
      if (!imgRes.ok) throw new Error(`下载生成图片失败：HTTP ${imgRes.status}`)
      buffer = Buffer.from(await imgRes.arrayBuffer())
      mimeType = (imgRes.headers.get('content-type') || 'image/png').split(';')[0].trim()
    } else {
      throw new Error('图像生成失败：响应中没有 url 或 b64_json')
    }

    if (!buffer.length) throw new Error('生成的图片为空')
    if (buffer.length > 30 * 1024 * 1024) throw new Error('生成图片超过 30MB，已放弃')

    return {
      buffer,
      mimeType,
      meta: {
        provider: 'necodex',
        model: useModel,
        size: body.size,
        ...(item.url ? { sourceUrl: item.url } : {}),
      },
    }
  },
}
