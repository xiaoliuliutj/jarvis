import React, { useState } from 'react'
import '../styles/InputBar.css'

export default function InputBar({ sessionId, busy, onBusy, onMessage }) {
  const [input, setInput] = useState('')

  async function handleSend() {
    if (!input.trim() || busy) return

    const text = input.trim()
    setInput('')
    onBusy(true)

    // 记录用户消息
    onMessage({ type: 'user', text })

    try {
      const result = await window.jarvis.sendMessage(
        text,
        'claude-sonnet-5-5',
        'rulesOnly',
        sessionId.startsWith('__new__') ? null : sessionId,
        false,
      )

      if (result.isError) {
        onMessage({ type: 'error', text: result.text })
      }
    } catch (err) {
      onMessage({ type: 'error', text: err.message })
      onBusy(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="input-row">
      <textarea
        className="input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="输入消息，Shift+Enter 换行，Enter 发送…"
        disabled={busy}
        rows="1"
      />
      <button
        className="btn-send"
        onClick={handleSend}
        disabled={busy || !input.trim()}
      >
        发送
      </button>
    </div>
  )
}
