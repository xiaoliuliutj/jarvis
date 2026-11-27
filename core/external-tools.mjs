/**
 * 外接工具注册表（全局）。
 *
 * - 定义是全局的：owner / maintainer 可以增删改，普通用户只读。
 * - 启用状态是每用户的：存 userdata/<principalId>/app/tools.json。
 * - 定义文件 config/external-tools.json 不入库；内置定义在代码里，文件只存覆盖/新增。
 * - 视频/语音/图像等模型能力不放这里，它们走 userdata/<pid>/app/models.json。
 */

import fs from 'fs'
import path from 'path'
import { CONFIG_DIR, ensureDir } from './paths.mjs'
import {
  normalizeExternalTool,
  isOwnerOrMaintainer,
  TOOL_PROVIDER,
} from './tool-definition.mjs'

const EXTERNAL_TOOLS_FILE = path.join(CONFIG_DIR, 'external-tools.json')
const MANAGE_ERROR = '只有主人或主会话可以管理外接工具'
const ALLOWED_PROVIDERS = new Set([
  TOOL_PROVIDER.ANDROID_NATIVE,
  TOOL_PROVIDER.MCP,
  TOOL_PROVIDER.HTTP,
])

// 真正接了执行层的 Android 工具；其余保持 available:false。
const IMPLEMENTED_ANDROID_TOOLS = new Set(['android_notification', 'android_alarm', 'android_location', 'android_sms'])

export const BUILTIN_EXTERNAL_TOOLS = [
  {
    id: 'android_notification',
    name: '手机通知',
    summary: '在手机上发一条系统通知',
    description: '在用户当前连接的 Android 手机上发送一条系统通知。需要 App 在线，且通知权限已开启。',
    provider: TOOL_PROVIDER.ANDROID_NATIVE,
    icon: '🔔',
    category: '手机',
    risk: 'low',
    tags: ['android', 'notification', '通知'],
    available: true,
    enabledByDefault: false,
    impl: {
      type: TOOL_PROVIDER.ANDROID_NATIVE,
      server: 'android_native',
      action: 'notification',
      executor: 'service',
      fallback: 'web',
    },
    configFields: [],
  },
  {
    id: 'android_alarm',
    name: '手机闹钟',
    summary: '设置手机系统闹钟',
    description: '在用户当前连接的 Android 手机上创建系统闹钟。默认 action=set，传 24 小时制 hour/minute，可选 label；优先交给 ColorOS 系统时钟静默创建，不支持时会打开时钟界面。调试时可用 action=probe 列出时钟入口、action=try_component 指定组件尝试。需要 Android App 0.2.8+ 在线。',
    provider: TOOL_PROVIDER.ANDROID_NATIVE,
    icon: '⏰',
    category: '手机',
    risk: 'medium',
    tags: ['android', 'alarm', '闹钟'],
    available: true,
    enabledByDefault: true,
    impl: {
      type: TOOL_PROVIDER.ANDROID_NATIVE,
      server: 'android_native',
      action: 'alarm',
      executor: 'service',
      fallback: 'web',
    },
    configFields: [],
  },
  {
    id: 'android_location',
    name: '手机定位',
    summary: '获取手机当前位置',
    description: '读取 Android 手机当前定位（系统缓存或实时），返回经纬度、精度和定位来源。需要用户在 App 内授予定位权限。需要 Android App 0.3.4+ 在线。',
    provider: TOOL_PROVIDER.ANDROID_NATIVE,
    icon: '📍',
    category: '手机',
    risk: 'high',
    tags: ['android', 'location', '定位'],
    available: true,
    enabledByDefault: true,
    impl: {
      type: TOOL_PROVIDER.ANDROID_NATIVE,
      server: 'android_native',
      action: 'location',
      executor: 'service',
      fallback: 'web',
    },
    configFields: [],
  },
  {
    id: 'android_sms',
    name: '手机短信',
    summary: '读取手机短信',
    description: '读取 Android 手机的短信（只读）：列出最近短信、按号码/关键词搜索、读取单条详情。需要用户在 App 内授予短信权限。需要 Android App 0.3.5+ 在线。',
    provider: TOOL_PROVIDER.ANDROID_NATIVE,
    icon: '💬',
    category: '手机',
    risk: 'high',
    tags: ['android', 'sms', '短信'],
    available: true,
    enabledByDefault: true,
    impl: {
      type: TOOL_PROVIDER.ANDROID_NATIVE,
      server: 'android_native',
      action: 'sms',
      executor: 'service',
      fallback: 'web',
    },
    configFields: [],
  },
  {
    id: 'android_calendar',
    name: '系统日历',
    summary: '读写手机系统日历',
    description: '读写 Android 系统日历/提醒。当前只有接口，尚未接入权限和执行。',
    provider: TOOL_PROVIDER.ANDROID_NATIVE,
    icon: '📆',
    category: '手机',
    risk: 'medium',
    tags: ['android', 'calendar', '日历'],
    available: false,
    enabledByDefault: false,
    impl: { type: TOOL_PROVIDER.ANDROID_NATIVE, server: 'android_native', action: 'calendar' },
    configFields: [],
  },
  {
    id: 'amap_route',
    name: '高德地图',
    summary: '地点搜索、路线规划和导航',
    description: '通过高德地图 API 做地点搜索、路线规划和导航深链。当前只有接口，尚未接入执行。',
    provider: TOOL_PROVIDER.HTTP,
    icon: '🗺️',
    category: '出行',
    risk: 'medium',
    tags: ['amap', 'map', 'route', '高德', '地图', '导航'],
    available: false,
    enabledByDefault: false,
    impl: { type: TOOL_PROVIDER.HTTP, baseUrl: 'https://restapi.amap.com' },
    configFields: [
      { key: 'apiKey', label: '高德 API Key', secret: true, placeholder: '填写高德开放平台 Key' },
    ],
  },
]

function readState() {
  try {
    if (!fs.existsSync(EXTERNAL_TOOLS_FILE)) return { version: 1, tools: [] }
    const data = JSON.parse(fs.readFileSync(EXTERNAL_TOOLS_FILE, 'utf-8'))
    const tools = Array.isArray(data?.tools) ? data.tools : (Array.isArray(data) ? data : [])
    return { version: 1, tools }
  } catch {
    return { version: 1, tools: [] }
  }
}

function writeState(state) {
  ensureDir(CONFIG_DIR)
  const text = JSON.stringify({ version: 1, tools: state.tools }, null, 2) + '\n'
  const tmp = `${EXTERNAL_TOOLS_FILE}.tmp`
  fs.writeFileSync(tmp, text, 'utf-8')
  try {
    fs.renameSync(tmp, EXTERNAL_TOOLS_FILE)
  } catch {
    fs.copyFileSync(tmp, EXTERNAL_TOOLS_FILE)
    fs.unlinkSync(tmp)
  }
}

function mergeImpl(base, override) {
  if (!override) return base
  if (!base) return override
  return { ...base, ...override }
}

function mergedRawTools() {
  const map = new Map(BUILTIN_EXTERNAL_TOOLS.map(tool => [tool.id, { ...tool }]))
  for (const override of readState().tools) {
    if (!override || !override.id) continue
    const id = String(override.id)
    if (override.deleted === true) {
      map.delete(id)
      continue
    }
    const base = map.get(id)
    map.set(id, {
      ...(base || {}),
      ...override,
      id,
      impl: mergeImpl(base?.impl, override.impl),
    })
  }
  return [...map.values()]
}

export function listExternalToolDefinitions() {
  return mergedRawTools()
    .map(tool => {
      try { return normalizeExternalTool(tool) } catch { return null }
    })
    .filter(tool => tool && ALLOWED_PROVIDERS.has(tool.provider))
}

export function getExternalToolDefinition(id) {
  const key = String(id || '')
  return listExternalToolDefinitions().find(tool => tool.id === key) || null
}

export function isBuiltinExternalTool(id) {
  return BUILTIN_EXTERNAL_TOOLS.some(tool => tool.id === id)
}

function assertCanManage(role) {
  if (!isOwnerOrMaintainer({ role })) throw new Error(MANAGE_ERROR)
}

function validateExternalTool(input, { partial = false } = {}) {
  if (!partial && !String(input.id || '').trim()) throw new Error('工具 id 必填')
  if (!partial && !String(input.provider || '').trim()) throw new Error('外接工具 provider 必填')
  if (input.provider && !ALLOWED_PROVIDERS.has(input.provider)) {
    throw new Error(`不支持的外接工具 provider：${input.provider}`)
  }
  if (input.kind && input.kind !== 'tool') {
    throw new Error('外接工具注册表只存放 tool；模型能力请放 models.json')
  }
  if (input.available === true && input.provider === TOOL_PROVIDER.ANDROID_NATIVE) {
    // Android 原生工具是否真正可用由 App 版本/连接决定，这里只允许已接入执行层的预定义工具。
    const key = String(input.id || '')
    if (!isBuiltinExternalTool(key) || !IMPLEMENTED_ANDROID_TOOLS.has(key)) {
      throw new Error('该 Android 原生工具尚未接入执行层，不能设为可用')
    }
  }
  if (input.available === true
    && (input.provider === TOOL_PROVIDER.MCP || input.provider === TOOL_PROVIDER.HTTP)) {
    throw new Error('MCP/HTTP 外接工具尚未实现，不能设为可用')
  }
}

export function createExternalTool(input = {}, { role } = {}) {
  assertCanManage(role)
  validateExternalTool(input)
  const state = readState()
  const exists = listExternalToolDefinitions().some(tool => tool.id === String(input.id))
  if (exists) throw new Error(`外接工具 "${input.id}" 已存在`)
  const def = normalizeExternalTool({
    ...input,
    available: input.available === true,
    enabledByDefault: false,
  })
  validateExternalTool(def)
  state.tools = state.tools.filter(tool => tool?.id !== def.id)
  state.tools.push(def)
  writeState(state)
  return def
}

export function updateExternalTool(id, patch = {}, { role } = {}) {
  assertCanManage(role)
  const key = String(id || '')
  const current = getExternalToolDefinition(key)
  if (!current) throw new Error(`外接工具 "${key}" 不存在`)
  const clean = Object.fromEntries(
    Object.entries(patch || {}).filter(([, value]) => value !== undefined)
  )
  const merged = normalizeExternalTool({
    ...current,
    ...clean,
    id: key,
    class: 'external',
    access: 'all',
    configScope: 'global',
    source: 'external',
    scope: 'external',
    ownerId: null,
    impl: mergeImpl(current.impl, clean.impl),
  })
  validateExternalTool(merged)
  const state = readState()
  state.tools = state.tools.filter(tool => tool?.id !== key)
  state.tools.push(merged)
  writeState(state)
  return merged
}

export function deleteExternalTool(id, { role } = {}) {
  assertCanManage(role)
  const key = String(id || '')
  if (isBuiltinExternalTool(key)) {
    throw new Error(`内置外接工具 "${key}" 不能删除，可以 update 为 available:false`)
  }
  const state = readState()
  const before = state.tools.length
  state.tools = state.tools.filter(tool => tool?.id !== key)
  if (state.tools.length === before) throw new Error(`外接工具 "${key}" 不存在`)
  writeState(state)
  return { id: key }
}
