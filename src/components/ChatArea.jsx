import React, { useState, useEffect, useRef } from 'react'
import { VStack, HStack, Box, Text, Textarea, Button } from '@chakra-ui/react'
import MessageList from './MessageList'

/**
 * 对话区。
 *
 * 主会话：可发送，走 Electron IPC → ConversationService。
 * 用户会话：只读，展示该用户自己的历史与实时事件。
 */
export default function ChatArea({
  current,
  busy,
  onBusyChange,
  onSessionChange,
  onRefreshMain,
  onRefreshUsers,
}) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)
  const pendingRef = useRef(null)
  const scrollRef = useRef(null)
  const currentRef = useRef(current)
  currentRef.current = current

  // 加载当前会话历史
  useEffect(() => {
    let cancelled = false
    pendingRef.current = null
    setPending(null)
    setMessages([])

    async function load() {
      try {
        if (current.kind === 'user') {
          if (!current.principalId || !current.sessionId) return
          const history = await window.jarvis.readUserSessionMessages(current.principalId, current.sessionId)
          if (!cancelled) setMessages(history || [])
        } else if (current.sessionId) {
          const history = await window.jarvis.readSessionMessages(current.sessionId)
          if (!cancelled) setMessages(history || [])
        }
      } catch (err) {
        console.error('[ChatArea] 加载历史失败:', err)
      }
    }

    load()
    return () => { cancelled = true }
  }, [current.kind, current.principalId, current.sessionId, reloadKey])

  // 主会话流式事件：合并成一个正在生成的回复
  useEffect(() => {
    const unsubText = window.jarvis.onStreamText?.((data) => {
      if (currentRef.current.kind !== 'main') return
      const prev = pendingRef.current || { text: '', tools: [] }
      const next = { ...prev, text: (prev.text || '') + (data.text || '') }
      pendingRef.current = next
      setPending(next)
    })

    const unsubTool = window.jarvis.onStreamTool?.((data) => {
      if (currentRef.current.kind !== 'main') return
      const prev = pendingRef.current || { text: '', tools: [] }
      const next = { ...prev, tools: [...(prev.tools || []), { type: 'tool', name: data.name, input: data.input }] }
      pendingRef.current = next
      setPending(next)
    })

    return () => {
      unsubText?.()
      unsubTool?.()
    }
  }, [])

  // 用户会话的实时事件
  useEffect(() => {
    const unsub = window.jarvis.onBridgeEvent?.((event) => {
      const cur = currentRef.current
      if (cur.kind !== 'user') return
      if (event.principalId && event.principalId !== cur.principalId) return

      // 只把事件显示到当前正在看的那个会话；新会话在 result 后刷新列表再进入
      const sameSession = !!event.sessionId && !!cur.sessionId && event.sessionId === cur.sessionId

      if (event.type === 'incoming') {
        if (!sameSession) return
        setMessages(prev => [...prev, {
          type: 'user',
          text: event.payload?.text || '',
          from: event.payload?.from,
        }])
      } else if (event.type === 'tool') {
        if (!sameSession) return
        setMessages(prev => [...prev, { type: 'tool', name: event.name, input: event.input }])
      } else if (event.type === 'result') {
        if (sameSession) {
          setMessages(prev => [...prev, { type: 'assistant', text: event.text || '' }])
        }
        onRefreshUsers?.()
      } else if (event.type === 'error') {
        if (!sameSession) return
        setMessages(prev => [...prev, { type: 'error', text: event.text || '服务暂时不可用' }])
      }
    })
    return () => unsub?.()
  }, [onRefreshUsers])

  // main 的定时任务结果：刷新主会话历史
  useEffect(() => {
    const unsub = window.jarvis.onCronResult?.(() => {
      if (currentRef.current.kind !== 'main') return
      setReloadKey(k => k + 1)
      onRefreshMain?.()
    })
    return () => unsub?.()
  }, [onRefreshMain])

  // 自动滚到底部
  useEffect(() => {
    const id = setTimeout(() => {
      scrollRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, 0)
    return () => clearTimeout(id)
  }, [messages, pending])

  async function handleSend() {
    if (!input.trim() || busy || current.kind !== 'main') return

    const text = input.trim()
    setInput('')
    onBusyChange(true)
    setMessages(prev => [...prev, { type: 'user', text }])

    const turn = { text: '', tools: [] }
    pendingRef.current = turn
    setPending(turn)

    try {
      const result = await window.jarvis.sendMessage({
        prompt: text,
        sessionId: current.sessionId || null,
      })

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

      if (result?.sessionId && result.sessionId !== current.sessionId) {
        onSessionChange(result.sessionId)
      }
      onRefreshMain?.()
    } catch (err) {
      pendingRef.current = null
      setPending(null)
      setMessages(prev => [...prev, { type: 'error', text: err.message }])
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

  const isUserSession = current.kind === 'user'

  return (
    <VStack flex={1} bg="#1e1e2e" gap={0} overflow="hidden">
      <Box flex={1} w="100%" overflow="auto" px={4} py={4}>
        <MessageList
          messages={messages}
          pending={pending}
          userName={isUserSession ? current.displayName : ''}
          isUserSession={isUserSession}
        />
        <div ref={scrollRef} />
      </Box>

      {isUserSession ? (
        <HStack w="100%" px={4} py={3} bg="#181825" borderTopWidth={1} borderColor="#313244" justify="center">
          <Text fontSize="12px" color="#6c7086">
            🔒 这是 {current.displayName} 的会话，只读；请通过用户自己的渠道回复
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
