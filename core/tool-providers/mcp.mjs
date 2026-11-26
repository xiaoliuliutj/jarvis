/**
 * 外部 MCP provider 接口。
 *
 * 本期只留接口，不实现远程 MCP server 的配置/鉴权/生命周期。
 * 外接工具定义里 provider='mcp' 的工具会保持 available:false，直到这里实现。
 */

export function build(_definitions = [], _ctx = {}) {
  return {}
}
