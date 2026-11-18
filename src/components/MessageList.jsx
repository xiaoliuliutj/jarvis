import React from 'react'
import { VStack, HStack, Box, Text } from '@chakra-ui/react'
import ToolDetails from './ToolDetails'
import MarkdownText from './MarkdownText'
import { ui } from '../theme'

/**
 * 把 thinking/tool 归到紧随其后的 assistant 消息下。
 * 历史里旧数据可能同时有 thinking 和 assistant，重复内容会藏在折叠块里。
 */
function groupMessages(messages) {
  const groups = []
  let extras = []

  for (const msg of messages) {
    // 旧版本把“会话已超过 2 小时未活动”的提醒写成了 assistant 消息，数量很多，属于噪音
    if (typeof msg.text === 'string' && msg.text.includes('会话已超过') && msg.text.includes('未活动')) continue

    if (msg.type === 'tool' || msg.type === 'thinking') {
      extras.push(msg)
      continue
    }
    if (msg.type === 'assistant') {
      groups.push({ kind: 'assistant', text: msg.text || '', extras })
      extras = []
      continue
    }
    if (extras.length) {
      groups.push({ kind: 'extras', extras })
      extras = []
    }
    groups.push({ kind: msg.type, ...msg })
  }

  if (extras.length) groups.push({ kind: 'extras', extras })
  return groups
}

const userBubble = {
  bg: ui.userBubble.bg,
  border: `${ui.dividerWidth}px solid ${ui.userBubble.border}`,
  borderRadius: '16px 16px 4px 16px',
  px: 3,
  py: 2,
  maxW: '72%',
  fontSize: '15px',
  lineHeight: 1.65,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  color: ui.userBubble.text,
}

// 不用左侧色条（anti-slop），用底色 + 全边框建立层级
const assistantBubble = {
  bg: ui.canvas.surface,
  border: `${ui.dividerWidth}px solid ${ui.canvas.border}`,
  borderRadius: '4px 16px 16px 16px',
  px: 3,
  py: 2,
  maxW: '72%',
  fontSize: '15px',
  lineHeight: 1.65,
  wordBreak: 'break-word',
  color: ui.canvas.text,
}

export default function MessageList({ messages = [], pending = null, userName = '', isUserSession = false }) {
  const groups = groupMessages(messages)

  return (
    <VStack align="flex-start" w="100%" gap={2}>
      {groups.map((group, idx) => {
        if (group.kind === 'user') {
          return (
            <VStack key={idx} align="flex-end" w="100%" gap={0.5}>
              {isUserSession && (
                <Text fontSize="11px" color={ui.canvas.muted}>{userName || '用户'}</Text>
              )}
              <Box {...userBubble}>{group.text}</Box>
            </VStack>
          )
        }

        if (group.kind === 'assistant') {
          return (
            <VStack key={idx} align="flex-start" w="100%" gap={0.5}>
              <HStack gap="6px" align="center">
                <Box w="5px" h="5px" borderRadius="full" bg={ui.accent.base} />
                <Text fontSize="11px" fontWeight={500} color={ui.canvas.muted} letterSpacing="0.02em">Jarvis</Text>
              </HStack>
              <ToolDetails records={group.extras} />
              <Box {...assistantBubble}>
                <MarkdownText text={group.text} />
              </Box>
            </VStack>
          )
        }

        if (group.kind === 'extras') {
          return <ToolDetails key={idx} records={group.extras} />
        }

        if (group.kind === 'error') {
          return (
            <Box
              key={idx}
              alignSelf="flex-start"
              bg={ui.error.bg}
              border={`${ui.dividerWidth}px solid ${ui.error.border}`}
              borderRadius="8px"
              px={3}
              py={2}
              color={ui.error.text}
              fontSize="15px"
              maxW="72%"
              whiteSpace="pre-wrap"
              wordBreak="break-word"
            >
              ⚠️ {group.text}
            </Box>
          )
        }

        if (group.kind === 'system') {
          return (
            <Text key={idx} alignSelf="center" fontSize="12px" color={ui.canvas.muted} px={3} py={1}>
              {group.text}
            </Text>
          )
        }

        return null
      })}

      {pending && (
        <VStack align="flex-start" w="100%" gap={0.5}>
          <HStack gap="6px" align="center">
            <Box w="5px" h="5px" borderRadius="full" bg={ui.accent.base} />
            <Text fontSize="11px" fontWeight={500} color={ui.canvas.muted} letterSpacing="0.02em">Jarvis</Text>
          </HStack>
          <ToolDetails records={pending.tools || []} />
          {pending.text ? (
            <Box {...assistantBubble}>
              <MarkdownText text={pending.text} />
            </Box>
          ) : (
            <Box bg={ui.canvas.surfaceMuted} borderWidth={ui.dividerWidth} borderColor={ui.canvas.border} borderRadius="12px" px={3} py={2} fontSize="14px" color={ui.canvas.muted}>
              Jarvis 思考中…
            </Box>
          )}
        </VStack>
      )}
    </VStack>
  )
}
