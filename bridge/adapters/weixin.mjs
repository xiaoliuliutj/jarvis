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
 *   node bridge/adapters/weixin.mjs login   ← 扫码登录，写入 config/bridge.json
 *   （Bridge Server 启动时自动调 start()）
 */

import https from 'https'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { randomBytes } from 'crypto'

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.join(BRIDGE_DIR, '..', '..', 'config', 'bridge.json')
const ILINK_BASE = 'https://ilinkai.weixin.qq.com'

// ── 配置读写 ──────────────────────────────────────────────────────────────────

function loadWeixinConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  const wx = cfg.adapters?.weixin ?? {}
  const token = wx.token ?? ''
  const bearerToken = token.includes(':') ? token.split(':').slice(1).join(':') : token
  return {
    baseUrl: wx.baseUrl ?? ILINK_BASE,
    accountId: wx.accountId ?? '',
    bearerToken,
  }
}

function saveWeixinCredentials({ accountId, bearerToken, baseUrl }) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  cfg.adapters.weixin.token = `${accountId}:${bearerToken}`
  cfg.adapters.weixin.accountId = accountId
  cfg.adapters.weixin.baseUrl = baseUrl ?? ILINK_BASE
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8')
  console.log('[weixin] credentials saved to config/bridge.json')
}

// ── QR 登录流程 ───────────────────────────────────────────────────────────────

/**
 * 完整的 QR 登录：获取二维码 → 等待扫码 → 写入 config/bridge.json
 * 扫码后立刻返回，调用方接着 start() 保持 session 活跃。
 */
export async function login() {
  console.log('[weixin] 获取二维码...')
  const qrResp = await ilinkGet(ILINK_BASE, '/ilink/bot/get_bot_qrcode?bot_type=3')
  const qrToken = qrResp.qrcode
  if (!qrToken) throw new Error('获取二维码失败: ' + JSON.stringify(qrResp))

  const url = `https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=${qrToken}&bot_type=3`
  console.log('[weixin] 请用微信扫描以下链接：')
  console.log('[weixin] ' + url)

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
  saveWeixinCredentials({ accountId, bearerToken: botToken, baseUrl })
  console.log('[weixin] 登录成功！accountId:', accountId)
  return { accountId, bearerToken: botToken, baseUrl }
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

function ilinkPost(baseUrl, path_, body, timeoutMs = 40000) {
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
        'Authorization': `Bearer ${loadWeixinConfig().bearerToken}`,
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
 */
export async function start(onMessage) {
  running = true
  let syncBuf = ''

  console.log('[weixin] adapter started, long-polling...')

  while (running) {
    const { bearerToken, baseUrl } = loadWeixinConfig()

    let resp
    try {
      resp = await ilinkPost(baseUrl, '/ilink/bot/getupdates',
        { get_updates_buf: syncBuf, base_info: { channel_version: '1' } }, 40000)
    } catch (err) {
      if (!running) break
      console.error('[weixin] poll error:', err.message)
      await sleep(5000)
      continue
    }

    if (resp.errcode === -14 || resp.ret === -14) {
      console.log('[weixin] session expired，自动触发重新登录...')
      try {
        await login()
        syncBuf = ''
        console.log('[weixin] 重新登录成功，继续轮询')
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
      if (msg.context_token) contextTokenCache.set(msg.from_user_id, msg.context_token)
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

  console.log('[weixin] adapter stopped')
}

/**
 * 把回复发回微信用户。
 * @param {string} to   接收方 from_user_id
 * @param {string} text 回复文本
 */
export async function send(to, text) {
  const { baseUrl } = loadWeixinConfig()
  const contextToken = contextTokenCache.get(to) ?? ''
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
    }, 15000)

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
  if (cmd === 'login') {
    login().then(() => {
      console.log('[weixin] 登录完成，请立即启动 Bridge Server: node bridge/server.mjs')
      process.exit(0)
    }).catch(err => {
      console.error('[weixin] 登录失败:', err.message)
      process.exit(1)
    })
  } else {
    console.log('用法:')
    console.log('  node bridge/adapters/weixin.mjs login   扫码登录微信')
    process.exit(0)
  }
}
