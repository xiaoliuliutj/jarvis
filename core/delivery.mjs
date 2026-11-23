/**
 * 主投递账号排序。
 *
 * 一个 principal 可能有多个渠道（微信 / App）。
 * 提醒类消息（cron、日程）优先投递到 App：App 端在线时走 App，
 * 不在线时由调用方回退到其他账号（如微信）。
 */
export function orderDeliveryAccounts(principal) {
  const accounts = Array.isArray(principal?.accounts) ? principal.accounts : []
  return [...accounts].sort((a, b) => {
    const score = (account) => (account?.sourceType === 'app' ? 0 : 1)
    return score(a) - score(b)
  })
}
