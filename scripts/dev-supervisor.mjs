/**
 * Jarvis 开发启动器。
 *
 * 为什么不继续用 concurrently -k：
 *   Electron 调 app.relaunch() 时，electron 子进程会退出；
 *   concurrently -k 会顺手把 Vite 杀掉，重启后的窗口连不上 5173。
 *
 * 这里由 supervisor 托管 Vite + Electron：
 *   - Vite 常驻，Electron 重启不影响前端；
 *   - POST /restart-electron 只重启 Electron；
 *   - 用户关闭窗口时一起退出，不留后台 Vite。
 *
 * 控制端口只绑定 127.0.0.1。
 */

import { spawn } from 'child_process'
import { createRequire } from 'module'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VITE_PORT = 5173
const SUPERVISOR_PORT = 7781
const ELECTRON = require('electron')

let viteProc = null
let electronProc = null
let shutdownStarted = false
let restartingElectron = false
let restartTimer = null
let controlServer = null
const recentCrashes = []

const log = (...args) => console.log('[supervisor]', ...args)

function killTree(child) {
  if (!child || child.killed) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

function shutdown(code = 0) {
  if (shutdownStarted) return
  shutdownStarted = true
  log(`关闭开发环境 (code=${code})`)
  if (restartTimer) clearTimeout(restartTimer)
  controlServer?.close()
  killTree(electronProc)
  killTree(viteProc)
  setTimeout(() => process.exit(code), 600)
}

function spawnVite() {
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  log('启动 Vite...')
  viteProc = spawn(process.execPath, [viteBin, '--port', String(VITE_PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  })

  viteProc.on('exit', (code, signal) => {
    viteProc = null
    if (shutdownStarted) return
    log(`Vite 退出 (code=${code}, signal=${signal})`)
    shutdown(1)
  })
}

function waitForVite(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()

    const retry = () => {
      if (shutdownStarted) return reject(new Error('supervisor 正在退出'))
      if (Date.now() - startedAt > timeoutMs) return reject(new Error('Vite 启动超时'))
      setTimeout(tick, 300)
    }

    const tick = () => {
      if (shutdownStarted) return reject(new Error('supervisor 正在退出'))
      // Vite 默认绑定 localhost，在 Windows 上通常是 ::1，不要写死 127.0.0.1
      http.get({ host: 'localhost', port: VITE_PORT, path: '/' }, res => {
        res.resume()
        if (res.statusCode && res.statusCode < 500) return resolve()
        retry()
      }).on('error', retry)
    }

    tick()
  })
}

function spawnElectron() {
  if (shutdownStarted) return

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.JARVIS_DEV_SUPERVISOR = '1'

  log('启动 Electron...')
  const child = spawn(ELECTRON, ['.'], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  })
  electronProc = child

  child.on('exit', (code, signal) => {
    if (electronProc === child) electronProc = null
    if (shutdownStarted) return

    if (restartingElectron) {
      restartingElectron = false
      // 等旧实例的 GPU/网络子进程完全退出、释放 %APPDATA%/jarvis 缓存目录句柄。
      // 太快重启会导致新实例报 "Unable to move the cache: 拒绝访问 (0x5)"。
      log('Electron 已退出，1.5 秒后重启')
      setTimeout(() => spawnElectron(), 1500)
      return
    }

    // 用户关闭窗口：连同 Vite 一起退出
    if (code === 0 || code === null) {
      log(`Electron 正常退出 (code=${code}, signal=${signal})`)
      shutdown(0)
      return
    }

    // 异常崩溃：60 秒内最多自动拉起 3 次
    const now = Date.now()
    while (recentCrashes.length && now - recentCrashes[0] > 60_000) recentCrashes.shift()
    recentCrashes.push(now)

    if (recentCrashes.length > 3) {
      log('Electron 连续崩溃，停止自动重启')
      shutdown(1)
      return
    }

    log(`Electron 异常退出 (code=${code}, signal=${signal})，2 秒后重启`)
    setTimeout(() => spawnElectron(), 2000)
  })
}

function scheduleElectronRestart() {
  if (shutdownStarted || restartingElectron) return

  restartingElectron = true
  log('收到重启 Electron 请求')

  // 先让 HTTP 响应和 MCP 工具返回，再杀进程
  restartTimer = setTimeout(() => {
    restartTimer = null
    if (!electronProc) {
      restartingElectron = false
      spawnElectron()
      return
    }
    killTree(electronProc)
  }, 400)
}

function startControlServer() {
  controlServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, vite: !!viteProc, electron: !!electronProc }))
      return
    }

    if (req.method === 'POST' && req.url === '/restart-electron') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      scheduleElectronRestart()
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'not found' }))
  })

  controlServer.on('error', (err) => {
    log('控制端口启动失败:', err.message)
    shutdown(1)
  })

  controlServer.listen(SUPERVISOR_PORT, '127.0.0.1', () => {
    log(`控制端口 http://127.0.0.1:${SUPERVISOR_PORT}`)
  })
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

async function main() {
  startControlServer()
  spawnVite()

  try {
    await waitForVite()
  } catch (err) {
    log(err.message)
    shutdown(1)
    return
  }

  spawnElectron()
}

main()
