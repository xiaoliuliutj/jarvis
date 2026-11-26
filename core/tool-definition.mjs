/**
 * 统一工具定义。
 *
 * 三类来源最终都归一成同一个结构：
 *   - Jarvis 工具：agents/tools（系统）+ userdata/tools（用户创建）
 *   - 外接工具：全局 external-tools.json + 内置定义
 *   - 模型能力：kind:'capability' 预留，不进入外接工具注册表
 *
 * 执行层只看 impl.type / provider，不关心工具来自哪里。
 */

export const TOOL_CLASS = Object.freeze({
  JARVIS: 'jarvis',
  EXTERNAL: 'external',
})

export const TOOL_KIND = Object.freeze({
  TOOL: 'tool',
  CAPABILITY: 'capability',
})

export const TOOL_PROVIDER = Object.freeze({
  LOCAL_MCP: 'local-mcp',
  ANDROID_NATIVE: 'android-native',
  MCP: 'mcp',
  HTTP: 'http',
  MODEL: 'model',
})

const PROVIDERS = new Set(Object.values(TOOL_PROVIDER))
const RISKS = new Set(['low', 'medium', 'high'])
const NAME_RE = /^[a-z][a-z0-9_]*$/

export function isOwnerOrMaintainer(principal) {
  return principal?.role === 'owner' || principal?.role === 'maintainer'
}

export function normalizeTool(def = {}) {
  const id = String(def.id || def.name || '').trim()
  if (!id) throw new Error('工具缺少 id/name')
  if (!NAME_RE.test(id)) throw new Error(`工具 id 不合法：${id}`)

  const klass = def.class === TOOL_CLASS.EXTERNAL ? TOOL_CLASS.EXTERNAL : TOOL_CLASS.JARVIS
  const kind = def.kind === TOOL_KIND.CAPABILITY ? TOOL_KIND.CAPABILITY : TOOL_KIND.TOOL
  const provider = PROVIDERS.has(def.provider)
    ? def.provider
    : (klass === TOOL_CLASS.EXTERNAL ? TOOL_PROVIDER.MCP : TOOL_PROVIDER.LOCAL_MCP)
  const access = klass === TOOL_CLASS.EXTERNAL
    ? 'all'
    : (def.access === 'owner' ? 'owner' : 'all')
  const configScope = klass === TOOL_CLASS.EXTERNAL
    ? 'global'
    : (def.configScope === 'global' ? 'global' : 'user')
  const impl = (def.impl && typeof def.impl === 'object')
    ? { ...def.impl }
    : { type: provider }
  if (!impl.type) impl.type = provider

  return {
    id,
    name: String(def.name || id),
    summary: String(def.summary || '').slice(0, 120),
    description: String(def.description || ''),
    class: klass,
    kind,
    provider,
    access,
    risk: RISKS.has(def.risk) ? def.risk : '',
    icon: String(def.icon || ''),
    category: String(def.category || ''),
    tags: Array.isArray(def.tags) ? def.tags.map(item => String(item)).filter(Boolean) : [],
    configScope,
    configFields: Array.isArray(def.configFields) ? def.configFields : [],
    inputSchema: def.inputSchema || null,
    available: def.available !== false,
    enabledByDefault: def.enabledByDefault === true,
    globalEnabled: def.globalEnabled !== false,
    ownerId: def.ownerId || null,
    source: String(def.source || (klass === TOOL_CLASS.EXTERNAL ? 'external' : (def.ownerId ? 'user' : 'system'))),
    scope: String(def.scope || (klass === TOOL_CLASS.EXTERNAL ? 'external' : (def.ownerId ? 'user' : 'system'))),
    version: String(def.version || ''),
    createdAt: def.createdAt || null,
    updatedAt: def.updatedAt || null,
    impl,
  }
}

/** 系统工具 / 用户工具都算 Jarvis 工具。 */
export function normalizeJarvisTool(def = {}) {
  const id = def.id || def.name
  return normalizeTool({
    ...def,
    id,
    name: def.name || id,
    class: TOOL_CLASS.JARVIS,
    kind: TOOL_KIND.TOOL,
    provider: TOOL_PROVIDER.LOCAL_MCP,
    configScope: 'user',
    enabledByDefault: true,
    globalEnabled: def.globalEnabled !== false,
    source: def.source || (def.ownerId ? 'user' : 'system'),
    scope: def.scope || (def.ownerId ? 'user' : 'system'),
    impl: def.impl && def.impl.type === TOOL_PROVIDER.LOCAL_MCP
      ? def.impl
      : { type: TOOL_PROVIDER.LOCAL_MCP, server: id, tool: id, path: def.indexFile || '' },
  })
}

/** 全局提供的外接工具。 */
export function normalizeExternalTool(def = {}) {
  const id = def.id || def.name
  const provider = def.provider || def.impl?.type || TOOL_PROVIDER.MCP
  return normalizeTool({
    ...def,
    id,
    name: def.name || id,
    class: TOOL_CLASS.EXTERNAL,
    kind: def.kind === TOOL_KIND.CAPABILITY ? TOOL_KIND.CAPABILITY : TOOL_KIND.TOOL,
    provider,
    access: 'all',
    configScope: 'global',
    enabledByDefault: def.enabledByDefault === true,
    globalEnabled: def.globalEnabled !== false,
    source: 'external',
    scope: 'external',
    impl: { ...(def.impl || {}), type: provider },
  })
}

export function isJarvisTool(def) {
  return def?.class === TOOL_CLASS.JARVIS
}

export function isExternalTool(def) {
  return def?.class === TOOL_CLASS.EXTERNAL
}

export function isCapability(def) {
  return def?.kind === TOOL_KIND.CAPABILITY
}
