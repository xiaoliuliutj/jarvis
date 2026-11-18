/**
 * 工具权限。
 *
 * 个人项目，不做 OS 沙箱；这里做路径级约束：
 *   - credentials.json / agent.json：任何 Agent 都不可读/写（均可能包含 token）
 *   - rules.md：可读，不可写
 *   - 自己的 userdata：可读写
 *   - 其他用户的数据：不可读写
 *   - 用户工具：所有用户可读；只有创建者/主会话可写
 *   - 项目代码：只有 editJarvisCode 的用户可写
 *   - Bash：放行，靠 prompt 约束（信任边界）
 */

import path from 'path'
import {
  ROOT,
  CONFIG_DIR,
  USERDATA_DIR,
  USER_TOOLS_DIR,
  CREDENTIALS_FILE,
  AGENT_CONFIG_FILE,
  RULES_FILE,
  principalDir,
  isInside,
} from './paths.mjs'

const FILE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'LS'])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

const allow = () => ({ behavior: 'allow' })
const deny = (message) => ({ behavior: 'deny', message })

function toolPath(toolName, input, workspace) {
  if (toolName === 'NotebookEdit') return input?.notebook_path
  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    return input?.file_path || input?.path
  }
  if (toolName === 'Glob' || toolName === 'Grep' || toolName === 'LS') {
    return input?.path || workspace
  }
  return input?.path
}

/**
 * @param {object} opts
 * @param {object} opts.principal
 * @param {string} opts.workspace  当前用户工作区（无 path 参数时的默认目录）
 */
export function buildCanUseTool({ principal, workspace }) {
  const ownRoot = principalDir(principal.id)
  const canEditCode = !!principal.capabilities?.editJarvisCode
  const isMaintainer = principal.role === 'maintainer'

  return async (toolName, input = {}) => {
    // 非文件工具（Bash、MCP 工具等）不在这里做路径判断
    if (!FILE_TOOLS.has(toolName)) return allow()

    const raw = toolPath(toolName, input, workspace)
    if (!raw) return allow()
    const abs = path.resolve(raw)
    const write = WRITE_TOOLS.has(toolName)

    // 凭证：不可读、不可写。agent.json 里现在也可能放 ANTHROPIC_AUTH_TOKEN
    if (abs === path.resolve(CREDENTIALS_FILE) || abs === path.resolve(AGENT_CONFIG_FILE)) {
      return deny('该配置包含模型凭证，不能读取或修改。')
    }

    // 全局 rules：可读不可写
    if (abs === path.resolve(RULES_FILE)) {
      return write ? deny('全局规则只能由用户手动修改。') : allow()
    }

    // 自己的用户目录：全部允许
    if (isInside(ownRoot, abs)) return allow()

    // 用户工具：所有用户可读；创建者或主会话可写
    if (isInside(USER_TOOLS_DIR, abs)) {
      if (!write) return allow()
      const rel = path.relative(USER_TOOLS_DIR, abs)
      const ownerId = rel.split(path.sep)[0]
      if (isMaintainer || ownerId === principal.id) return allow()
      return deny('只能修改自己创建的工具。')
    }

    // 其他用户的数据：不可读写
    if (isInside(USERDATA_DIR, abs)) {
      return deny('不能访问其他用户的数据。')
    }

    // 项目目录
    if (isInside(ROOT, abs)) {
      // config 下除凭证/rules 外的普通配置：读放行，写需要代码权限
      if (isInside(CONFIG_DIR, abs)) {
        return write && !canEditCode
          ? deny('普通用户不能修改系统配置。')
          : allow()
      }

      if (!write) return allow()
      return canEditCode
        ? allow()
        : deny('普通用户不能修改 Jarvis 项目代码。')
    }

    // 项目外路径：maintainer/owner 可访问；普通用户拒绝
    if (canEditCode) return allow()
    return deny('该路径不在可访问范围内。')
  }
}
