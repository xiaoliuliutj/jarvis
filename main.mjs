/**
 * Jarvis —— 基于 Claude Agent SDK 的个人 AI 助手
 *
 * 用法：ANTHROPIC_API_KEY=sk-ant-... node main.mjs
 *
 * Claude Agent SDK 的 query() 返回一个 AsyncGenerator<SDKMessage>。
 * 关键消息类型：
 *   - type: 'assistant'  → message.content 含 text/thinking/tool_use block
 *   - type: 'result'     → subtype: 'success'|'error_*'，result 字段是最终文本
 *   - type: 'system'     → 系统信息（初始化、工具进度等），大多数情况可忽略
 */

import { createInterface } from "readline";
import { query } from "@anthropic-ai/claude-agent-sdk";

// ── 配置 ──────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `\
你是 Jarvis，一个运行在用户本地电脑上的个人 AI 助手。

你内置了完整的 Claude Code 工具集，包括：
- Read / Glob / Grep：读取和搜索文件
- Bash：执行 shell 命令
- Edit / Write：修改和创建文件
以及更多工具。

工作原则：
1. 用户询问文件、目录或代码时，直接用工具查看，不要猜测。
2. 执行操作前，先用 Read/Glob 了解现状再动手。
3. 回答简洁直接。`;

// ── 多轮对话 REPL ─────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (p) => new Promise((r) => rl.question(p, r));

console.log("=".repeat(50));
console.log("  Jarvis 已启动  (Claude Agent SDK)");
console.log("  输入 'exit' 退出");
console.log("=".repeat(50));
console.log();

// Agent SDK 支持通过 resume/continue 跨轮次恢复会话。
// 这里用最简单的方式：每次对话开启新 query()，使用 continue: true 续接上一轮。
// 第一轮不传 continue，后续轮次传 continue: true 自动续接 cwd 下最近的会话。
let isFirstTurn = true;

while (true) {
  const userInput = (await ask("你: ")).trim();
  if (!userInput) continue;
  if (["exit", "quit", "退出"].includes(userInput.toLowerCase())) {
    console.log("再见！");
    break;
  }

  // ── 启动 Agent SDK query ──────────────────────────────────────────────────
  const q = query({
    prompt: userInput,
    options: {
      cwd: process.cwd(),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: SYSTEM_PROMPT,
      },
      // bypassPermissions：本地开发时跳过每次工具调用的确认弹窗
      // 生产环境请改为 'default' 或 'auto'
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // 续接上一轮会话（保持对话历史）
      ...(isFirstTurn ? {} : { continue: true }),
    },
  });

  isFirstTurn = false;

  // ── 消费 AsyncGenerator<SDKMessage> ──────────────────────────────────────
  for await (const msg of q) {
    if (msg.type === "assistant") {
      // 遍历 content block，打印工具调用
      for (const block of msg.message.content) {
        if (block.type === "tool_use") {
          const args = JSON.stringify(block.input ?? {});
          console.log(`  🔧 ${block.name}(${args.slice(0, 120)}${args.length > 120 ? "…" : ""})`);
        }
      }
    } else if (msg.type === "result") {
      if (msg.subtype === "success") {
        console.log(`\nJarvis: ${msg.result}\n`);
        // 打印本轮成本
        if (msg.total_cost_usd > 0) {
          console.log(`  [本次累计 $${msg.total_cost_usd.toFixed(4)}  |  ${msg.num_turns} 轮]\n`);
        }
      } else {
        // error subtypes: error_during_execution / error_max_turns / error_max_budget_usd
        console.log(`\n⚠️  ${msg.subtype}：${msg.errors?.join("; ") ?? "未知错误"}\n`);
      }
      break; // result 是本轮结束信号，跳出内层循环
    }
    // system / 其他消息类型静默忽略
  }
}

rl.close();
