/**
 * Windows 键鼠模拟共享模块。
 *
 * 两种模式：
 *   1. 一次性模式（默认）：每次操作起一个 PowerShell 进程，带提示浮标、防抢检测、Esc 中止。
 *      开销约 1-2 秒（进程启动 + 编译 + 浮标停留）。
 *   2. 控制会话模式（快速）：通过 input_session 工具启动常驻守护进程（本机 127.0.0.1:47460），
 *      浮标常驻显示「Jarvis 正在控制键鼠（按 Esc 结束会话）」，之后每次操作只需 IPC 往返，
 *      通常 <100ms。空闲 3 分钟或按 Esc 或显式 stop 时自动结束。
 *
 * 会话模式下所有操作仍然做 Esc 中止检查；会话结束浮标自动消失。
 */

import { execFileSync, spawn } from 'child_process'
import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'

// ── 共享 PowerShell 片段 ──────────────────────────────────────────────────────

const PS_HEADER = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
`

const PS_W32_CS = `Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using System.Drawing;

public class W32 {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);

  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static uint LastInputTick() {
    LASTINPUTINFO l = new LASTINPUTINFO();
    l.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    GetLastInputInfo(ref l);
    return l.dwTime;
  }
  public static bool KeyDown(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);

  public static void SendUnicodeChar(int code) {
    INPUT[] arr = new INPUT[2];
    arr[0].type = 1; arr[0].U.ki.wVk = 0; arr[0].U.ki.wScan = (ushort)code; arr[0].U.ki.dwFlags = 0x0004;
    arr[1].type = 1; arr[1].U.ki.wVk = 0; arr[1].U.ki.wScan = (ushort)code; arr[1].U.ki.dwFlags = 0x0006;
    SendInput(2, arr, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void SendVk(ushort vk, bool down) {
    INPUT[] arr = new INPUT[1];
    arr[0].type = 1; arr[0].U.ki.wVk = vk; arr[0].U.ki.wScan = 0; arr[0].U.ki.dwFlags = down ? 0u : 0x0002u;
    SendInput(1, arr, Marshal.SizeOf(typeof(INPUT)));
  }
}

// 置顶提示浮标：不抢焦点、点击穿透
public class OverlayForm : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
      cp.ExStyle |= 0x00000020; // WS_EX_TRANSPARENT（点击穿透）
      return cp;
    }
  }
}
"@

[W32]::SetProcessDPIAware() | Out-Null
`

// 浮标 + 动作执行函数（一次性模式和守护进程共用）
const PS_ACTIONS = `
$script:overlay = $null

function Start-Overlay([string]$text) {
  $form = New-Object OverlayForm
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.TopMost = $true
  $form.ShowInTaskbar = $false
  $form.BackColor = [System.Drawing.Color]::FromArgb(38, 38, 38)
  $form.Opacity = 0.92
  $form.Size = [System.Drawing.Size]::new(360, 52)

  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $form.Location = [System.Drawing.Point]::new(($area.Right - 380), ($area.Bottom - 76))

  $label = New-Object System.Windows.Forms.Label
  $label.Text = $text
  $label.ForeColor = [System.Drawing.Color]::White
  $label.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 10)
  $label.Dock = [System.Windows.Forms.DockStyle]::Fill
  $label.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
  $form.Controls.Add($label)

  $form.Show()
  [System.Windows.Forms.Application]::DoEvents()
  $script:overlay = $form
}

function Pump([int]$ms) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $ms) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 15
  }
}

function Stop-Overlay() {
  if ($script:overlay) {
    try { $script:overlay.Close(); $script:overlay.Dispose() } catch {}
    $script:overlay = $null
  }
}

function Test-Abort {
  return [W32]::KeyDown(27)  # VK_ESCAPE
}

function Get-Pos {
  $p = New-Object W32+POINT
  [W32]::GetCursorPos([ref]$p) | Out-Null
  return $p
}

function Result-Json($extra) {
  $p = Get-Pos
  return ('{"ok":true,"cursorX":' + $p.X + ',"cursorY":' + $p.Y + $extra + '}')
}

function Abort-Json([string]$reason) {
  return ('{"ok":false,"error":"aborted","reason":"' + $reason + '"}')
}

function Invoke-Action($opt) {
  # 可选：先聚焦目标窗口
  if ($opt.window) {
    $needle = ([string]$opt.window).ToLower()
    $script:found = [IntPtr]::Zero
    $cb = [W32+EnumWindowsProc]{
      param($hWnd, $lParam)
      if ([W32]::IsWindowVisible($hWnd)) {
        $sb = New-Object System.Text.StringBuilder 512
        [W32]::GetWindowText($hWnd, $sb, 512) | Out-Null
        $t = $sb.ToString()
        if ($t -and $t.ToLower().Contains($needle)) {
          $script:found = $hWnd
          return $false
        }
      }
      return $true
    }
    [W32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
    if ($script:found -eq [IntPtr]::Zero) {
      return '{"ok":false,"error":"window-not-found"}'
    }
    [W32]::ShowWindow($script:found, 9) | Out-Null
    [W32]::SetForegroundWindow($script:found) | Out-Null
    Start-Sleep -Milliseconds 350
  }

  if ($opt.kind -eq 'mouse') {
    if (Test-Abort) { return (Abort-Json '按下了 Esc') }

    switch ($opt.action) {
      'move' {
        [W32]::SetCursorPos([int]$opt.x, [int]$opt.y) | Out-Null
      }
      'click' {
        if ($null -ne $opt.x -and $null -ne $opt.y) {
          [W32]::SetCursorPos([int]$opt.x, [int]$opt.y) | Out-Null
          Pump 50
          $p = Get-Pos
          if ([Math]::Abs($p.X - [int]$opt.x) -gt 2 -or [Math]::Abs($p.Y - [int]$opt.y) -gt 2) {
            return (Abort-Json '检测到你移动了鼠标')
          }
        }
        if (Test-Abort) { return (Abort-Json '按下了 Esc') }
        $down = 0x0002; $up = 0x0004
        if ($opt.button -eq 'right') { $down = 0x0008; $up = 0x0010 }
        if ($opt.button -eq 'middle') { $down = 0x0020; $up = 0x0040 }
        $times = 1
        if ($opt.double -eq $true) { $times = 2 }
        for ($i = 0; $i -lt $times; $i++) {
          [W32]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 30
          [W32]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
          if ($times -gt 1) { Start-Sleep -Milliseconds 60 }
        }
      }
      'scroll' {
        $notches = [int]($opt.amount)
        if ($notches -le 0) { $notches = 3 }
        $delta = [uint32]120
        if ($opt.direction -eq 'down') { $delta = [uint32]([int64]4294967296 - 120) }
        for ($i = 0; $i -lt $notches; $i++) {
          if (Test-Abort) { return (Abort-Json '按下了 Esc') }
          [W32]::mouse_event(0x0800, 0, 0, $delta, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 25
        }
      }
      'drag' {
        [W32]::SetCursorPos([int]$opt.x, [int]$opt.y) | Out-Null
        Start-Sleep -Milliseconds 60
        $p = Get-Pos
        if ([Math]::Abs($p.X - [int]$opt.x) -gt 2 -or [Math]::Abs($p.Y - [int]$opt.y) -gt 2) {
          return (Abort-Json '检测到你移动了鼠标')
        }
        $down = 0x0002; $up = 0x0004
        if ($opt.button -eq 'right') { $down = 0x0008; $up = 0x0010 }
        if ($opt.button -eq 'middle') { $down = 0x0020; $up = 0x0040 }
        [W32]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
        $steps = 12
        for ($i = 1; $i -le $steps; $i++) {
          if (Test-Abort) {
            [W32]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
            return (Abort-Json '按下了 Esc')
          }
          $nx = [int]([int]$opt.x + ([int]$opt.toX - [int]$opt.x) * $i / $steps)
          $ny = [int]([int]$opt.y + ([int]$opt.toY - [int]$opt.y) * $i / $steps)
          [W32]::SetCursorPos($nx, $ny) | Out-Null
          Start-Sleep -Milliseconds 15
        }
        Start-Sleep -Milliseconds 60
        [W32]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
      }
      'position' {
      }
      default {
        return '{"ok":false,"error":"unknown-mouse-action"}'
      }
    }
    return (Result-Json '')
  }

  if ($opt.kind -eq 'keyboard') {
    if ($opt.action -eq 'type') {
      $text = [string]$opt.text
      $count = 0
      foreach ($ch in $text.ToCharArray()) {
        if (Test-Abort) { return (Abort-Json '按下了 Esc') }
        $code = [int][char]$ch
        if ($code -eq 10) {
          [W32]::SendVk(13, $true); Start-Sleep -Milliseconds 10; [W32]::SendVk(13, $false)
        } elseif ($code -eq 9) {
          [W32]::SendVk(9, $true); Start-Sleep -Milliseconds 10; [W32]::SendVk(9, $false)
        } elseif ($code -gt 0) {
          [W32]::SendUnicodeChar($code)
        }
        Start-Sleep -Milliseconds 3
        $count++
      }
      return (Result-Json (',"chars":' + $count))
    }

    if ($opt.action -eq 'press') {
      $vks = @($opt.vks)
      if ($vks.Count -eq 0) { return '{"ok":false,"error":"no-keys"}' }
      $repeat = [int]($opt.repeat)
      if ($repeat -le 0) { $repeat = 1 }
      $interval = [int]($opt.intervalMs)
      if ($interval -lt 0) { $interval = 0 }
      for ($r = 0; $r -lt $repeat; $r++) {
        if (Test-Abort) { return (Abort-Json '按下了 Esc') }
        foreach ($vk in $vks) { [W32]::SendVk([uint16]$vk, $true); Start-Sleep -Milliseconds 15 }
        Start-Sleep -Milliseconds 25
        for ($i = $vks.Count - 1; $i -ge 0; $i--) { [W32]::SendVk([uint16]$vks[$i], $false); Start-Sleep -Milliseconds 10 }
        if ($r -lt ($repeat - 1) -and $interval -gt 0) { Start-Sleep -Milliseconds $interval }
      }
      return (Result-Json (',"repeat":' + $repeat))
    }

    return '{"ok":false,"error":"unknown-keyboard-action"}'
  }

  return '{"ok":false,"error":"unknown-kind"}'
}
`

// ── 一次性模式脚本 ───────────────────────────────────────────────────────────

const ONE_SHOT_DRIVER = `
$opt = __ARGS__ | ConvertFrom-Json

$needOverlay = -not ($opt.kind -eq 'mouse' -and $opt.action -eq 'position')
if ($needOverlay) {
  $label = 'Jarvis 正在操作键鼠…（按 Esc 中止）'
  if ($opt.overlayText) { $label = [string]$opt.overlayText + '（按 Esc 中止）' }
  Start-Overlay $label
  Pump 120
}

$resultJson = '{"ok":false,"error":"exception","detail":"unknown"}'
try {
  $resultJson = Invoke-Action $opt
} catch {
  $msg = $_.Exception.Message -replace '"', "'"
  $resultJson = '{"ok":false,"error":"exception","detail":"' + $msg + '"}'
}

if ($needOverlay) { Pump 1000 }
Stop-Overlay
Write-Output $resultJson
`

const PS_SCRIPT = PS_HEADER + PS_W32_CS + PS_ACTIONS + ONE_SHOT_DRIVER

// ── 控制会话守护进程脚本 ─────────────────────────────────────────────────────

const DAEMON_PORT = 47460
const DAEMON_IDLE_SECONDS = 180

const DAEMON_DRIVER = `
$port = ${DAEMON_PORT}
$server = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $port)
$server.Start()

Start-Overlay 'Jarvis 正在控制键鼠…（按 Esc 结束会话）'

$script:stopRequested = $false
$lastActive = [DateTime]::Now

while (-not $script:stopRequested) {
  [System.Windows.Forms.Application]::DoEvents()
  if ([W32]::KeyDown(27)) { break }
  if (([DateTime]::Now - $lastActive).TotalSeconds -gt ${DAEMON_IDLE_SECONDS}) { break }

  if ($server.Pending()) {
    try {
      $client = $server.AcceptTcpClient()
      $client.ReceiveTimeout = 15000
      $stream = $client.GetStream()
      $reader = New-Object System.IO.StreamReader($stream)
      $line = $reader.ReadLine()
      $resp = '{"ok":false,"error":"bad-request"}'
      if ($line) {
        try {
          $req = $line | ConvertFrom-Json
          if ($req.kind -eq 'session' -and $req.action -eq 'stop') {
            $script:stopRequested = $true
            $resp = '{"ok":true,"stopped":true}'
          } else {
            $resp = Invoke-Action $req
          }
        } catch {
          $msg = $_.Exception.Message -replace '"', "'"
          $resp = '{"ok":false,"error":"exception","detail":"' + $msg + '"}'
        }
      }
      $writer = New-Object System.IO.StreamWriter($stream)
      $writer.AutoFlush = $true
      $writer.WriteLine($resp)
      $reader.Dispose()
      $writer.Dispose()
      $client.Close()
    } catch {}
    $lastActive = [DateTime]::Now
  }
  Start-Sleep -Milliseconds 25
}

$server.Stop()
Stop-Overlay
`

const DAEMON_SCRIPT = PS_HEADER + PS_W32_CS + PS_ACTIONS + DAEMON_DRIVER

// ── 一次性执行 ──────────────────────────────────────────────────────────────

const ERROR_TEXT = {
  'window-not-found': '没有找到标题匹配的可见窗口',
  'unknown-mouse-action': '未知的鼠标操作',
  'unknown-keyboard-action': '未知的键盘操作',
  'no-keys': '没有可用的按键（keys 为空或无法解析）',
  'unknown-kind': '内部错误：未知的操作类型',
  'bad-request': '输入控制服务收到无效请求',
}

function normalizeResult(res, source) {
  if (!res.ok) {
    if (res.error === 'aborted') throw new Error(`操作已中止：${res.reason}`)
    if (res.error === 'exception') throw new Error(`脚本异常：${res.detail || ''}`)
    throw new Error(ERROR_TEXT[res.error] || `操作失败：${res.error}`)
  }
  return source ? { ...res, mode: source } : res
}

function runOneShot(opt) {
  const json = JSON.stringify(opt)
  const script = PS_SCRIPT.replace('__ARGS__', `'${json.replace(/'/g, "''")}'`)
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const stdout = execFileSync('powershell', [
    '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
  ], { encoding: 'utf8', timeout: 40000, stdio: 'pipe' })

  const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop() || '{}'
  let res
  try {
    res = JSON.parse(line)
  } catch {
    throw new Error(`脚本返回异常：${line.slice(0, 200)}`)
  }
  return res
}

// ── 控制会话（守护进程）────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function isDaemonAlive() {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port: DAEMON_PORT }, () => {
      sock.destroy()
      resolve(true)
    })
    sock.on('error', () => resolve(false))
    sock.setTimeout(800, () => { sock.destroy(); resolve(false) })
  })
}

/** 确保守护进程在运行；没跑就启动它。 */
export async function ensureDaemon({ timeoutMs = 15000 } = {}) {
  if (await isDaemonAlive()) return { started: false }
  // 守护脚本较长，走临时文件而不是 EncodedCommand（避免 Windows 命令行长度限制）。
  // 必须带 UTF-8 BOM：PowerShell 5.1 读取无 BOM 的 UTF-8 会按 GBK 解析，中文会破坏引号配对。
  const scriptPath = path.join(os.tmpdir(), 'jarvis_input_daemon.ps1')
  fs.writeFileSync(scriptPath, '﻿' + DAEMON_SCRIPT, 'utf-8')

  // 用 wscript + VBS 启动完全隐藏的独立进程：
  //   - node 的 detached 模式在 Windows 上会静默启动失败
  //   - cmd /c start 会留下可见的控制台窗口
  // VBS 的 Run(..., 0, False) 隐藏窗口且脱离父进程存活。
  const vbsPath = path.join(os.tmpdir(), 'jarvis_input_daemon_launcher.vbs')
  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """powershell"" -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${scriptPath}""", 0, False`,
    '',
  ].join('\r\n')
  fs.writeFileSync(vbsPath, vbs, 'utf-8')
  const child = spawn('wscript', [vbsPath], { stdio: 'ignore', windowsHide: true })
  child.unref()

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await sleep(250)
    if (await isDaemonAlive()) return { started: true }
  }
  throw new Error('输入控制服务启动超时')
}

/** 向守护进程发送一条操作请求。 */
function daemonRequest(req, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: DAEMON_PORT }, () => {
      sock.write(JSON.stringify(req) + '\n')
    })
    let buf = ''
    sock.on('data', d => { buf += d.toString('utf8') })
    sock.on('end', () => {
      try { resolve(JSON.parse(buf.trim() || '{}')) } catch (e) { reject(new Error('daemon 响应解析失败')) }
    })
    sock.on('error', reject)
    sock.setTimeout(timeoutMs, () => { sock.destroy(); reject(new Error('daemon 请求超时')) })
  })
}

/** 结束控制会话。 */
export async function stopDaemon() {
  if (!(await isDaemonAlive())) return { stopped: false }
  try {
    const res = await daemonRequest({ kind: 'session', action: 'stop' }, 5000)
    return { stopped: true, res }
  } catch {
    // 兜底：按命令行结束守护进程
    try {
      execFileSync('powershell', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*jarvis_input_daemon.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
      ], { timeout: 8000, stdio: 'pipe' })
    } catch {}
    await sleep(500)
    return { stopped: !(await isDaemonAlive()) }
  }
}

/** 查询控制会话状态。 */
export async function daemonStatus() {
  return { running: await isDaemonAlive(), port: DAEMON_PORT }
}

/**
 * 执行一次键鼠模拟。
 * - 会话模式（守护进程在跑）：走 IPC，快（毫秒级），浮标已在屏幕上
 * - 否则：一次性模式，带浮标和安全机制（约 1-2 秒开销）
 * @param {object} opt {kind:'mouse'|'keyboard', window?, overlayText?, ...操作参数}
 */
export async function runInput(opt) {
  // 会话模式优先
  if (await isDaemonAlive()) {
    try {
      const res = await daemonRequest(opt)
      return normalizeResult(res, 'session')
    } catch {
      // 守护进程异常，回落一次性模式
    }
  }
  const res = runOneShot(opt)
  return normalizeResult(res, 'oneshot')
}

// ── 按键组合解析 ────────────────────────────────────────────────────────────

const MODIFIERS = {
  ctrl: 17, control: 17,
  shift: 16,
  alt: 18,
  win: 91, windows: 91, meta: 91,
}

const KEY_NAMES = {
  enter: 13, return: 13,
  tab: 9, esc: 27, escape: 27,
  space: 32, backspace: 8,
  delete: 46, del: 46, insert: 45, ins: 45,
  home: 36, end: 35,
  pageup: 33, pgup: 33, pagedown: 34, pgdn: 34,
  up: 38, down: 40, left: 37, right: 39,
  capslock: 20, numlock: 144, scrolllock: 145,
  printscreen: 44, prtsc: 44,
  pause: 19,
}

/**
 * 把 "ctrl+shift+s" 这样的组合键解析成 VK 码数组。
 * @param {string} combo
 * @returns {number[]}
 */
export function parseCombo(combo) {
  const parts = String(combo || '').toLowerCase().split('+').map(s => s.trim()).filter(Boolean)
  if (!parts.length) throw new Error('组合键为空')

  const vks = []
  for (const part of parts) {
    if (MODIFIERS[part]) {
      vks.push(MODIFIERS[part])
      continue
    }
    if (KEY_NAMES[part]) {
      vks.push(KEY_NAMES[part])
      continue
    }
    if (/^f([1-9]|1[0-2])$/.test(part)) {
      vks.push(0x70 + Number(part.slice(1)) - 1)
      continue
    }
    if (/^[a-z]$/.test(part)) {
      vks.push(part.toUpperCase().charCodeAt(0))
      continue
    }
    if (/^[0-9]$/.test(part)) {
      vks.push(part.charCodeAt(0))
      continue
    }
    throw new Error(`无法识别的按键："${part}"`)
  }
  return vks
}
