import React from 'react'
import { VStack, Box, Text } from '@chakra-ui/react'
import ToolDetails from './ToolDetails'
import MarkdownText from './MarkdownText'

/**
 * 把 thinking/tool 记录归到紧随其后的 assistant 消息下。
 * 这样历史消息里不会再出现"思考内容 + 正式回复"两条重复气泡。
 */
function groupMessages(messages) {
  const groups = []
  let extras = []

  for (const msg of messages) {
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

function AssistantLabel({ isBridge, adapterId }) {
  return (
    <Text fontSize="11px" fontWeight={500} color="#6c7086">
      {isBridge ? `Jarvis → 💬 ${String(adapterId || '').toUpperCase()}` : 'Jarvis'}
    </Text>
  )
}

export default function MessageList({ messages = [], isBridge = false, adapterId = null, pending = null }) {
  const groups = groupMessages(messages)

  return (
    <VStack align="flex-start" w="100%" gap={2}>
      {groups.map((group, idx) => {
        if (group.kind === 'user') {
          return (
            <VStack key={idx} align="flex-end" w="100%" gap={0.5}>
              {isBridge && (
                <Text fontSize="10px" color="#6c7086">
                  [💬 {String(adapterId || '').toLowerCase()}] {group.from || ''}
                </Text>
              )}
              <Box {...userBubble}>{group.text}</Box>
            </VStack>
          )
        }

        if (group.kind === 'assistant') {
          return (
            <VStack key={idx} align="flex-start" w="100%" gap={0.5}>
              <AssistantLabel isBridge={isBridge} adapterId={adapterId} />
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

      {/* 正在生成中的回复 */}
      {pending && (
        <VStack align="flex-start" w="100%" gap={0.5}>
          <AssistantLabel isBridge={isBridge} adapterId={adapterId} />
          <ToolDetails records={pending.tools || []} />
          {pending.text ? (
            <Box {...assistantBubble}>
              <MarkdownText text={pending.text} />
            </Box>
          ) : (
            <Box
              bg="#181825"
              borderWidth="1px"
              borderColor="#313244"
              borderRadius="12px"
              px={3}
              py={2}
              fontSize="12px"
              color="#6c7086"
            >
              Jarvis 思考中…
            </Box>
          )}
        </VStack>
      )}
    </VStack>
  )
}
