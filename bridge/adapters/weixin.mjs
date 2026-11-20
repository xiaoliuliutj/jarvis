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
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto'
import QRCode from 'qrcode'
import { CREDENTIALS_FILE, BRIDGE_CONFIG_FILE } from '../../core/paths.mjs'
import { logWarn, logError } from '../../core/logger.mjs'

export const id = 'weixin'

const ILINK_BASE = 'https://ilinkai.weixin.qq.com'
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c'

// 媒体类型（getuploadurl 的 media_type）
const MEDIA_TYPE = Object.freeze({ IMG: 1, VID: 2, FILE: 3, VOICE: 4 })

// 单个入站媒体上限（超过不下载）
const MAX_INBOUND_MEDIA_SIZE = 20 * 1024 * 1024
// 单个出站文件上限
const MAX_OUTBOUND_FILE_SIZE = 20 * 1024 * 1024

// ── 媒体加密（AES-128-ECB + PKCS7）────────────────────────────────────────────

function aesEncrypt(key, data) {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

function aesDecrypt(key, data) {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

/**
 * 解析 aes_key 编码。
 * 协议约定：图片 = base64(原始16字节)；文件/语音/视频 = base64(32位hex字符串)。
 */
function parseAesKey(aesKeyB64, mediaType) {
  const raw = Buffer.from(aesKeyB64, 'base64')
  if (mediaType === MEDIA_TYPE.IMG && raw.length === 16) return raw
  const asHex = raw.toString('utf8')
  if (/^[0-9a-fA-F]{32}$/.test(asHex)) return Buffer.from(asHex, 'hex')
  if (raw.length === 16) return raw
  throw new Error('无法识别的 aes_key 编码')
}

/** 按协议把 16 字节密钥编码成 aes_key 字段。
 *  官方实现对出站媒体统一用 base64(hex string) 形式，接收方两种都兼容。 */
function encodeAesKey(key) {
  return Buffer.from(key.toString('hex'), 'utf8').toString('base64')
}

// ── 二进制 HTTP 请求（CDN 上传/下载用）────────────────────────────────────────

function httpBinary(urlStr, { method = 'GET', body = null, headers = {}, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('binary request timeout')) })
    if (body) req.write(body)
    req.end()
  })
}

// ── 媒体下载 / 上传（收发共用同一套 CDN 逻辑）──────────────────────────────────

/** 从 CDN 下载并解密媒体。
 *  directAesKeyHex：image_item.aeskey 这类 32 位 hex 字段，优先级高于 media.aes_key。 */
async function downloadMedia(media, mediaType, directAesKeyHex = null) {
  if (!media?.encrypt_query_param) throw new Error('缺少 encrypt_query_param')
  const url = `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
  const res = await httpBinary(url, { timeoutMs: 30000 })
  if (res.statusCode !== 200) throw new Error(`CDN 下载失败 HTTP ${res.statusCode}`)

  let key = null
  if (directAesKeyHex && /^[0-9a-fA-F]{32}$/.test(directAesKeyHex)) {
    key = Buffer.from(directAesKeyHex, 'hex')
  } else if (media.aes_key) {
    key = parseAesKey(media.aes_key, mediaType)
  }
  if (!key) return res.body

  try {
    return aesDecrypt(key, res.body)
  } catch (err) {
    console.warn('[weixin] 媒体解密失败，按明文处理:', err.message)
    return res.body
  }
}

/** 按文件头识别图片格式 */
function sniffImageExt(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf.length >= 6 && buf.slice(0, 3).toString('ascii') === 'GIF') return 'gif'
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp'
  if (buf.length >= 2 && buf.slice(0, 2).toString('ascii') === 'BM') return 'bmp'
  return 'bin'
}

/** 加密并上传媒体到 CDN，返回发送消息所需的参数 */
async function uploadMedia(buffer, mediaType, toUserId, accountKey) {
  const key = randomBytes(16)
  const encrypted = aesEncrypt(key, buffer)
  const filekey = randomBytes(16).toString('hex')
  const md5 = createHash('md5').update(buffer).digest('hex')
  const aesKeyEnc = encodeAesKey(key)
  const { baseUrl } = loadWeixinConfig(accountKey)

  const resp = await ilinkPost(baseUrl, '/ilink/bot/getuploadurl', {
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize: buffer.length,
    rawfilemd5: md5,
    filesize: encrypted.length,
    // 注意：这里的 aeskey 必须是 32 位 hex 字符串（不是 base64）
    aeskey: key.toString('hex'),
    no_need_thumb: true,
    base_info: { channel_version: '1.0.0' },
  }, 20000, accountKey)

  const uploadParam = resp.upload_param || resp.uploadParam
  if (!uploadParam) throw new Error(`getuploadurl 失败: ${JSON.stringify(resp).slice(0, 200)}`)

  const url = `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
  const up = await httpBinary(url, {
    method: 'POST',
    body: encrypted,
    headers: { 'Content-Type': 'application/octet-stream' },
    timeoutMs: 60000,
  })
  const downloadParam = up.headers['x-encrypted-param']
  if (!downloadParam) throw new Error(`CDN 上传失败: 缺少 x-encrypted-param 响应头 (HTTP ${up.statusCode})`)

  return { downloadParam, aesKey: aesKeyEnc, md5, rawSize: buffer.length }
}

// ── 入站 item 处理器（按 item.type 分发，扩展新类型在这里加）────────────────────

const INBOUND_ITEM_HANDLERS = {
  // type 2 = 图片
  2: async (item) => {
    const img = item.image_item
    if (!img?.media) return null
    const size = Number(img.mid_size || 0)
    if (size > MAX_INBOUND_MEDIA_SIZE) {
      console.warn(`[weixin] 图片过大，跳过下载 (${size} bytes)`)
      return null
    }
    const buffer = await downloadMedia(img.media, MEDIA_TYPE.IMG, img.aeskey || null)
    const ext = sniffImageExt(buffer)
    return {
      kind: 'image',
      fileName: `image_${Date.now()}.${ext}`,
      mimeType: ext === 'jpg' ? 'image/jpeg' : `image/${ext}`,
      buffer,
    }
  },
  // type 4 = 文件
  4: async (item) => {
    const f = item.file_item
    if (!f?.media) return null
    const size = Number(f.len || 0)
    if (size > MAX_INBOUND_MEDIA_SIZE) {
      console.warn(`[weixin] 文件过大，跳过下载: ${f.file_name} (${size} bytes)`)
      return null
    }
    const buffer = await downloadMedia(f.media, MEDIA_TYPE.FILE)
    return {
      kind: 'file',
      fileName: f.file_name || 'unnamed_file',
      mimeType: 'application/octet-stream',
      buffer,
    }
  },
  // type 2 = 图片、type 3 = 语音、type 5 = 视频：后续按同样方式扩展
}

async function collectInboundAttachments(items = []) {
  const attachments = []
  for (const item of items) {
    const handler = INBOUND_ITEM_HANDLERS[item.type]
    if (!handler) continue
    try {
      const att = await handler(item)
      if (att) attachments.push(att)
    } catch (err) {
      console.error(`[weixin] 接收附件失败 (item.type=${item.type}):`, err.message)
    }
  }
  return attachments
}

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
      const items = msg.item_list ?? []
      const text = items.find(i => i.type === 1)?.text_item?.text ?? ''
      const attachments = await collectInboundAttachments(items)
      if (!text && attachments.length === 0) continue
      onMessage({
        from: msg.from_user_id,
        text,
        attachments,
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

  let resp
  try {
    resp = await ilinkPost(baseUrl, '/ilink/bot/sendmessage', {
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
  } catch (err) {
    // 网络/HTTP 失败：必须抛错，否则 Bridge 会把「没发出去」当成已发送
    logError('weixin.send.fail', err.message, { accountKey })
    throw new Error(`sendmessage 网络失败: ${err.message}`)
  }

  if (resp.message_id) {
    console.log('[weixin] sendmessage ok, message_id:', resp.message_id)
    return resp
  }

  if (resp.errcode && resp.errcode !== 0) {
    const detail = `errcode=${resp.errcode}${resp.errmsg ? ` ${resp.errmsg}` : ''}`
    logError('weixin.send.fail', detail, { accountKey, errcode: resp.errcode })
    throw new Error(`sendmessage 失败: ${detail}`)
  }

  // 没有 message_id 也没有明确错误码：无法确认是否送达，只告警不抛错，避免重复发送
  logWarn('weixin.send.unexpected', JSON.stringify(resp).slice(0, 300), { accountKey })
  console.warn('[weixin] sendmessage unexpected response:', JSON.stringify(resp).slice(0, 200))
}

export function stop() {
  running = false
}

/**
 * 把本地文件发给微信用户（走 CDN 加密上传 + file_item 消息）。
 * @param {string} to   接收方 from_user_id
 * @param {string} filePath 本地文件绝对路径
 * @param {{accountId?: string, fileName?: string}} opts
 */
export async function sendFile(to, filePath, opts = {}) {
  const accountKey = opts.accountId || 'default'
  const { baseUrl } = loadWeixinConfig(accountKey)

  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error('不是文件')
  if (stat.size > MAX_OUTBOUND_FILE_SIZE) {
    throw new Error(`文件超过 ${Math.round(MAX_OUTBOUND_FILE_SIZE / 1024 / 1024)}MB 上限`)
  }

  const buffer = fs.readFileSync(filePath)
  const fileName = opts.fileName || path.basename(filePath)

  const { downloadParam, aesKey, md5, rawSize } = await uploadMedia(buffer, MEDIA_TYPE.FILE, to, accountKey)
  const contextToken = contextTokenCache.get(`${accountKey}:${to}`) ?? ''
  const clientId = randomBytes(8).toString('hex')

  const resp = await ilinkPost(baseUrl, '/ilink/bot/sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: clientId,
      message_type: 2,       // BOT
      message_state: 2,      // FINISH
      context_token: contextToken,
      item_list: [{
        type: 4,             // FILE
        file_item: {
          media: { encrypt_query_param: downloadParam, aes_key: aesKey, encrypt_type: 1 },
          file_name: fileName,
          md5,
          len: String(rawSize),
        },
      }],
    },
    base_info: { channel_version: '1' },
  }, 30000, accountKey)

  if (!resp.message_id) {
    throw new Error(`文件发送失败: ${JSON.stringify(resp).slice(0, 200)}`)
  }
  console.log(`[weixin] 文件已发送: ${fileName} (message_id: ${resp.message_id})`)
  return { messageId: resp.message_id }
}

/**
 * 把本地图片发给微信用户（图片消息，item type 2）。
 * @param {string} to   接收方 from_user_id
 * @param {string} filePath 本地图片绝对路径
 * @param {{accountId?: string, fileName?: string}} opts
 */
export async function sendImage(to, filePath, opts = {}) {
  const accountKey = opts.accountId || 'default'
  const { baseUrl } = loadWeixinConfig(accountKey)

  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error('不是文件')
  if (stat.size > MAX_OUTBOUND_FILE_SIZE) {
    throw new Error(`图片超过 ${Math.round(MAX_OUTBOUND_FILE_SIZE / 1024 / 1024)}MB 上限`)
  }

  const buffer = fs.readFileSync(filePath)
  const fileName = opts.fileName || path.basename(filePath)
  const { downloadParam, aesKey, rawSize } = await uploadMedia(buffer, MEDIA_TYPE.IMG, to, accountKey)
  // 图片消息的 mid_size 是密文大小：ceil((rawsize + 1) / 16) * 16
  const midSize = Math.ceil((rawSize + 1) / 16) * 16
  const contextToken = contextTokenCache.get(`${accountKey}:${to}`) ?? ''
  const clientId = randomBytes(8).toString('hex')

  const resp = await ilinkPost(baseUrl, '/ilink/bot/sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: clientId,
      message_type: 2,       // BOT
      message_state: 2,      // FINISH
      context_token: contextToken,
      item_list: [{
        type: 2,             // IMAGE
        image_item: {
          media: { encrypt_query_param: downloadParam, aes_key: aesKey, encrypt_type: 1 },
          mid_size: midSize,
        },
      }],
    },
    base_info: { channel_version: '1' },
  }, 30000, accountKey)

  if (!resp.message_id) {
    throw new Error(`图片发送失败: ${JSON.stringify(resp).slice(0, 200)}`)
  }
  console.log(`[weixin] 图片已发送: ${fileName} (message_id: ${resp.message_id})`)
  return { messageId: resp.message_id }
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
