import React from 'react'
import { VStack, HStack, Box, Text } from '@chakra-ui/react'

export default function MessageList({ messages, isBridge = false, adapterId = null }) {
  return (
    <VStack align="flex-start" w="100%" spacing={2}>
      {messages.map((msg, idx) => {
        if (isBridge) {
          // Bridge 消息格式
          if (msg.type === 'user') {
            return (
              <VStack key={idx} align="flex-end" w="100%" spacing={0.5}>
                <Box
                  bg="#313244"
                  border="1px solid #45475a"
                  borderRadius="18px 18px 4px 18px"
                  px={3}
                  py={2}
                  maxW="72%"
                  fontSize="13.5px"
                  lineHeight={1.6}
                  whiteSpace="pre-wrap"
                  wordBreak="break-word"
                  color="#cdd6f4"
                >
                  {msg.text}
                </Box>
              </VStack>
            )
          } else if (msg.type === 'assistant') {
            return (
              <VStack key={idx} align="flex-start" w="100%" spacing={0.5}>
                <Text fontSize="11px" fontWeight={500} color="#6c7086">
                  Jarvis → {adapterId?.toUpperCase()}
                </Text>
                <Box
                  bg="#1e1e2e"
                  border="1px solid #313244"
                  borderLeftWidth="2px"
                  borderLeftColor="#89b4fa"
                  borderRadius="4px 18px 18px 18px"
                  px={3}
                  py={2}
                  maxW="72%"
                  fontSize="13.5px"
                  lineHeight={1.6}
                  whiteSpace="pre-wrap"
                  wordBreak="break-word"
                  color="#cdd6f4"
                >
                  {msg.text}
                </Box>
              </VStack>
            )
          }
        } else {
          // 普通会话消息格式
          if (msg.type === 'user') {
            return (
              <Box
                key={idx}
                alignSelf="flex-end"
                bg="#313244"
                border="1px solid #45475a"
                borderRadius="18px 18px 4px 18px"
                px={3}
                py={2}
                maxW="72%"
                fontSize="13.5px"
                lineHeight={1.6}
                whiteSpace="pre-wrap"
                wordBreak="break-word"
                color="#cdd6f4"
              >
                {msg.text}
              </Box>
            )
          } else if (msg.type === 'assistant') {
            return (
              <Box
                key={idx}
                alignSelf="flex-start"
                bg="#1e1e2e"
                border="1px solid #313244"
                borderLeftWidth="2px"
                borderLeftColor="#89b4fa"
                borderRadius="4px 18px 18px 18px"
                px={3}
                py={2}
                maxW="72%"
                fontSize="13.5px"
                lineHeight={1.6}
                whiteSpace="pre-wrap"
                wordBreak="break-word"
                color="#cdd6f4"
              >
                {msg.text}
              </Box>
            )
          } else if (msg.type === 'thinking') {
            return (
              <Box
                key={idx}
                alignSelf="flex-start"
                bg="#181825"
                border="1px solid #313244"
                borderRadius="8px"
                px={3}
                py={2}
                fontSize="12.5px"
                opacity={0.8}
                maxW="72%"
                whiteSpace="pre-wrap"
                wordBreak="break-word"
                color="#6c7086"
              >
                {msg.text}
              </Box>
            )
          } else if (msg.type === 'tool') {
            return (
              <Box
                key={idx}
                alignSelf="flex-start"
                bg="#181825"
                border="1px solid #313244"
                borderRadius="6px"
                px={2}
                py={1}
                fontSize="11px"
                fontFamily="Monaco, Courier New, monospace"
                color="#a6e3a1"
                maxW="90%"
                wordBreak="break-all"
              >
                {msg.name}({JSON.stringify(msg.input || {}).slice(0, 60)}...)
              </Box>
            )
          } else if (msg.type === 'error') {
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
                ⚠️ {msg.text}
              </Box>
            )
          }
        }
        return null
      })}
    </VStack>
  )
}
