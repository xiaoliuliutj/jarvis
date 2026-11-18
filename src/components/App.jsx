import React, { useState, useEffect } from 'react'
import { Box, VStack, HStack, Button } from '@chakra-ui/react'
import Sidebar from './Sidebar'
import ChatArea from './ChatArea'
import SettingsPanel from './SettingsPanel'

/**
 * 应用顶层。
 *
 * current 的两种形态：
 *   { kind:'main', sessionId, name }
 *   { kind:'user', principalId, sessionId, displayName, role, name }
 *
 * 用户会话在 PC 端只读；只有主会话可以发送消息。
 */
export default function App() {
  const [config, setConfig] = useState(null)
  const [mainSessions, setMainSessions] = useState([])
  const [users, setUsers] = useState([])
  const [current, setCurrent] = useState({ kind: 'main', sessionId: null, name: '主会话' })
  const [busy, setBusy] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    init()
    const unsub = window.jarvis.onBridgeEvent?.((event) => {
      if (event.type === 'reload-renderer') {
        window.location.reload()
        return
      }
      if (['incoming', 'result', 'error', 'released', 'cron_result'].includes(event.type)) {
        refreshUsers()
      }
      if (event.type === 'result' || event.type === 'cron_result') refreshMain()
    })
    return () => unsub?.()
  }, [])

  async function init() {
    const cfg = await window.jarvis.getConfig()
    setConfig(cfg)
    await refreshMain(true)
    await refreshUsers()
  }

  async function refreshMain(selectCurrent = false) {
    const [cur, info] = await Promise.all([
      window.jarvis.getMainSession(),
      window.jarvis.getSessionInfo(),
    ])
    setMainSessions(info?.sessions || [])
    if (selectCurrent) {
      setCurrent(cur?.sessionId
        ? { kind: 'main', sessionId: cur.sessionId, name: cur.name || '主会话' }
        : { kind: 'main', sessionId: null, name: '主会话' })
    }
  }

  async function refreshUsers() {
    const list = await window.jarvis.getUserSessions()
    setUsers(list || [])
  }

  function selectMain(sessionId, name) {
    setCurrent({ kind: 'main', sessionId: sessionId || null, name: name || '主会话' })
  }

  function selectUser(user, session) {
    setCurrent({
      kind: 'user',
      principalId: user.principalId,
      sessionId: session.sessionId,
      displayName: user.displayName,
      role: user.role,
      name: session.name,
    })
  }

  function handleSessionChange(sessionId) {
    setCurrent(c => ({ ...c, sessionId }))
    refreshMain()
    refreshUsers()
  }

  return (
    <VStack h="100vh" w="100%" gap={0} bg="#1e1e2e" align="stretch">
      {/* 标题栏 */}
      <HStack
        h="40px"
        w="100%"
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
          <Box fontWeight={600} fontSize="14px" color="#89b4fa">Jarvis</Box>
        </HStack>
        <HStack gap={1} css={{ WebkitAppRegion: 'no-drag' }}>
          <Button size="sm" variant="ghost" onClick={() => setShowSettings(!showSettings)} title="设置" color="#cdd6f4" _hover={{ bg: '#313244' }}>⚙</Button>
          <Button size="sm" variant="ghost" onClick={() => window.jarvis.minimize()} title="最小化" color="#cdd6f4" _hover={{ bg: '#313244' }}>─</Button>
          <Button size="sm" variant="ghost" onClick={() => window.jarvis.close()} title="关闭" color="#cdd6f4" _hover={{ bg: '#313244' }}>✕</Button>
        </HStack>
      </HStack>

      {/* 主体 */}
      <HStack flex={1} gap={0} w="100%" minH={0} align="stretch" overflow="hidden">
        <Sidebar
          mainSessions={mainSessions}
          users={users}
          current={current}
          onSelectMain={selectMain}
          onSelectUser={selectUser}
        />
        <ChatArea
          current={current}
          busy={busy}
          onBusyChange={setBusy}
          onSessionChange={handleSessionChange}
          onRefreshMain={refreshMain}
          onRefreshUsers={refreshUsers}
        />
      </HStack>

      {showSettings && <SettingsPanel config={config} onClose={() => setShowSettings(false)} />}
    </VStack>
  )
}
