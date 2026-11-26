import React, { useState, useEffect, useRef } from 'react'
import { VStack, HStack, Box, Text, Textarea, Button } from '@chakra-ui/react'
import MessageList from './MessageList'
import { ui, thinScrollbar } from '../theme'

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
  const scrollContainerRef = useRef(null)
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

  // 只滚动消息容器，不能 scrollIntoView：那会把整个 HStack/页面一起滚走，
  // 导致侧边栏被滚出屏幕、聊天区高度失控。
  useEffect(() => {
    const el = scrollContainerRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages, pending])

  async function handleSend() {
    if (!input.trim() || busy || current.kind !== 'main') return

    const text = input.trim()
    const sentSessionId = current.sessionId || null
    setInput('')
    onBusyChange(true)
    setMessages(prev => [...prev, { type: 'user', text }])

    const turn = { text: '', tools: [] }
    pendingRef.current = turn
    setPending(turn)

    try {
      const result = await window.jarvis.sendMessage({
        prompt: text,
        sessionId: sentSessionId,
      })

      pendingRef.current = null
      setPending(null)

      // 新会话拿到真实 sessionId：仅当还停留在发送时的会话才切换视图
      if (result?.sessionId && result.sessionId !== sentSessionId) {
        const cur = currentRef.current
        const stillViewingSent = cur.kind === 'main' && (cur.sessionId || null) === sentSessionId
        if (stillViewingSent) onSessionChange(result.sessionId)
      }

      // 用户消息和工具记录在回合进行中已实时落盘；
      // 结束后统一从磁盘重载历史（user/tool/assistant 全在），避免与实时事件重复。
      if (currentRef.current.kind === 'main') setReloadKey(k => k + 1)
      onRefreshMain?.()
    } catch (err) {
      pendingRef.current = null
      setPending(null)
      // IPC 层面的失败不会进历史，直接在界面上提示
      if (currentRef.current.kind === 'main') {
        setMessages(prev => [...prev, { type: 'error', text: err.message || '发送失败' }])
      }
      console.error('[ChatArea] 发送失败:', err)
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
    <VStack flex={1} h="100%" minH={0} bg={ui.canvas.bg} gap={0} overflow="hidden">
      <Box
        ref={scrollContainerRef}
        flex={1}
        w="100%"
        minH={0}
        overflow="auto"
        px={4}
        py={4}
        css={thinScrollbar(ui.canvas.scrollbar, ui.canvas.scrollbarHover)}
      >
        <MessageList
          messages={messages}
          pending={pending}
          userName={isUserSession ? current.displayName : ''}
          isUserSession={isUserSession}
        />
      </Box>

      {isUserSession ? (
        <HStack w="100%" px={4} py={3} bg={ui.canvas.surface} borderTopWidth={ui.dividerWidth} borderColor={ui.canvas.border} justify="center">
          <Text fontSize="12px" color={ui.canvas.muted}>
            🔒 这是 {current.displayName} 的会话，只读；请通过用户自己的渠道回复
          </Text>
        </HStack>
      ) : (
        <HStack w="100%" px={4} py={3} bg={ui.canvas.surface} borderTopWidth={ui.dividerWidth} borderColor={ui.canvas.border} gap={2}>
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
            fontSize="15px"
            lineHeight={1.5}
            borderWidth={ui.dividerWidth}
            borderRadius="12px"
            bg={ui.canvas.surface}
            color={ui.canvas.text}
            borderColor={ui.canvas.borderStrong}
            _placeholder={{ color: ui.canvas.placeholder }}
            _focus={{ borderColor: ui.accent.base, boxShadow: `0 0 0 1px ${ui.accent.base}` }}
          />
          <Button
            colorPalette="green"
            onClick={handleSend}
            disabled={busy || !input.trim()}
            flexShrink={0}
            bg={ui.accent.base}
            color={ui.accent.on}
            _hover={{ bg: ui.accent.strong }}
            _active={{ bg: ui.accent.strong }}
            _focusVisible={{ outline: `2px solid ${ui.accent.base}`, outlineOffset: '2px' }}
            _disabled={{ bg: ui.canvas.surfaceMuted, color: ui.canvas.muted, cursor: 'not-allowed' }}
          >
            {busy ? '运行中喵…' : '发送'}
          </Button>
        </HStack>
      )}
    </VStack>
  )
}
