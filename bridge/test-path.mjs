import path from 'path'
import { fileURLToPath } from 'url'
import { listAllSessions } from '../agents/claude-cc/memory-store.mjs'

// 模拟 electron/main.js 的 __dirname
const electronDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron')
console.log('electronDir:', electronDir)

let adapterCwd = path.join(electronDir, '..', 'bridge', 'sessions', 'weixin')
console.log('before fix:', adapterCwd)
adapterCwd = adapterCwd.replace(/^[A-Z]:/, m => m.toLowerCase())
console.log('after fix:', adapterCwd)

const sessions = listAllSessions(adapterCwd)
console.log('sessions:', sessions.length)
sessions.forEach(s => console.log(' -', s.name, s.sessionId?.slice(0,8)))
