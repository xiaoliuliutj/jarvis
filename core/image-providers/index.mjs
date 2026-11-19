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

const BUILTIN_PROVIDERS = [zhipu]

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
 * 生成一张图片。
 * @param {{prompt: string, size?: string, providerId: string, config: object}} opts
 */
export async function generateImage({ prompt, size, providerId, config = {} }) {
  const provider = getProvider(providerId)
  if (!provider) {
    throw new Error(`未知图像 provider：${providerId}（支持：${providers.map(p => p.id).join(', ')}）`)
  }
  return await provider.generate({ prompt, size }, config)
}
