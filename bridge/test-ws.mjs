/**
 * 测试脚本：连接 WS 7780，打印所有广播事件，10 秒后退出。
 */
import { WebSocket } from 'ws'

const ws = new WebSocket('ws://localhost:7780')

ws.on('open', () => {
  console.log('[test-ws] connected')
})

ws.on('message', (data) => {
  const event = JSON.parse(data)
  console.log('[event]', JSON.stringify(event, null, 2))
})

ws.on('error', err => console.error('[test-ws] error:', err.message))
ws.on('close', () => console.log('[test-ws] closed'))

setTimeout(() => { ws.close(); process.exit(0) }, 20000)
