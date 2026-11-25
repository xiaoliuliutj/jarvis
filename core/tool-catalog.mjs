/**
 * App 工具目录：把系统工具、用户工具、外部/原生占位工具统一成可展示的目录。
 * 执行仍走 core/tools.mjs + agents/tools；这里只负责元数据、图标、搜索和用户启用状态。
 */

import { listAllTools, canAccessTool } from './tools.mjs'
import * as appStore from './app-store.mjs'

const ICONS = {
  weather_query: '🌤️',
  cron__list: '⏰',
  cron__add: '⏰',
  cron__update: '⏰',
  cron__delete: '⏰',
  cn_calendar: '📅',
  festival_query: '🎉',
  restart: '♻️',
  notes: '📝',
  unzip_file: '🗜️',
  read_word: '📖',
  persona: '🎭',
  schedule: '📅',
  file_builder: '📄',
  image_gen: '🎨',
  abstract_image: '🖼️',
  screenshot: '📸',
  mouse_control: '🖱️',
  keyboard_control: '⌨️',
  input_session: '🕹️',
  my_location: '📍',
  _meta: '🧩',
}

const CATEGORIES = {
  weather_query: '信息',
  cn_calendar: '信息',
  festival_query: '信息',
  cron__list: '自动化',
  cron__add: '自动化',
  cron__update: '自动化',
  cron__delete: '自动化',
  schedule: '自动化',
  notes: '效率',
  unzip_file: '文件',
  read_word: '文件',
  file_builder: '文件',
  image_gen: '创作',
  abstract_image: '创作',
  screenshot: '系统',
  mouse_control: '系统',
  keyboard_control: '系统',
  input_session: '系统',
  my_location: '系统',
  restart: '系统',
  persona: '系统',
}

const RISK = {
  mouse_control: 'high',
  keyboard_control: 'high',
  input_session: 'high',
  screenshot: 'medium',
  restart: 'medium',
  file_builder: 'low',
  image_gen: 'low',
}

const EXTERNAL_TOOLS = [
  {
    id: 'phone_alarm',
    name: '手机闹钟',
    description: '通过 App 原生能力创建系统闹钟（Android 原生桥，待接入）',
    icon: '⏰',
    category: '手机',
    source: 'native',
    risk: 'medium',
    available: false,
    configurable: true,
    tags: ['alarm', 'phone', 'native', '闹钟'],
    configFields: [],
  },
  {
    id: 'phone_notification',
    name: '手机通知',
    description: '发送本地通知/提醒（Android 原生桥，待接入）',
    icon: '🔔',
    category: '手机',
    source: 'native',
    risk: 'low',
    available: false,
    configurable: true,
    tags: ['notification', 'phone', 'native', '通知'],
    configFields: [],
  },
  {
    id: 'phone_location',
    name: '手机定位',
    description: '读取当前位置（原生权限，待接入）',
    icon: '📍',
    category: '手机',
    source: 'native',
    risk: 'high',
    available: false,
    configurable: true,
    tags: ['location', 'gps', 'native', '定位'],
    configFields: [],
  },
  {
    id: 'amap_route',
    name: '高德地图',
    description: '地点搜索、路线规划、导航深链（需要高德 API Key，待接入）',
    icon: '🗺️',
    category: '出行',
    source: 'external',
    risk: 'medium',
    available: false,
    configurable: true,
    tags: ['amap', 'map', 'route', '高德', '地图', '导航'],
    configFields: [
      { key: 'apiKey', label: '高德 API Key', secret: true, placeholder: '填写高德开放平台 Key' },
    ],
  },
  {
    id: 'calendar_native',
    name: '系统日历',
    description: '读写系统日历/提醒（原生权限，待接入）',
    icon: '📆',
    category: '手机',
    source: 'native',
    risk: 'medium',
    available: false,
    configurable: true,
    tags: ['calendar', 'schedule', '日历'],
    configFields: [],
  },
]

function matches(tool, query) {
  if (!query) return true
  const q = String(query).toLowerCase()
  const haystack = [
    tool.id,
    tool.name,
    tool.description,
    tool.category,
    ...(tool.tags || []),
  ].join(' ').toLowerCase()
  return haystack.includes(q)
}

function fromRegistryTool(tool, principalId, principal) {
  const id = tool.name
  const enabled = tool.enabled !== false && appStore.isToolEnabled(principalId, id, true)
  return {
    id,
    name: id,
    description: tool.description || '',
    icon: ICONS[id] || (tool.scope === 'user' ? '🧩' : '🧰'),
    category: CATEGORIES[id] || (tool.scope === 'user' ? '我的工具' : '系统'),
    source: tool.scope === 'user' ? 'user' : 'system',
    risk: RISK[id] || 'low',
    access: tool.access || 'all',
    accessible: canAccessTool(tool, principal),
    enabled,
    available: true,
    configurable: tool.scope === 'user',
    ownerId: tool.ownerId || null,
    tags: [],
    configFields: [],
  }
}

export function listCatalog(principalId, principal, query = '') {
  const registry = listAllTools().map(tool => fromRegistryTool(tool, principalId, principal))
  const external = EXTERNAL_TOOLS.map(tool => ({
    ...tool,
    enabled: appStore.isToolEnabled(principalId, tool.id, false),
    accessible: true,
  }))
  return [...registry, ...external]
    .filter(tool => matches(tool, query))
    .sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
      if (a.available !== b.available) return a.available ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })
}

export function getTool(principalId, principal, id) {
  const tool = listCatalog(principalId, principal, '').find(t => t.id === id)
  if (!tool) return null
  return {
    ...tool,
    config: appStore.getToolConfig(principalId, id),
    hasSecrets: (tool.configFields || []).reduce((acc, field) => {
      if (field.secret) acc[field.key] = appStore.hasToolSecret(principalId, id, field.key)
      return acc
    }, {}),
  }
}

export function listExternal() {
  return EXTERNAL_TOOLS.map(t => ({ ...t }))
}
