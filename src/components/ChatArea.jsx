import React, { useState, useEffect, useRef } from 'react'
import {
  VStack,
  HStack,
  Box,
  Text,
  Textarea,
  Button,
} from '@chakra-ui/react'
import MessageList from './MessageList'

export default function ChatArea({
  sessionId,
  adapterId,
  isBridge,
  isMain,
  busy,
  onBusyChange,
  onSessionChange,
  onRefreshSessions,
}) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(null)
  const pendingRef = useRef(null)
  const scrollRef = useRef(null)

  // 加载会话历史
  useEffect(() => {
    let cancelled = false
    pendingRef.current = null
    setPending(null)
    setMessages([])

    async function load() {
      try {
        if (isBridge && adapterId) {
          const history = await window.jarvis.readBridgeSessionMessages(adapterId, sessionId)
          if (!cancelled) setMessages(history || [])
        } else if (sessionId && !String(sessionId).startsWith('__')) {
          const history = await window.jarvis.readSessionMessages(sessionId)
          if (!cancelled) setMessages(history || [])
        }
      } catch (err) {
        console.error('[ChatArea] 加载历史失败:', err)
      }
    }

    load()
    return () => { cancelled = true }
  }, [sessionId, isBridge, adapterId])

  // PC 端流式事件：合并到同一个"正在生成"的回复中
  useEffect(() => {
    const unsubText = window.jarvis.onStreamText?.((data) => {
      const prev = pendingRef.current || { text: '', tools: [] }
      const next = { ...prev, text: (prev.text || '') + (data.text || '') }
      pendingRef.current = next
      setPending(next)
    })

    const unsubTool = window.jarvis.onStreamTool?.((data) => {
      const prev = pendingRef.current || { text: '', tools: [] }
      const next = {
        ...prev,
        tools: [...(prev.tools || []), { type: 'tool', name: data.name, input: data.input }],
      }
      pendingRef.current = next
      setPending(next)
    })

    return () => {
      unsubText?.()
      unsubTool?.()
    }
  }, [])

  // Bridge 端实时事件（微信消息进入时立即显示）
  useEffect(() => {
    if (!isBridge || !adapterId) return
    const unsub = window.jarvis.onBridgeEvent?.((event) => {
      if (event.adapterId && event.adapterId !== adapterId) return

      if (event.type === 'incoming') {
        setMessages(prev => [...prev, {
          type: 'user',
          text: event.payload?.text || '',
          from: event.payload?.from,
        }])
      } else if (event.type === 'tool') {
        setMessages(prev => [...prev, {
          type: 'tool',
          name: event.name,
          input: event.input,
        }])
      } else if (event.type === 'result') {
        setMessages(prev => [...prev, {
          type: 'assistant',
          text: event.text || '',
        }])
        onRefreshSessions?.()
      }
    })
    return () => unsub?.()
  }, [isBridge, adapterId, onRefreshSessions])

  // 自动滚到底部
  useEffect(() => {
    const id = setTimeout(() => {
      scrollRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, 0)
    return () => clearTimeout(id)
  }, [messages, pending])

  async function handleSend() {
    if (!input.trim() || busy || isBridge) return

    const text = input.trim()
    setInput('')
    onBusyChange(true)

    setMessages(prev => [...prev, { type: 'user', text }])
    const turn = { text: '', tools: [] }
    pendingRef.current = turn
    setPending(turn)

    // __main__ / __new__ 是前端占位 ID，不传给主进程
    const sessionArg = sessionId && !String(sessionId).startsWith('__') ? sessionId : null

    try {
      const result = await window.jarvis.sendMessage(
        text,
        'claude-sonnet-5-5',
        'rulesOnly',
        sessionArg,
        !!isMain,
      )

      const finalTurn = pendingRef.current || turn
      pendingRef.current = null
      setPending(null)

      if (result?.isError) {
        setMessages(prev => [
          ...prev,
          ...(finalTurn.tools || []),
          { type: 'error', text: result.text || '未知错误' },
        ])
      } else {
        const finalText = result?.text || finalTurn.text || ''
        setMessages(prev => [
          ...prev,
          ...(finalTurn.tools || []),
          ...(finalText ? [{ type: 'assistant', text: finalText }] : []),
        ])
      }

      // SDK 首次分配的真实 sessionId 同步给 App，后续消息才能续接同一会话
      if (result?.sessionId && onSessionChange) {
        onSessionChange(result.sessionId)
      }
      onRefreshSessions?.()
    } catch (err) {
      pendingRef.current = null
      setPending(null)
      setMessages(prev => [...prev, { type: 'error', text: err.message }])
      onRefreshSessions?.()
    } finally {
      onBusyChange(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <VStack flex={1} bg="#1e1e2e" gap={0} overflow="hidden">
      <Box flex={1} w="100%" overflow="auto" px={4} py={4}>
        <MessageList
          messages={messages}
          isBridge={isBridge}
          adapterId={adapterId}
          pending={pending}
        />
        <div ref={scrollRef} />
      </Box>

      {isBridge ? (
        <HStack
          w="100%"
          px={4}
          py={3}
          bg="#181825"
          borderTopWidth={1}
          borderColor="#313244"
          justify="center"
        >
          <Text fontSize="12px" color="#6c7086">
            🔒 该会话只能通过 {String(adapterId || '').toUpperCase()} 回复
          </Text>
        </HStack>
      ) : (
        <HStack w="100%" px={4} py={3} bg="#181825" borderTopWidth={1} borderColor="#313244" gap={2}>
          <Textarea
            flex={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息，Shift+Enter 换行，Enter 发送…"
            disabled={busy}
            rows={1}
            resize="none"
            maxH="120px"
            fontSize="13.5px"
            borderRadius="12px"
            bg="#313244"
            color="#cdd6f4"
            borderColor="#313244"
            _placeholder={{ color: '#6c7086' }}
            _focus={{ borderColor: '#89b4fa', boxShadow: '0 0 0 1px #89b4fa' }}
          />
          <Button
            colorPalette="blue"
            onClick={handleSend}
            disabled={busy || !input.trim()}
            flexShrink={0}
            bg="#89b4fa"
            color="#1e1e2e"
            _hover={{ bg: '#a8c5ff' }}
            _disabled={{ bg: '#45475a', color: '#6c7086', cursor: 'not-allowed' }}
          >
            {busy ? '运行中…' : '发送'}
          </Button>
        </HStack>
      )}
    </VStack>
  )
}
