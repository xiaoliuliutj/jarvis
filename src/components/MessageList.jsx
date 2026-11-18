import React from 'react'
import { VStack, Box, Text } from '@chakra-ui/react'
import ToolDetails from './ToolDetails'
import MarkdownText from './MarkdownText'

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
  bg: '#313244',
  border: '1px solid #45475a',
  borderRadius: '18px 18px 4px 18px',
  px: 3,
  py: 2,
  maxW: '72%',
  fontSize: '13.5px',
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  color: '#cdd6f4',
}

const assistantBubble = {
  bg: '#1e1e2e',
  border: '1px solid #313244',
  borderLeftWidth: '2px',
  borderLeftColor: '#89b4fa',
  borderRadius: '4px 18px 18px 18px',
  px: 3,
  py: 2,
  maxW: '72%',
  fontSize: '13.5px',
  lineHeight: 1.6,
  wordBreak: 'break-word',
  color: '#cdd6f4',
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
                <Text fontSize="10px" color="#6c7086">{userName || '用户'}</Text>
              )}
              <Box {...userBubble}>{group.text}</Box>
            </VStack>
          )
        }

        if (group.kind === 'assistant') {
          return (
            <VStack key={idx} align="flex-start" w="100%" gap={0.5}>
              <Text fontSize="11px" fontWeight={500} color="#6c7086">Jarvis</Text>
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
              bg="#1a1515"
              border="1px solid #613a3a"
              borderRadius="8px"
              px={3}
              py={2}
              color="#f38ba8"
              fontSize="13.5px"
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
            <Text key={idx} alignSelf="center" fontSize="11px" color="#6c7086" px={3} py={1}>
              {group.text}
            </Text>
          )
        }

        return null
      })}

      {pending && (
        <VStack align="flex-start" w="100%" gap={0.5}>
          <Text fontSize="11px" fontWeight={500} color="#6c7086">Jarvis</Text>
          <ToolDetails records={pending.tools || []} />
          {pending.text ? (
            <Box {...assistantBubble}>
              <MarkdownText text={pending.text} />
            </Box>
          ) : (
            <Box bg="#181825" borderWidth="1px" borderColor="#313244" borderRadius="12px" px={3} py={2} fontSize="12px" color="#6c7086">
              Jarvis 思考中…
            </Box>
          )}
        </VStack>
      )}
    </VStack>
  )
}
