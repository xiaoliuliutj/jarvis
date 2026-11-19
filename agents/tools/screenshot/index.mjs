/**
 * 截图工具。
 *
 * 三种模式：
 *   - screen：整个虚拟桌面（覆盖所有显示器）
 *   - region：指定区域（x/y/width/height，可为负坐标，自动钳制在屏幕范围内）
 *   - window：按窗口标题模糊匹配，默认先切到前台再截
 *
 * 输出 PNG 文件，默认保存到 userdata/<principal>/files/screenshots/；
 * sendToUser=true 时直接保存到发件箱，回合结束后由系统自动发回给用户。
 *
 * 依赖 Windows 自带的 PowerShell + .NET，无需安装额外软件。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pruneScreenshots } from '../../../core/files.mjs'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const principalId = process.env.JARVIS_PRINCIPAL_ID || ''

const PS_SCRIPT = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ArgsJson = __ARGS__
$opt = $ArgsJson | ConvertFrom-Json

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DpiHelper {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[DpiHelper]::SetProcessDPIAware() | Out-Null

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$left = $vs.Left
$top = $vs.Top
$width = $vs.Width
$height = $vs.Height
$windowTitle = ''

if ($opt.mode -eq 'region') {
  $left = [int]$opt.x
  $top = [int]$opt.y
  $width = [int]$opt.width
  $height = [int]$opt.height
}

if ($opt.mode -eq 'window') {
  $needle = ([string]$opt.window).ToLower()
  if (-not $needle) { Write-Output '{"ok":false,"error":"window-title-missing"}'; exit 0 }

  $script:found = [IntPtr]::Zero
  $script:foundTitle = ''
  $cb = [Win32+EnumWindowsProc]{
    param($hWnd, $lParam)
    if ([Win32]::IsWindowVisible($hWnd)) {
      $sb = New-Object System.Text.StringBuilder 512
      [Win32]::GetWindowText($hWnd, $sb, 512) | Out-Null
      $t = $sb.ToString()
      if ($t -and $t.ToLower().Contains($needle)) {
        $script:found = $hWnd
        $script:foundTitle = $t
        return $false
      }
    }
    return $true
  }
  [Win32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

  if ($script:found -eq [IntPtr]::Zero) {
    Write-Output '{"ok":false,"error":"window-not-found"}'
    exit 0
  }

  if ($opt.bringToFront -ne $false) {
    [Win32]::ShowWindow($script:found, 9) | Out-Null
    [Win32]::SetForegroundWindow($script:found) | Out-Null
    Start-Sleep -Milliseconds 400
  }

  $r = New-Object Win32+RECT
  [Win32]::GetWindowRect($script:found, [ref]$r) | Out-Null
  $left = $r.Left
  $top = $r.Top
  $width = $r.Right - $r.Left
  $height = $r.Bottom - $r.Top
  $windowTitle = $script:foundTitle
}

# 钳制到虚拟屏幕范围内
$maxRight = $vs.Left + $vs.Width
$maxBottom = $vs.Top + $vs.Height
if ($left -lt $vs.Left) { $width = $width - ($vs.Left - $left); $left = $vs.Left }
if ($top -lt $vs.Top) { $height = $height - ($vs.Top - $top); $top = $vs.Top }
if (($left + $width) -gt $maxRight) { $width = $maxRight - $left }
if (($top + $height) -gt $maxBottom) { $height = $maxBottom - $top }
if ($width -le 0 -or $height -le 0) {
  Write-Output '{"ok":false,"error":"invalid-region"}'
  exit 0
}

$bmp = New-Object System.Drawing.Bitmap $width, $height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($left, $top, 0, 0, $bmp.Size)
$bmp.Save($opt.out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

$titleEscaped = $windowTitle.Replace('\\\\', '\\\\\\\\').Replace('"', '\\"')
Write-Output ('{"ok":true,"left":' + $left + ',"top":' + $top + ',"width":' + $width + ',"height":' + $height + ',"windowTitle":"' + $titleEscaped + '"}')
`

const ERROR_TEXT = {
  'window-not-found': '没有找到标题匹配的可见窗口',
  'window-title-missing': 'window 模式需要提供窗口标题关键词',
  'invalid-region': '截图区域无效（宽或高小于等于 0，或完全在屏幕外）',
}

function timestamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function sanitizeFileName(name) {
  const base = path.basename(String(name || 'screenshot.png'))
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return cleaned.slice(0, 80) || 'screenshot.png'
}

function runCapture(opt) {
  const json = JSON.stringify(opt)
  const script = PS_SCRIPT.replace('__ARGS__', `'${json.replace(/'/g, "''")}'`)
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const stdout = execFileSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
  ], { encoding: 'utf8', timeout: 25000, stdio: 'pipe' })

  const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop() || '{}'
  let res
  try {
    res = JSON.parse(line)
  } catch {
    throw new Error(`截图脚本返回异常：${line.slice(0, 200)}`)
  }
  if (!res.ok) throw new Error(ERROR_TEXT[res.error] || `截图失败：${res.error}`)
  return res
}

/**
 * 执行截图。
 * @param {object} opts
 * @param {'screen'|'region'|'window'} opts.mode
 * @param {number} [opts.x]
 * @param {number} [opts.y]
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @param {string} [opts.window]
 * @param {boolean} [opts.bringToFront]
 * @param {boolean} [opts.sendToUser]
 * @param {string} [opts.fileName]
 * @returns {{path:string,width:number,height:number,sizeBytes:number,windowTitle?:string}}
 */
export function capture(opts = {}) {
  const mode = opts.mode || 'screen'
  const sendToUser = !!opts.sendToUser
  const pid = principalId || 'pc-main'
  const outDir = path.join(ROOT, 'userdata', pid, 'files', sendToUser ? 'outbox' : 'screenshots')
  fs.mkdirSync(outDir, { recursive: true })

  const name = sanitizeFileName(opts.fileName || `screenshot_${timestamp()}.png`)
  const out = path.join(outDir, name.replace(/\.(png|jpg|jpeg)$/i, '') + '.png')

  const psOpt = { mode, out, bringToFront: opts.bringToFront !== false }
  if (mode === 'region') {
    Object.assign(psOpt, {
      x: Number(opts.x ?? 0),
      y: Number(opts.y ?? 0),
      width: Number(opts.width ?? 0),
      height: Number(opts.height ?? 0),
    })
    if (!(psOpt.width > 0 && psOpt.height > 0)) throw new Error(ERROR_TEXT['invalid-region'])
  }
  if (mode === 'window') {
    if (!opts.window) throw new Error(ERROR_TEXT['window-title-missing'])
    psOpt.window = String(opts.window)
  }

  const res = runCapture(psOpt)
  const sizeBytes = fs.statSync(out).size
  // 截图目录按保留策略清理（7 天 / 最多 300 张），失败不影响截图本身
  try { pruneScreenshots(pid) } catch {}
  return {
    path: out,
    width: res.width,
    height: res.height,
    sizeBytes,
    ...(res.windowTitle ? { windowTitle: res.windowTitle } : {}),
  }
}

// ── CLI 自测：node index.mjs --cli '{"mode":"screen"}' ──────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
if (isMain && process.argv[2] === '--cli') {
  try {
    const opts = JSON.parse(process.argv[3] || '{}')
    const out = opts.out || path.join(os.tmpdir(), 'jarvis-screenshot-cli.png')
    const result = capture({ ...opts, fileName: path.basename(out) })
    // CLI 模式下可能改不了目录，直接覆盖路径输出
    console.log(JSON.stringify(result, null, 2))
  } catch (err) {
    console.error('FAIL:', err.message)
    process.exitCode = 1
  }
  process.exit()
}

// ── MCP ─────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'screenshot', version: '1.0.0' })

server.tool(
  'screenshot',
  '截取屏幕。mode=screen 全屏（含所有显示器）、region 指定区域、window 按窗口标题模糊匹配。' +
  '结果保存为 PNG 文件并返回路径，可用 Read 查看；sendToUser=true 时会直接发回给用户。',
  {
    mode: z.enum(['screen', 'region', 'window']).optional().describe('截图模式，默认 screen'),
    x: z.number().optional().describe('region 模式：左上角 X 坐标（可为负）'),
    y: z.number().optional().describe('region 模式：左上角 Y 坐标（可为负）'),
    width: z.number().optional().describe('region 模式：宽度（像素）'),
    height: z.number().optional().describe('region 模式：高度（像素）'),
    window: z.string().optional().describe('window 模式：窗口标题关键词（模糊匹配）'),
    bringToFront: z.boolean().optional().describe('window 模式：截图前是否把窗口切到前台，默认 true'),
    sendToUser: z.boolean().optional().describe('是否直接发回给用户（保存到发件箱），默认 false'),
    fileName: z.string().optional().describe('可选：输出文件名'),
  },
  async ({ mode, x, y, width, height, window: winTitle, bringToFront, sendToUser, fileName }) => {
    try {
      const result = capture({ mode, x, y, width, height, window: winTitle, bringToFront, sendToUser, fileName })
      const note = sendToUser
        ? '截图已放入发件箱，回合结束后会自动发回给用户。'
        : '截图已保存，可用 Read 工具查看内容。'
      return { content: [{ type: 'text', text: JSON.stringify({ ...result, note }, null, 2) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ ${err.message}` }] }
    }
  }
)

await server.connect(new StdioServerTransport())
