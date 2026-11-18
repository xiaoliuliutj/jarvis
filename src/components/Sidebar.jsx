import React from 'react'
import { VStack, HStack, Box, Button, Text } from '@chakra-ui/react'

/**
 * 侧边栏：
 *   - 主会话（唯一）
 *   - 用户列表：每个用户自己的会话（只读）
 * 不再有“新建会话”按钮：main 只有一个，用户会话由各自的渠道产生。
 */
export default function Sidebar({ mainSessions, users, current, onSelectMain, onSelectUser }) {
  const formatTime = (iso) => {
    if (!iso) return ''
    return new Date(iso).toLocaleString('zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  }

  const Entry = ({ active, name, time, onClick, muted = false }) => (
    <Button
      variant="ghost"
      w="100%"
      h="auto"
      px={3}
      py={2}
      justifyContent="flex-start"
      bg={active ? 'rgba(137,180,250,0.12)' : 'transparent'}
      borderLeftWidth={active ? 2 : 0}
      borderLeftColor={active ? '#89b4fa' : 'transparent'}
      _hover={{ bg: '#1a1a22' }}
      onClick={onClick}
    >
      <VStack align="flex-start" gap={0.5} w="100%">
        <Text fontSize="12.5px" fontWeight={450} color={active ? '#89b4fa' : muted ? '#6c7086' : '#cdd6f4'} whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis">
          {name}
        </Text>
        {time && <Text fontSize="10px" color="#6c7086">{time}</Text>}
      </VStack>
    </Button>
  )

  const mainActive = current.kind === 'main'
  const mainList = mainSessions.length
    ? mainSessions
    : [{ sessionId: null, name: '主会话', lastActiveAt: null }]

  return (
    <VStack
      w="220px"
      h="100%"
      minH={0}
      flexShrink={0}
      bg="#181825"
      borderRightWidth={1}
      borderColor="#313244"
      gap={0}
      overflow="hidden"
    >
      <VStack w="100%" flex={1} overflow="auto" gap={0} px={1.5} py={2} align="stretch">
        <Text px={2} py={1} fontSize="10px" color="#6c7086" letterSpacing="0.08em">主会话</Text>
        {mainList.map((s, idx) => (
          <Entry
            key={s.sessionId || 'main'}
            active={mainActive && (idx === 0 ? !current.sessionId || current.sessionId === s.sessionId : current.sessionId === s.sessionId)}
            name={s.name || '主会话'}
            time={formatTime(s.lastActiveAt)}
            onClick={() => onSelectMain(s.sessionId || null, s.name)}
          />
        ))}

        <Box h="1px" bg="#313244" my={2} mx={2} />

        <Text px={2} py={1} fontSize="10px" color="#6c7086" letterSpacing="0.08em">用户</Text>
        {users.length === 0 && (
          <Text px={2} py={2} fontSize="11px" color="#6c7086">暂无用户</Text>
        )}
        {users.map(user => (
          <VStack key={user.principalId} align="stretch" gap={0} mt={1}>
            <HStack px={2} py={1} justify="space-between">
              <Text fontSize="11px" color="#a6adc8" whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis">{user.displayName}</Text>
              <Text fontSize="9px" color={user.role === 'owner' ? '#f9e2af' : '#6c7086'}>
                {user.role === 'owner' ? 'OWNER' : 'USER'}
              </Text>
            </HStack>
            {user.sessions?.map(session => (
              <Entry
                key={session.sessionId}
                active={current.kind === 'user'
                  && current.principalId === user.principalId
                  && current.sessionId === session.sessionId}
                name={session.name || '会话'}
                time={formatTime(session.lastActiveAt)}
                muted
                onClick={() => onSelectUser(user, session)}
              />
            ))}
          </VStack>
        ))}
      </VStack>
    </VStack>
  )
}
