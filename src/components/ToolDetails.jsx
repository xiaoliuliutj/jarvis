import React from 'react'
import { Box, Text } from '@chakra-ui/react'
import { ui, fonts } from '../theme'

function preview(input) {
  let str = ''
  try {
    str = JSON.stringify(input ?? {})
  } catch {
    str = String(input ?? '')
  }
  return str.length > 90 ? str.slice(0, 90) + '…' : str
}

/**
 * 工具调用 / 思考过程折叠块
 * records: [{ type: 'tool', name, input }, { type: 'thinking', text }]
 *
 * 注意：必须按 records 原顺序渲染。不要先 filter 出 tools 再渲染 thinking，
 * 否则工具调用和中间思考会被拆成“先工具、后文本”，丢失真实执行顺序。
 */
export default function ToolDetails({ records = [] }) {
  const tools = records.filter(r => r.type === 'tool')
  const thinking = records.filter(r => r.type === 'thinking')
  if (tools.length === 0 && thinking.length === 0) return null

  const summaryText = [
    tools.length > 0 ? `${tools.length} 个工具调用` : null,
    thinking.length > 0 ? '思考' : null,
  ].filter(Boolean).join(' · ')

  return (
    <Box
      as="details"
      mt={1}
      mb={1}
      borderWidth={ui.dividerWidth}
      borderColor={ui.canvas.border}
      borderRadius="8px"
      bg={ui.canvas.surfaceMuted}
      px={3}
      py={2}
      fontSize="12px"
      color={ui.canvas.muted}
      maxW="90%"
    >
      <Box as="summary" cursor="pointer" userSelect="none" _hover={{ color: ui.accent.base }}>
        {summaryText}
      </Box>
      <Box mt={2} display="flex" flexDirection="column" gap={2}>
        {records.map((record, idx) => {
          if (record.type === 'tool') {
            return (
              <Box
                key={`tool-${idx}`}
                fontFamily={fonts.mono}
                fontSize="12px"
                color={ui.canvas.codeText}
                whiteSpace="pre-wrap"
                wordBreak="break-all"
              >
                {record.name}({preview(record.input)})
              </Box>
            )
          }

          if (record.type === 'thinking') {
            return (
              <Text
                key={`thinking-${idx}`}
                fontSize="12px"
                lineHeight={1.7}
                color={ui.canvas.muted}
                whiteSpace="pre-wrap"
                wordBreak="break-word"
              >
                {record.text}
              </Text>
            )
          }

          return null
        })}
      </Box>
    </Box>
  )
}
