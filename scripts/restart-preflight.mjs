/**
 * 重启前检查。
 *
 * 只做静态检查，不启动服务：
 *   - core/bridge/electron/agents/scripts 下的 .js/.mjs 语法
 *   - config 下实际 JSON 能否解析
 *   - 前端 vite build（--no-build 可跳过）
 *
 * 检查失败时退出码为 1，restart 工具会拒绝重启。
 */

import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECK_ROOTS = ['core', 'bridge', 'electron', 'agents', 'scripts']
const CONFIG_FILES = ['agent.json', 'bridge.json', 'principals.json', 'credentials.json']
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'sessions', 'memory'])
const noBuild = process.argv.includes('--no-build')

const files = []
const failures = []

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full)
    } else if (/\.(mjs|js)$/.test(entry.name)) {
      files.push(full)
    }
  }
}

function outputOf(err) {
  const text = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n').trim()
  return text.length > 3000 ? text.slice(0, 3000) + '\n...[已截断]' : text
}

for (const dir of CHECK_ROOTS) {
  const full = path.join(ROOT, dir)
  if (fs.existsSync(full)) walk(full)
}
// vite.config.js 是 ESM 但项目 package.json 是 commonjs，
// node --check 会误报；交给下面的 vite build 验证。

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe', timeout: 10_000 })
  } catch (err) {
    failures.push(`语法错误：${path.relative(ROOT, file)}\n${outputOf(err)}`)
  }
}

for (const name of CONFIG_FILES) {
  const file = path.join(ROOT, 'config', name)
  if (!fs.existsSync(file)) continue
  try {
    JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (err) {
    failures.push(`配置 JSON 解析失败：config/${name}\n${err.message}`)
  }
}

if (!noBuild) {
  try {
    const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
    execFileSync(process.execPath, [viteBin, 'build'], {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: 120_000,
    })
  } catch (err) {
    failures.push(`前端构建失败\n${outputOf(err)}`)
  }
}

if (failures.length) {
  console.error(`❌ 重启前检查失败（${failures.length} 项）\n`)
  console.error(failures.join('\n\n'))
  process.exit(1)
}

console.log(`✅ 重启前检查通过：${files.length} 个文件${noBuild ? '' : ' + 前端构建'}`)
