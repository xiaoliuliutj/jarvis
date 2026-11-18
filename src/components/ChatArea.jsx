import React, { useState, useEffect, useRef } from 'react'
import {
  VStack,
  HStack,
  Box,
  Textarea,
  Button,
} from '@chakra-ui/react'
import MessageList from './MessageList'

export default function ChatArea({ sessionId, adapterId, isBridge, isMain, busy, onBusyChange }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const scrollRef = useRef(null)

  // 加载会话历史
  useEffect(() => {
    loadSessionHistory()
  }, [sessionId, isBridge, adapterId])

  async function loadSessionHistory() {
    try {
      if (isBridge && adapterId) {
        const history = await window.jarvis.readBridgeSessionMessages(adapterId, sessionId)
        setMessages(history || [])
      } else {
        const history = await window.jarvis.readSessionMessages(sessionId)
        setMessages(history || [])
      }
    } catch (err) {
      console.error('[ChatArea] 加载历史失败:', err)
    }
  }

  function handleNewMessage(record) {
    setMessages(prev => [...prev, record])
  }

  // 监听流事件
  useEffect(() => {
    const unsubText = window.jarvis.onStreamText?.((data) => {
      handleNewMessage({ type: 'thinking', text: data.text })
    })

    const unsubTool = window.jarvis.onStreamTool?.((data) => {
      handleNewMessage({ type: 'tool', name: data.name, input: data.input })
    })

    const unsubResult = window.jarvis.onResult?.((data) => {
      if (!data.isError && data.text) {
        handleNewMessage({ type: 'assistant', text: data.text })
      } else if (data.isError) {
        handleNewMessage({ type: 'error', text: data.text })
      }
      onBusyChange(false)
    })

    return () => {
      unsubText?.()
      unsubTool?.()
      unsubResult?.()
    }
  }, [])

  // 自动滚到底部
  useEffect(() => {
    if (scrollRef.current) {
      setTimeout(() => {
        scrollRef.current?.scrollIntoView({ behavior: 'smooth' })
      }, 0)
    }
  }, [messages])

  async function handleSend() {
    if (!input.trim() || busy) return

    const text = input.trim()
    setInput('')
    onBusyChange(true)

    handleNewMessage({ type: 'user', text })

    try {
      const result = await window.jarvis.sendMessage(
        text,
        'claude-sonnet-5-5',
        'rulesOnly',
        sessionId.startsWith('__new__') ? null : sessionId,
        false,
      )

      if (result.isError) {
        handleNewMessage({ type: 'error', text: result.text })
      }
    } catch (err) {
      handleNewMessage({ type: 'error', text: err.message })
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
    <VStack flex={1} bg="#1e1e2e" spacing={0} overflow="hidden">
      <Box flex={1} w="100%" overflow="auto" px={4} py={4}>
        <MessageList messages={messages} isBridge={isBridge} adapterId={adapterId} />
        <div ref={scrollRef} />
      </Box>

      {!isBridge && (
        <HStack w="100%" px={4} py={3} bg="#181825" borderTopWidth={1} borderColor="#313244" spacing={2}>
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
            colorScheme="brand"
            onClick={handleSend}
            disabled={busy || !input.trim()}
            flexShrink={0}
            bg="#89b4fa"
            color="#1e1e2e"
            _hover={{ bg: '#a8c5ff' }}
            _disabled={{ bg: '#45475a', color: '#6c7086', cursor: 'not-allowed' }}
          >
            发送
          </Button>
        </HStack>
      )}
    </VStack>
  )
}
