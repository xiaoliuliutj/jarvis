/**
 * 图像生成 provider 注册表。
 *
 * 每个 provider：
 *   {
 *     id: 'zhipu',
 *     label: '智谱 GLM-Image',
 *     supportsImageInput: false,          // 是否支持图生图
 *     supportedModels?: [string],
 *     generate({ prompt, size }, config) → Promise<{ buffer, mimeType, meta }>
 *   }
 *
 * 扩展新服务（fal / 本地 SD / 其他）时：新建 provider 文件并加入 BUILTIN_PROVIDERS，
 * 再在 config/credentials.json 的 imagegen 段配置对应密钥即可。
 */

import zhipu from './zhipu.mjs'
import necodex from './necodex.mjs'

const BUILTIN_PROVIDERS = [zhipu, necodex]

const providers = [...BUILTIN_PROVIDERS]

export function registerProvider(provider) {
  if (!provider?.id || typeof provider.generate !== 'function') {
    throw new Error('provider 需要 id / generate')
  }
  providers.push(provider)
}

export function getProvider(id) {
  return providers.find(p => p.id === id) || null
}

export function listProviders() {
  return providers.map(p => ({
    id: p.id,
    label: p.label,
    supportsImageInput: !!p.supportsImageInput,
    ...(p.supportedModels ? { supportedModels: p.supportedModels } : {}),
  }))
}

/**
 * 生成（或编辑）一张图片。
 * @param {{prompt: string, size?: string, model?: string, imageBuffer?: Buffer,
 *          imageName?: string, mimeType?: string, providerId: string, config: object}} opts
 */
export async function generateImage({ prompt, size, model, imageBuffer, imageName, mimeType, providerId, config = {} }) {
  const provider = getProvider(providerId)
  if (!provider) {
    throw new Error(`未知图像 provider：${providerId}（支持：${providers.map(p => p.id).join(', ')}）`)
  }
  if (imageBuffer && !provider.supportsImageInput) {
    throw new Error(`provider "${providerId}" 不支持图生图，请换用支持编辑的 provider`)
  }
  return await provider.generate({ prompt, size, model, imageBuffer, imageName, mimeType }, config)
}
