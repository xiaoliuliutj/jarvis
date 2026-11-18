import React, { useState, useEffect } from 'react'
import {
  Box,
  VStack,
  HStack,
  Button,
} from '@chakra-ui/react'
import Sidebar from './Sidebar'
import ChatArea from './ChatArea'
import SettingsPanel from './SettingsPanel'

export default function App() {
  const [sessions, setSessions] = useState([])
  const [currentSessionId, setCurrentSessionId] = useState('__main__')
  const [currentAdapterId, setCurrentAdapterId] = useState(null)
  const [isBridgeSession, setIsBridgeSession] = useState(false)
  const [isMainSession, setIsMainSession] = useState(true)
  const [busy, setBusy] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [config, setConfig] = useState(null)

  // 初始化
  useEffect(() => {
    initApp()
    // Bridge 端收到结果后刷新会话列表（即使当前看的是 PC 会话）
    const unsub = window.jarvis.onBridgeEvent?.((event) => {
      if (event.type === 'result' || event.type === 'released') refreshSessions()
    })
    return () => unsub?.()
  }, [])

  async function initApp() {
    try {
      const cfg = await window.jarvis.getConfig()
      setConfig(cfg)

      const mainSession = await window.jarvis.getMainSession({ cwd: null })
      setCurrentSessionId(mainSession?.sessionId || '__main__')

      refreshSessions()
    } catch (err) {
      console.error('[App] 初始化失败:', err)
    }
  }

  async function refreshSessions() {
    try {
      const info = await window.jarvis.getSessionInfo()
      setSessions(info?.sessions ?? [])
    } catch (err) {
      console.error('[App] 加载会话列表失败:', err)
    }
  }

  function handleSelectSession(sessionId, isBridge = false, adapterId = null, isMain = false) {
    setCurrentSessionId(sessionId)
    setIsBridgeSession(isBridge)
    setCurrentAdapterId(adapterId)
    setIsMainSession(isBridge ? false : !!isMain)
  }

  function handleSessionChange(newSessionId) {
    setCurrentSessionId(newSessionId)
    refreshSessions()
  }

  return (
    <VStack h="100vh" gap={0} bg="#1e1e2e">
      {/* 标题栏 */}
      <HStack
        h="40px"
        px={3}
        bg="#11111b"
        borderBottomWidth={1}
        borderColor="#313244"
        justify="space-between"
        flex="none"
        css={{ WebkitAppRegion: 'drag' }}
      >
        <HStack gap={2} css={{ WebkitAppRegion: 'no-drag' }}>
          <Box fontSize="16px" color="#89b4fa">✦</Box>
          <Box fontWeight={600} fontSize="14px" color="#89b4fa">
            Jarvis
          </Box>
        </HStack>
        <HStack gap={1} css={{ WebkitAppRegion: 'no-drag' }}>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowSettings(!showSettings)}
            title="设置"
            color="#cdd6f4"
            _hover={{ bg: '#313244' }}
          >
            ⚙
          </Button>
          <Button size="sm" variant="ghost" onClick={() => window.jarvis.minimize()} title="最小化" color="#cdd6f4" _hover={{ bg: '#313244' }}>
            ─
          </Button>
          <Button size="sm" variant="ghost" onClick={() => window.jarvis.close()} title="关闭" color="#cdd6f4" _hover={{ bg: '#313244' }}>
            ✕
          </Button>
        </HStack>
      </HStack>

      {/* 主体 */}
      <HStack flex={1} gap={0} w="100%" overflow="hidden">
        <Sidebar
          sessions={sessions}
          currentSessionId={currentSessionId}
          onSelectSession={handleSelectSession}
          onRefresh={refreshSessions}
        />

        <ChatArea
          sessionId={currentSessionId}
          adapterId={currentAdapterId}
          isBridge={isBridgeSession}
          isMain={isMainSession}
          busy={busy}
          onBusyChange={setBusy}
          onSessionChange={handleSessionChange}
          onRefreshSessions={refreshSessions}
        />
      </HStack>

      {showSettings && <SettingsPanel config={config} onClose={() => setShowSettings(false)} />}
    </VStack>
  )
}
