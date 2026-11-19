/**
 * 智谱 GLM-Image 图像生成 provider（纯文生图）。
 *
 * API: POST https://open.bigmodel.cn/api/paas/v4/images/generations
 * 返回图片 URL（有效期 30 天），本 provider 会立即下载为 Buffer。
 * 计费约 0.1 元/次；hd 质量约 20 秒。
 */

const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
const SUPPORTED_MODELS = ['glm-image', 'cogview-4-250304', 'cogview-4', 'cogview-3-flash']

export default {
  id: 'zhipu',
  label: '智谱 GLM-Image',
  supportsImageInput: false,   // 该模型只支持文生图
  supportedModels: SUPPORTED_MODELS,

  async generate({ prompt, size, model, imageBuffer }, config = {}) {
    if (imageBuffer) throw new Error('智谱 GLM-Image 不支持图生图（仅文生图），请换用 necodex')
    const apiKey = config.apiKey
    if (!apiKey) throw new Error('未配置智谱 API Key（config/credentials.json → imagegen.zhipu.apiKey）')

    const baseUrl = String(config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')

    const useModel = model || config.model || 'glm-image'
    if (!SUPPORTED_MODELS.includes(useModel)) {
      throw new Error(`不支持的模型：${useModel}（可选：${SUPPORTED_MODELS.join(', ')}）`)
    }
    const body = {
      model: useModel,
      prompt: String(prompt || '').slice(0, 1000),
      size: size || '1280x1280',
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

    const url = data?.data?.[0]?.url
    if (!url) throw new Error('图像生成失败：响应中没有图片 URL')

    const imgRes = await fetch(url, { signal: AbortSignal.timeout(120000) })
    if (!imgRes.ok) throw new Error(`下载生成图片失败：HTTP ${imgRes.status}`)
    const buffer = Buffer.from(await imgRes.arrayBuffer())
    if (!buffer.length) throw new Error('下载的图片为空')
    if (buffer.length > 30 * 1024 * 1024) throw new Error('生成图片超过 30MB，已放弃')

    const contentType = imgRes.headers.get('content-type') || 'image/png'
    return {
      buffer,
      mimeType: contentType.split(';')[0].trim(),
      meta: {
        provider: 'zhipu',
        model: useModel,
        size: body.size,
        sourceUrl: url,
        contentFilter: data.content_filter || null,
      },
    }
  },
}
