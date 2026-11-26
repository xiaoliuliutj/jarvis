/**
 * 面向用户文本的统一清理。
 *
 * 约定：模型可以用 [SILENT]（或单独一个 silent）表示「这次不打扰用户」。
 * 控制标记只能用于路由/投递判断，绝不能作为正文出现在聊天、通知或同步消息里。
 */

const SILENT_BRACKET_RE = /[\[【(（]\s*silent\b[^\]】)）]*[\]】)）]/gi
const SILENT_ONLY_RE = /^[\s"'“”‘’]*silent[\s"'“”‘’。.!！?？]*$/i

/** 去掉正文里的 [SILENT] / [silent:原因] 等控制标记。 */
export function stripSilentMarkers(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(SILENT_BRACKET_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 整条消息是否只是在表达「静默」。 */
export function isSilentText(text) {
  if (typeof text !== 'string') return true
  const trimmed = stripSilentMarkers(text)
  if (!trimmed) return true
  return SILENT_ONLY_RE.test(trimmed)
}

/**
 * 返回可直接面向用户的结果：
 *   silent=true  → 这条消息不该展示（text 为空）
 *   silent=false → text 已去掉控制标记
 */
export function sanitizeOutgoingText(text) {
  const raw = typeof text === 'string' ? text : ''
  const silent = isSilentText(raw)
  return { text: silent ? '' : stripSilentMarkers(raw), silent }
}
