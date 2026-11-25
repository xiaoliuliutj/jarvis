/**
 * 主投递账号排序。
 *
 * 一个 principal 可能有多个渠道（微信 / App）。
 * 当前策略：微信优先、App 兜底。用户明确要求 App 端稳定前以微信端为准；
 * 提醒类消息先走微信，发送失败时由调用方回退到 App。
 */
export function orderDeliveryAccounts(principal) {
  const accounts = Array.isArray(principal?.accounts) ? principal.accounts : []
  return [...accounts].sort((a, b) => {
    const score = (account) => (account?.sourceType === 'app' ? 1 : 0)
    return score(a) - score(b)
  })
}
