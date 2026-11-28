/**
 * 主投递账号排序。
 *
 * 一个 principal 可能有多个渠道（微信 / App）。
 * 当前策略：提醒优先投递到 App（离线排队、重连补发），App 投递异常时回退微信等渠道。
 * 本函数只决定「账号兜底顺序」——微信优先、App 排最后；已有 App 设备时，
 * 调用方（bridge/server.mjs 的 sendToPrincipal）会先尝试 App 设备。
 */
export function orderDeliveryAccounts(principal) {
  const accounts = Array.isArray(principal?.accounts) ? principal.accounts : []
  return [...accounts].sort((a, b) => {
    const score = (account) => (account?.sourceType === 'app' ? 1 : 0)
    return score(a) - score(b)
  })
}
