import React from 'react'
import { VStack, HStack, Box, Text } from '@chakra-ui/react'
import { ui, thinScrollbar } from '../theme'

/**
 * 侧边栏
 *
 * Design Read: 桌面 AI 助手侧栏，用户是小范围私人用户；深绿底 + 偏白画布。
 * Operate 模式（dials：variance 4 / motion 3 / density 5）。
 * 规则：单一绿色 accent；不用侧边色条；不嵌套卡片；所有行有 hover/focus/active 状态；
 *       间距走 4/8/12/16 节奏；信息层级靠字号、字重和颜色，而不是边框。
 */

const S = ui.sidebar
const ACCENT = S.accent
const TEXT = S.text
const SUBTEXT = S.subtext
const OVERLAY = S.muted
const SURFACE = S.surface

const rowBase = {
  w: '100%',
  display: 'flex',
  alignItems: 'center',
  textAlign: 'left',
  border: 'none',
  bg: 'transparent',
  color: TEXT,
  cursor: 'pointer',
  font: 'inherit',
  borderRadius: '10px',
  transition: 'background-color 150ms ease-out, color 150ms ease-out, transform 120ms ease-out',
  _focusVisible: { outline: `2px solid ${ACCENT}`, outlineOffset: '2px' },
  _active: { transform: 'scale(0.99)' },
}

function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return `今天 ${hm}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

function RoleChip({ role }) {
  const owner = role === 'owner'
  return (
    <HStack
      as="span"
      gap="4px"
      px="6px"
      py="1px"
      borderRadius="full"
      bg={owner ? S.accentSoft : S.hover}
      color={owner ? ACCENT : SUBTEXT}
      fontSize="9.5px"
      fontWeight={500}
      letterSpacing="0.01em"
      flexShrink={0}
    >
      <Box
        as="span"
        w="4px"
        h="4px"
        borderRadius="full"
        bg={owner ? ACCENT : OVERLAY}
      />
      {owner ? '所有者' : '成员'}
    </HStack>
  )
}

function SectionLabel({ children, count }) {
  return (
    <HStack w="100%" px="10px" justify="space-between" mt="14px" mb="5px">
      <Text fontSize="10px" fontWeight={600} letterSpacing="0.08em" color={OVERLAY}>
        {children}
      </Text>
      {count !== undefined && (
        <Text fontSize="9.5px" color={OVERLAY} opacity={0.8}>{count}</Text>
      )}
    </HStack>
  )
}

/** 一个用户：头像 + 名字 + 角色 chip，下面是该用户的会话行 */
function UserGroup({ user, current, onSelectUser }) {
  const initial = (user.displayName || '?').slice(0, 1)
  return (
    <VStack align="stretch" gap="2px" mb="10px">
      <HStack px="10px" py="6px" gap="10px" minW={0}>
        <Box
          w="26px"
          h="26px"
          borderRadius="full"
          flexShrink={0}
          display="flex"
          alignItems="center"
          justifyContent="center"
          fontSize="11px"
          fontWeight={600}
          color={TEXT}
          bg={SURFACE}
          boxShadow={user.role === 'owner' ? `0 0 0 1px ${S.ownerRing}` : 'none'}
        >
          {initial}
        </Box>
        <HStack gap="7px" minW={0} flex="1">
          <Text
            fontSize="12.5px"
            fontWeight={500}
            color={TEXT}
            whiteSpace="nowrap"
            overflow="hidden"
            textOverflow="ellipsis"
          >
            {user.displayName}
          </Text>
          <RoleChip role={user.role} />
        </HStack>
      </HStack>

      <VStack align="stretch" gap="2px" pl="36px" pr="4px">
        {(user.sessions || []).length === 0 && (
          <Text px="10px" py="6px" fontSize="10.5px" color={OVERLAY}>暂无会话</Text>
        )}
        {(user.sessions || []).map(session => {
          const active = current.kind === 'user'
            && current.principalId === user.principalId
            && current.sessionId === session.sessionId
          return (
            <Box
              as="button"
              type="button"
              key={session.sessionId}
              title={session.name || '会话'}
              aria-current={active ? 'page' : undefined}
              {...rowBase}
              h="34px"
              px="10px"
              bg={active ? S.accentSoft : 'transparent'}
              _hover={{ bg: S.hover }}
              onClick={() => onSelectUser(user, session)}
            >
              <HStack w="100%" gap="8px" minW={0}>
                <Box
                  w="5px"
                  h="5px"
                  borderRadius="full"
                  flexShrink={0}
                  bg={active ? ACCENT : OVERLAY}
                  opacity={active ? 1 : 0.55}
                />
                <Text
                  flex="1"
                  minW={0}
                  fontSize="12px"
                  fontWeight={active ? 500 : 400}
                  color={active ? TEXT : SUBTEXT}
                  whiteSpace="nowrap"
                  overflow="hidden"
                  textOverflow="ellipsis"
                >
                  {session.name || '会话'}
                </Text>
                <Text fontSize="9.5px" color={OVERLAY} flexShrink={0}>
                  {formatTime(session.lastActiveAt)}
                </Text>
              </HStack>
            </Box>
          )
        })}
      </VStack>
    </VStack>
  )
}

export default function Sidebar({ mainSessions, users, current, onSelectMain, onSelectUser }) {
  const mainList = mainSessions.length
    ? mainSessions
    : [{ sessionId: null, name: '主会话', lastActiveAt: null }]

  return (
    <VStack
      w="240px"
      h="100%"
      minH={0}
      flexShrink={0}
      bg={S.bg}
      borderRightWidth={1}
      borderColor={S.border}
      gap={0}
      overflow="hidden"
    >
      <VStack
        w="100%"
        flex={1}
        minH={0}
        overflow="auto"
        gap={0}
        px="8px"
        py="12px"
        align="stretch"
        css={thinScrollbar(S.scrollbar, S.scrollbarHover)}
      >
        {/* 主会话永远置顶，不需要再套一个重复的标题 */}
        {mainList.map(session => {
          const active = current.kind === 'main'
            && (session.sessionId ? current.sessionId === session.sessionId : !current.sessionId)
          return (
            <Box
              as="button"
              type="button"
              key={session.sessionId || 'main'}
              title={session.name || '主会话'}
              aria-current={active ? 'page' : undefined}
              {...rowBase}
              h="52px"
              px="10px"
              mb="2px"
              bg={active ? S.accentSoft : 'transparent'}
              _hover={{ bg: S.hover }}
              onClick={() => onSelectMain(session.sessionId || null, session.name)}
            >
              <HStack w="100%" gap="10px" minW={0}>
                <Box
                  w="28px"
                  h="28px"
                  borderRadius="8px"
                  flexShrink={0}
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  fontSize="13px"
                  color={ACCENT}
                  bg={S.accentSoft}
                >
                  ✦
                </Box>
                <VStack align="flex-start" gap="1px" flex="1" minW={0}>
                  <Text fontSize="12.5px" fontWeight={600} color={TEXT} whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis">
                    {session.name || '主会话'}
                  </Text>
                  <Text fontSize="9.5px" color={OVERLAY}>{formatTime(session.lastActiveAt)}</Text>
                </VStack>
                {active && <Box w="5px" h="5px" borderRadius="full" bg={ACCENT} flexShrink={0} />}
              </HStack>
            </Box>
          )
        })}

        <Box h="1px" bg={S.divider} mx="10px" my="10px" />

        <SectionLabel count={users.length}>用户</SectionLabel>
        {users.length === 0 && (
          <Text px="10px" py="10px" fontSize="10.5px" color={OVERLAY}>暂无其他用户</Text>
        )}
        {users.map(user => (
          <UserGroup
            key={user.principalId}
            user={user}
            current={current}
            onSelectUser={onSelectUser}
          />
        ))}
      </VStack>
    </VStack>
  )
}
