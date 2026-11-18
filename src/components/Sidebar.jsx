import React, { useState, useEffect } from 'react'
import {
  VStack,
  HStack,
  Box,
  Button,
  Text,
} from '@chakra-ui/react'

export default function Sidebar({ sessions, currentSessionId, onSelectSession, onRefresh }) {
  const [showAllSessions, setShowAllSessions] = useState(false)
  const [bridgeAdapters, setBridgeAdapters] = useState([])
  const SESSION_LIMIT = 8
  const ADAPTER_ICONS = { weixin: '💬', qq: '🐧', email: '📧' }

  useEffect(() => {
    loadBridgeAdapters()
  }, [])

  async function loadBridgeAdapters() {
    try {
      const adapters = await window.jarvis.getBridgeSessions()
      setBridgeAdapters(adapters || [])
    } catch (err) {
      console.error('[Sidebar] 加载 Bridge 适配器失败:', err)
    }
  }

  const mainSessions = sessions.filter(s => s.isMain)
  const activeSessions = sessions.filter(s => !s.isMain && s.isCurrent)
  const idleSessions = sessions.filter(s => !s.isMain && !s.isCurrent && !s.archivedAt)

  const formatTime = (iso) => {
    if (!iso) return ''
    return new Date(iso).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const SessionEntry = ({ session, isActive, isBridge = false, adapterId = null }) => (
    <Button
      variant="ghost"
      w="100%"
      h="auto"
      px={3}
      py={2}
      justifyContent="flex-start"
      bg={isActive ? 'rgba(137,180,250,0.12)' : 'transparent'}
      borderLeftWidth={isActive ? 2 : 0}
      borderLeftColor={isActive ? '#89b4fa' : 'transparent'}
      _hover={{ bg: '#1a1a22' }}
      onClick={() => onSelectSession(session.sessionId, isBridge, adapterId)}
    >
      <VStack align="flex-start" gap={0.5} w="100%">
        <Text fontSize="12.5px" fontWeight={450} color={isActive ? '#89b4fa' : '#cdd6f4'}>
          {session.name || '新会话'}
        </Text>
        <Text fontSize="10px" color="#6c7086">
          {formatTime(session.lastActiveAt)}
        </Text>
      </VStack>
    </Button>
  )

  return (
    <VStack
      w="220px"
      h="100%"
      bg="#181825"
      borderRightWidth={1}
      borderColor="#313244"
      gap={0}
      overflow="hidden"
    >
      <Button
        w="100%"
        h="auto"
        py={2}
        m={2.5}
        variant="outline"
        colorPalette="blue"
        fontSize="12.5px"
        justifyContent="flex-start"
        onClick={() => window.jarvis.newSession()}
        color="#89b4fa"
        borderColor="#313244"
        _hover={{ bg: '#1a1a22' }}
      >
        ＋ 新建会话
      </Button>

      <VStack w="100%" flex={1} overflow="auto" gap={0} px={1.5} py={1}>
        {mainSessions.map(s => (
          <SessionEntry
            key={s.sessionId}
            session={s}
            isActive={currentSessionId === s.sessionId}
          />
        ))}

        {activeSessions.map(s => (
          <SessionEntry
            key={s.sessionId}
            session={s}
            isActive={currentSessionId === s.sessionId}
          />
        ))}

        {idleSessions.slice(0, showAllSessions ? undefined : SESSION_LIMIT).map(s => (
          <SessionEntry
            key={s.sessionId}
            session={s}
            isActive={currentSessionId === s.sessionId}
          />
        ))}

        {!showAllSessions && idleSessions.length > SESSION_LIMIT && (
          <Button
            variant="ghost"
            fontSize="12px"
            w="100%"
            onClick={() => setShowAllSessions(true)}
            color="#6c7086"
            _hover={{ bg: '#1a1a22' }}
          >
            ↓ 还有 {idleSessions.length - SESSION_LIMIT} 个会话
          </Button>
        )}

        {/* Bridge 适配器会话 */}
        {bridgeAdapters.map(({ adapterId, sessions: adapterSessions }) => (
          adapterSessions && adapterSessions.length > 0 && (
            <VStack key={adapterId} w="100%" gap={1}>
              <Text fontSize="11px" fontWeight={500} color="#6c7086" w="100%">
                {ADAPTER_ICONS[adapterId] || '🔗'} {adapterId.toUpperCase()}
              </Text>
              {adapterSessions.map(s => (
                <SessionEntry
                  key={s.sessionId}
                  session={s}
                  isActive={currentSessionId === s.sessionId}
                  isBridge={true}
                  adapterId={adapterId}
                />
              ))}
            </VStack>
          )
        ))}
      </VStack>
    </VStack>
  )
}
