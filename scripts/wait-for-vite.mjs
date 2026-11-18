/** 等待 Vite dev server 就绪后再启动 Electron。 */
const deadline = Date.now() + 30_000

while (Date.now() < deadline) {
  try {
    const res = await fetch('http://localhost:5173', { signal: AbortSignal.timeout(1000) })
    if (res.ok) process.exit(0)
  } catch {}
  await new Promise(r => setTimeout(r, 300))
}

console.error('Vite 启动超时')
process.exit(1)
