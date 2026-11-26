/**
 * App 工具目录：把 Jarvis 工具和外接工具统一成可展示的目录。
 * 执行仍走 core/tools.mjs + tool-providers；这里只负责元数据、分组和用户启用状态。
 */

import { listJarvisToolDefinitions, canAccessTool } from './tools.mjs'
import { listExternalToolDefinitions } from './external-tools.mjs'
import { isOwnerOrMaintainer } from './tool-definition.mjs'
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

function matches(tool, query) {
  if (!query) return true
  const q = String(query).toLowerCase()
  const haystack = [
    tool.id,
    tool.name,
    tool.summary,
    tool.description,
    tool.class,
    tool.kind,
    tool.provider,
    tool.category,
    tool.source,
    tool.risk,
    tool.ownerId || '',
    ...(tool.tags || []),
  ].join(' ').toLowerCase()
  return haystack.includes(q)
}

function enabledFor(def, principalId) {
  if (def.globalEnabled === false) return false
  return appStore.isToolEnabled(principalId, def.id, def.enabledByDefault === true)
}

function fromDefinition(def, principalId, principal) {
  const external = def.class === 'external'
  const isUserTool = !external && (def.source === 'user' || !!def.ownerId)
  const canManage = external && isOwnerOrMaintainer(principal)
  const configEditable = external ? canManage : isUserTool
  return {
    id: def.id,
    name: def.name || def.id,
    class: def.class,
    kind: def.kind,
    provider: def.provider,
    summary: def.summary || '',
    description: def.description || '',
    icon: def.icon || ICONS[def.id] || (external ? '🔌' : (isUserTool ? '🧩' : '🧰')),
    category: def.category || CATEGORIES[def.id] || (external ? '外接' : (isUserTool ? '我的工具' : '系统')),
    source: external ? 'external' : (isUserTool ? 'user' : 'system'),
    risk: def.risk || RISK[def.id] || 'low',
    access: def.access || 'all',
    accessible: canAccessTool(def, principal),
    enabled: enabledFor(def, principalId),
    available: def.available !== false,
    configurable: configEditable,
    configEditable,
    configScope: def.configScope,
    manageable: canManage,
    ownerId: def.ownerId || null,
    tags: def.tags || [],
    configFields: def.configFields || [],
    impl: def.impl,
  }
}

export function listCatalog(principalId, principal, query = '') {
  const definitions = [...listJarvisToolDefinitions(), ...listExternalToolDefinitions()]
  return definitions
    .map(def => fromDefinition(def, principalId, principal))
    .filter(tool => tool.accessible)
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
  const external = tool.class === 'external'
  return {
    ...tool,
    // 外接工具配置是全局的，本期还没有全局配置存储；先返回空对象。
    config: external ? {} : appStore.getToolConfig(principalId, id),
    hasSecrets: external ? {} : (tool.configFields || []).reduce((acc, field) => {
      if (field.secret) acc[field.key] = appStore.hasToolSecret(principalId, id, field.key)
      return acc
    }, {}),
  }
}

export function listExternal() {
  return listExternalToolDefinitions().map(def => ({ ...def }))
}
