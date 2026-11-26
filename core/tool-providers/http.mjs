/**
 * HTTP 工具 provider 接口。
 *
 * 本期只留接口，不实现 REST 调用、鉴权、密钥注入和重试。
 * 外接工具定义里 provider='http' 的工具会保持 available:false，直到这里实现。
 */

export function build(_definitions = [], _ctx = {}) {
  return {}
}
