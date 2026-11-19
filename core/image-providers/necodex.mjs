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
 *
 * 图生图：文档未写，但实测 /images/edits 路由可用（multipart），
 *   传入 image（Buffer）+ prompt 即走编辑接口。
 */

const DEFAULT_BASE_URL = 'https://fast.sbbbbbbbbb.xyz/v1'
const DEFAULT_MODEL = 'gpt-image-2.5-flare'

function normalizeBaseUrl(url) {
  let base = String(url || DEFAULT_BASE_URL).replace(/\/+$/, '')
  if (!/\/v1$/i.test(base)) base += '/v1'
  return base
}

function parseImageResponse(data, extraMeta = {}) {
  const item = data?.data?.[0]
  if (!item) throw new Error('图像生成失败：响应中没有图片数据')

  const meta = {
    provider: 'necodex',
    ...extraMeta,
    ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
    ...(item.url ? { sourceUrl: item.url } : {}),
  }

  if (item.b64_json) {
    return async () => ({
      buffer: Buffer.from(item.b64_json, 'base64'),
      mimeType: 'image/png',
      meta,
    })
  }
  if (item.url) {
    return async () => {
      const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(120000) })
      if (!imgRes.ok) throw new Error(`下载生成图片失败：HTTP ${imgRes.status}`)
      return {
        buffer: Buffer.from(await imgRes.arrayBuffer()),
        mimeType: (imgRes.headers.get('content-type') || 'image/png').split(';')[0].trim(),
        meta,
      }
    }
  }
  throw new Error('图像生成失败：响应中没有 url 或 b64_json')
}

export default {
  id: 'necodex',
  label: 'NeCodeX 中转（OpenAI 兼容）',
  supportsImageInput: true,    // /images/edits 实测可用（OpenAI 兼容 multipart）
  supportedModels: ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'grok-imagine-image-2.0'],

  async generate({ prompt, size, model, imageBuffer, imageName, mimeType }, config = {}) {
    const apiKey = config.apiKey
    if (!apiKey) throw new Error('未配置 NeCodeX API Key（config/credentials.json → imagegen.necodex.apiKey）')

    const baseUrl = normalizeBaseUrl(config.baseUrl)
    const useModel = model || config.model || DEFAULT_MODEL
    if (useModel === 'grok-imagine-image-2.0') {
      throw new Error('grok-imagine-image-2.0 每次固定 10 美元且需要 GrokHeavy 分组，已禁止使用')
    }

    const textPrompt = String(prompt || '').slice(0, 1000)
    const useSize = size || '1024x1024'

    let res
    if (imageBuffer) {
      // 图生图：OpenAI 兼容 multipart edits 接口
      const form = new FormData()
      form.append('model', useModel)
      form.append('prompt', textPrompt)
      form.append('size', useSize)
      form.append('image', new Blob([imageBuffer], { type: mimeType || 'image/png' }), imageName || 'image.png')
      res = await fetch(`${baseUrl}/images/edits`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(300000),
      })
    } else {
      res = await fetch(`${baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: useModel, prompt: textPrompt, size: useSize }),
        signal: AbortSignal.timeout(180000),
      })
    }

    let data = {}
    try { data = await res.json() } catch {}
    if (!res.ok || data?.error) {
      const msg = data?.error?.message || `HTTP ${res.status}`
      throw new Error(`图像生成失败：${msg}`)
    }

    const result = await parseImageResponse(data, {
      model: useModel,
      size: useSize,
      mode: imageBuffer ? 'edit' : 'generate',
    })()
    if (!result.buffer.length) throw new Error('生成的图片为空')
    if (result.buffer.length > 30 * 1024 * 1024) throw new Error('生成图片超过 30MB，已放弃')
    return result
  },
}
