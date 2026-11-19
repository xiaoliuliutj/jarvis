/**
 * adapters/weixin.mjs
 *
 * 微信 (iLink) adapter。
 * 实现完整的 iLink Bot API：QR 登录、长轮询收消息、发消息。
 * 不依赖 cc-connect，token 由本模块自己管理。
 *
 * 协议参考：https://github.com/epiral/weixin-bot/blob/main/PROTOCOL.md
 *
 * 使用：
 *   node bridge/adapters/weixin.mjs invite [accountKey]
 *   不传 accountKey 时使用 default；每个 accountKey 对应一个独立的 iLink bot 绑定。
 *   命令会生成并打开二维码图片，家人扫码确认即可。
 *   login 会写入 credentials.json，并把账号加入 bridge.json 的 accounts。
 *   （Bridge Server 启动时按 accounts 列表逐个调 start()）
 */

import https from 'https'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import QRCode from 'qrcode'
import { CREDENTIALS_FILE, BRIDGE_CONFIG_FILE } from '../../core/paths.mjs'

export const id = 'weixin'

const ILINK_BASE = 'https://ilinkai.weixin.qq.com'

// ── 配置读写 ──────────────────────────────────────────────────────────────────
// 微信 token 放在 config/credentials.json，Agent 不可读写。
// 每个 accountKey 对应一个独立的 iLink bot 绑定。

function loadWeixinConfig(accountKey = 'default') {
  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'))
  const wx = creds.weixin?.accounts?.[accountKey] ?? {}
  const token = wx.token ?? ''
  const bearerToken = token.includes(':') ? token.split(':').slice(1).join(':') : token
  return {
    accountKey,
    baseUrl: wx.baseUrl ?? ILINK_BASE,
    accountId: wx.accountId ?? '',
    bearerToken,
  }
}

function saveWeixinCredentials({ accountKey = 'default', accountId, bearerToken, baseUrl }) {
  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'))
  creds.weixin = creds.weixin || { accounts: {} }
  creds.weixin.accounts = creds.weixin.accounts || {}
  creds.weixin.accounts[accountKey] = {
    accountId,
    token: `${accountId}:${bearerToken}`,
    baseUrl: baseUrl ?? ILINK_BASE,
  }
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), 'utf8')
  console.log(`[weixin] credentials saved to config/credentials.json (account: ${accountKey})`)
}

/** 把新账号写进 bridge.json 的 accounts 列表，重启 Bridge 后自动开始轮询。 */
function ensureBridgeAccount(accountKey) {
  const bridge = JSON.parse(fs.readFileSync(BRIDGE_CONFIG_FILE, 'utf8'))
  bridge.adapters = bridge.adapters || {}
  bridge.adapters.weixin = bridge.adapters.weixin || { enabled: true }
  const conf = bridge.adapters.weixin
  const accounts = Array.isArray(conf.accounts)
    ? [...conf.accounts]
    : [conf.account || 'default']
  if (!accounts.includes(accountKey)) accounts.push(accountKey)
  conf.accounts = accounts
  conf.enabled = true
  fs.writeFileSync(BRIDGE_CONFIG_FILE, JSON.stringify(bridge, null, 2), 'utf8')
  console.log(`[weixin] bridge.json accounts: ${accounts.join(', ')}`)
}

function restartBridgeIfRunning() {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1',
      port: 7779,
      path: '/restart-bridge',
      method: 'POST',
      timeout: 1000,
    }, res => {
      res.resume()
      res.on('end', () => resolve(true))
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
    req.end()
  })
}

// ── QR 登录流程 ───────────────────────────────────────────────────────────────

async function showQrCodeImage(url, accountKey) {
  const safeKey = String(accountKey).replace(/[^a-zA-Z0-9_-]/g, '_')
  const file = path.join(os.tmpdir(), `jarvis-weixin-${safeKey}.png`)

  try {
    await QRCode.toFile(file, url, {
      width: 420,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    })
    console.log(`[weixin] 二维码已生成：${file}`)

    // Windows 默认图片查看器打开；其他平台只打印路径
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [file], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [file], { detached: true, stdio: 'ignore' }).unref()
    }
    return file
  } catch (err) {
    console.error('[weixin] 生成二维码图片失败:', err.message)
    return null
  }
}

/**
 * 完整的 QR 登录：获取二维码 → 等待扫码 → 写入 config/credentials.json。
 * accountKey 是本地账号名，例如 default / family_xiaoming。
 * 扫码的微信账号会绑定一个独立的 iLink bot。
 */
export async function login(accountKey = 'default', { manageBridge = true } = {}) {
  console.log(`[weixin] 获取二维码 (account: ${accountKey})...`)
  const qrResp = await ilinkGet(ILINK_BASE, '/ilink/bot/get_bot_qrcode?bot_type=3')
  const qrToken = qrResp.qrcode
  if (!qrToken) throw new Error('获取二维码失败: ' + JSON.stringify(qrResp))

  // qrcode_img_content 是微信实际扫描/打开的链接；qrcode 只是轮询 token。
  const url = qrResp.qrcode_img_content
    || `https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=${qrToken}&bot_type=3`
  console.log('[weixin] 请用要接入的微信账号扫描二维码（图片会自动打开）：')
  console.log('[weixin] 链接：' + url)
  console.log('[weixin] 注意：二维码只展示给要绑定的人，不要公开发布。')
  await showQrCodeImage(url, accountKey)

  // 轮询扫码状态
  let botToken = null, accountId = null, baseUrl = ILINK_BASE
  for (let i = 0; i < 20; i++) {
    const status = await ilinkGet(ILINK_BASE, `/ilink/bot/get_qrcode_status?qrcode=${qrToken}`,
      { 'iLink-App-ClientVersion': '1' }, 65000).catch(() => ({ status: 'wait' }))
    if (status.status === 'scaned') {
      console.log('[weixin] 已扫描，请在手机上确认...')
    }
    if (status.status === 'confirmed') {
      botToken   = status.bot_token
      accountId  = status.ilink_user_id || status.ilink_bot_id
      baseUrl    = status.baseurl ?? ILINK_BASE
      break
    }
    if (status.status === 'expired') throw new Error('二维码已过期，请重新运行 login')
  }

  if (!botToken) throw new Error('等待超时，未收到确认')
  saveWeixinCredentials({ accountKey, accountId, bearerToken: botToken, baseUrl })
  console.log(`[weixin] 登录成功！account: ${accountKey}, iLink accountId: ${accountId}`)

  if (manageBridge) {
    ensureBridgeAccount(accountKey)
    const restarted = await restartBridgeIfRunning()
    console.log(restarted
      ? '[weixin] Bridge 已收到重启指令，新账号会自动开始轮询。'
      : '[weixin] Bridge 当前未运行；启动 Bridge 后新账号生效。')
  }

  return { accountId, bearerToken: botToken, baseUrl, accountKey }
}

// ── HTTP 工具 ─────────────────────────────────────────────────────────────────

function ilinkGet(baseUrl, path_, extraHeaders = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const url = new URL(path_, baseUrl)
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      timeout: timeoutMs,
    }, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error(`iLink JSON parse error: ${data.slice(0, 200)}`)) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('iLink GET timeout')) })
    req.end()
  })
}

function ilinkPost(baseUrl, path_, body, timeoutMs = 40000, accountKey = 'default') {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const url = new URL(path_, baseUrl)
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'AuthorizationType': 'ilink_bot_token',
        'Authorization': `Bearer ${loadWeixinConfig(accountKey).bearerToken}`,
        'X-WECHAT-UIN': Buffer.from(String(Math.floor(Math.random() * 0xFFFFFFFF))).toString('base64'),
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error(`iLink JSON parse error: ${data.slice(0, 200)}`)) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('iLink request timeout')) })
    req.write(payload)
    req.end()
  })
}

// ── 状态 ──────────────────────────────────────────────────────────────────────

let running = false
// context_token 缓存：from_user_id → context_token（发消息时必须 echo back）
const contextTokenCache = new Map()

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── 长轮询主循环 ──────────────────────────────────────────────────────────────

/**
 * 启动 adapter，长轮询收微信消息。
 * 若 session 过期(-14)，自动触发登录流程后继续。
 * @param {(payload) => void} onMessage
 * @param {{accountId?: string}} opts
 */
export async function start(onMessage, opts = {}) {
  running = true
  const accountKey = opts.accountId || 'default'
  let syncBuf = ''

  const initial = loadWeixinConfig(accountKey)
  if (!initial.bearerToken) {
    throw new Error(`account ${accountKey} 没有 token，先运行 login ${accountKey}`)
  }

  console.log(`[weixin] adapter started (account: ${accountKey}), long-polling...`)

  while (running) {
    const { baseUrl } = loadWeixinConfig(accountKey)

    let resp
    try {
      resp = await ilinkPost(baseUrl, '/ilink/bot/getupdates',
        { get_updates_buf: syncBuf, base_info: { channel_version: '1' } }, 40000, accountKey)
    } catch (err) {
      if (!running) break
      console.error(`[weixin] poll error (${accountKey}):`, err.message)
      await sleep(5000)
      continue
    }

    if (resp.errcode === -14 || resp.ret === -14) {
      console.log(`[weixin] session expired (${accountKey})，自动触发重新登录...`)
      try {
        await login(accountKey, { manageBridge: false })
        syncBuf = ''
        console.log(`[weixin] 重新登录成功 (${accountKey})，继续轮询`)
      } catch (err) {
        console.error('[weixin] 登录失败:', err.message)
        await sleep(10000)
      }
      continue
    }

    // 有 errcode 且不是 -14，或者没有 get_updates_buf（说明不是正常响应）
    if (resp.errcode !== undefined && resp.errcode !== 0) {
      console.warn('[weixin] getupdates error:', JSON.stringify(resp).slice(0, 200))
      await sleep(3000)
      continue
    }

    if (resp.get_updates_buf) syncBuf = resp.get_updates_buf

    for (const msg of resp.msgs ?? []) {
      if (msg.message_type !== 1) continue
      if (msg.context_token) contextTokenCache.set(`${accountKey}:${msg.from_user_id}`, msg.context_token)
      const textItem = msg.item_list?.find(i => i.type === 1)
      const text = textItem?.text_item?.text ?? ''
      if (!text) continue
      onMessage({
        from: msg.from_user_id,
        text,
        attachments: [],
        timestamp: new Date(msg.create_time_ms ?? Date.now()).toISOString(),
      })
    }
  }

  console.log(`[weixin] adapter stopped (${accountKey})`)
}

/**
 * 把回复发回微信用户。
 * @param {string} to   接收方 from_user_id
 * @param {string} text 回复文本
 * @param {{accountId?: string}} opts
 */
export async function send(to, text, opts = {}) {
  const accountKey = opts.accountId || 'default'
  const { baseUrl } = loadWeixinConfig(accountKey)
  const contextToken = contextTokenCache.get(`${accountKey}:${to}`) ?? ''
  const clientId = randomBytes(8).toString('hex')

  try {
    const resp = await ilinkPost(baseUrl, '/ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: clientId,
        message_type: 2,       // BOT
        message_state: 2,      // FINISH
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: { channel_version: '1' },
    }, 15000, accountKey)

    if (resp.message_id) {
      console.log('[weixin] sendmessage ok, message_id:', resp.message_id)
    } else if (resp.errcode && resp.errcode !== 0) {
      console.error('[weixin] sendmessage failed:', resp.errcode, resp.errmsg)
    } else {
      console.warn('[weixin] sendmessage unexpected response:', JSON.stringify(resp).slice(0, 200))
    }
  } catch (err) {
    console.error('[weixin] send error:', err.message)
  }
}

export function stop() {
  running = false
}

// ── CLI 入口：node bridge/adapters/weixin.mjs login ────────────────────────────

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const cmd = process.argv[2]
  const accountKey = process.argv[3] || 'default'
  if (cmd === 'login' || cmd === 'invite') {
    login(accountKey).then(() => {
      process.exit(0)
    }).catch(err => {
      console.error('[weixin] 登录失败:', err.message)
      process.exit(1)
    })
  } else {
    console.log('用法:')
    console.log('  node bridge/adapters/weixin.mjs invite [accountKey]   生成二维码并等待家人扫码')
    console.log('  例: node bridge/adapters/weixin.mjs invite family_xiaoming')
    console.log('  login 是 invite 的别名')
    process.exit(0)
  }
}
