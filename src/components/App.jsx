import React, { useState, useEffect } from 'react'
import { Box, VStack, HStack, Button, Text } from '@chakra-ui/react'
import Sidebar from './Sidebar'
import ChatArea from './ChatArea'
import SettingsPanel from './SettingsPanel'
import { ui, fonts } from '../theme'

/** 标题栏按钮共用样式，保证 hover/focus 一致 */
const titleButton = {
  size: 'sm',
  variant: 'ghost',
  color: ui.sidebar.subtext,
  _hover: { bg: ui.sidebar.hover },
  _focusVisible: { outline: `2px solid ${ui.sidebar.accent}`, outlineOffset: '2px' },
}

function formatScheduleTime(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

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
  const [scheduleReminder, setScheduleReminder] = useState(null)

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

  // main 的日程提醒由 Electron 推送过来；30 秒后自动收起
  useEffect(() => {
    const unsub = window.jarvis.onScheduleReminder?.((data) => {
      if (data?.schedule) setScheduleReminder(data.schedule)
    })
    return () => unsub?.()
  }, [])

  useEffect(() => {
    if (!scheduleReminder) return
    const timer = setTimeout(() => setScheduleReminder(null), 30_000)
    return () => clearTimeout(timer)
  }, [scheduleReminder])

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
    <VStack
      h="100vh"
      w="100%"
      gap={0}
      bg={ui.canvas.bg}
      align="stretch"
      css={{
        fontFamily: fonts.sans,
        // 显式启用 Windows ClearType；antialiased 会让小字号发虚
        WebkitFontSmoothing: 'subpixel-antialiased',
        textRendering: 'auto',
        '& button, & input, & textarea': { fontFamily: fonts.sans },
      }}
    >
      {/* 标题栏 */}
      <HStack
        h="40px"
        w="100%"
        px={3}
        bg={ui.titleBar.bg}
        borderBottomWidth={ui.dividerWidth}
        borderColor={ui.titleBar.border}
        justify="space-between"
        flex="none"
        css={{ WebkitAppRegion: 'drag' }}
      >
        <HStack gap={2} css={{ WebkitAppRegion: 'no-drag' }}>
          <Box fontSize="17px" color={ui.sidebar.accent}>✦</Box>
          <Box fontWeight={600} fontSize="15px" color={ui.sidebar.accent}>Jarvis</Box>
        </HStack>
        <HStack gap={1} css={{ WebkitAppRegion: 'no-drag' }}>
          <Button {...titleButton} onClick={() => setShowSettings(!showSettings)} title="设置">⚙</Button>
          <Button {...titleButton} onClick={() => window.jarvis.minimize()} title="最小化">─</Button>
          <Button {...titleButton} onClick={() => window.jarvis.close()} title="关闭">✕</Button>
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

      {scheduleReminder && (
        <Box
          position="fixed"
          top="52px"
          right="16px"
          w="320px"
          zIndex={150}
          bg={ui.canvas.surface}
          borderWidth={ui.dividerWidth}
          borderColor={ui.canvas.border}
          borderRadius="12px"
          boxShadow="0 10px 30px rgba(11, 31, 20, 0.16)"
          p={3}
        >
          <VStack align="stretch" gap={1.5}>
            <HStack justify="space-between" align="center">
              <HStack gap={2} align="center">
                <Box color={ui.accent.base} fontSize="14px">⏰</Box>
                <Text fontSize="12px" fontWeight={600} color={ui.accent.base}>日程提醒</Text>
              </HStack>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setScheduleReminder(null)}
                color={ui.canvas.muted}
                _hover={{ bg: ui.canvas.surfaceMuted }}
              >✕</Button>
            </HStack>
            <Text fontSize="14px" fontWeight={600} color={ui.canvas.text}>{scheduleReminder.title}</Text>
            <Text fontSize="12px" color={ui.canvas.subtext}>{formatScheduleTime(scheduleReminder.startAt)}</Text>
            {scheduleReminder.notes && (
              <Text fontSize="12px" color={ui.canvas.muted} whiteSpace="pre-wrap">
                {scheduleReminder.notes}
              </Text>
            )}
          </VStack>
        </Box>
      )}

      {showSettings && <SettingsPanel config={config} onClose={() => setShowSettings(false)} />}
    </VStack>
  )
}
