/**
 * 端到端测试：发两条消息，验证会话 resume（agent 能记住上下文）
 */
import { WebSocket } from 'ws'
import http from 'http'

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = http.request({
      host: 'localhost', port: 7779, path: '/message', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)))
    })
    req.on('error', reject)
    req.write(body); req.end()
  })
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

const ws = new WebSocket('ws://localhost:7780')
const results = []

ws.on('open', async () => {
  console.log('✓ WS connected\n')
  await sleep(500)

  // 第一条消息
  console.log('→ 发送第一条消息：你好，你是谁？')
  const r1 = await sendMessage({ adapterId: 'weixin', from: 'testuser', text: '你好，你是谁？用一句话介绍自己。' })
  console.log('  接受状态:', r1.status, r1.messageId)

  // 等第一条完成
  await new Promise(resolve => {
    const check = setInterval(() => {
      if (results.find(e => e.type === 'result' && e.messageId === r1.messageId)) {
        clearInterval(check); resolve()
      }
    }, 500)
  })
  console.log()

  // 第二条消息（验证会话 resume）
  console.log('→ 发送第二条消息：你刚才说什么？')
  const r2 = await sendMessage({ adapterId: 'weixin', from: 'testuser', text: '你刚才说什么？重复一遍。' })
  console.log('  接受状态:', r2.status, r2.messageId)

  await new Promise(resolve => {
    const check = setInterval(() => {
      if (results.find(e => e.type === 'result' && e.messageId === r2.messageId)) {
        clearInterval(check); resolve()
      }
    }, 500)
  })

  ws.close()
  process.exit(0)
})

ws.on('message', data => {
  const event = JSON.parse(data)
  results.push(event)
  if (event.type === 'result') {
    console.log(`\n✓ result [${event.messageId}]`)
    console.log('  回复：', event.text?.slice(0, 200))
    console.log('  cost:', event.cost, 'turns:', event.turns, 'sessionId:', event.sessionId)
  } else if (event.type === 'active') {
    console.log('  [active]', event.adapterId)
  } else if (event.type === 'tool') {
    console.log('  [tool]', event.name)
  } else if (event.type === 'released') {
    console.log('  [released]', event.reason)
  }
})

ws.on('error', err => { console.error('WS error:', err.message); process.exit(1) })

setTimeout(() => { console.error('timeout'); process.exit(1) }, 120000)
