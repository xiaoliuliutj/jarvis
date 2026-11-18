import React from 'react'
import { Box, Text } from '@chakra-ui/react'
import { ui, fonts } from '../theme'

/** 行内格式：**粗体**、`代码`、*斜体* */
function renderInline(text, keyPrefix = 'i') {
  const parts = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g
  let last = 0
  let match
  let i = 0

  while ((match = re.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    const token = match[0]
    const key = `${keyPrefix}-${i++}`
    if (token.startsWith('**')) {
      parts.push(
        <Box as="strong" key={key} fontWeight={600}>
          {token.slice(2, -2)}
        </Box>
      )
    } else if (token.startsWith('`')) {
      parts.push(
        <Box
          as="code"
          key={key}
          px={1}
          py="1px"
          borderRadius="4px"
          bg={ui.accent.soft}
          color={ui.accent.strong}
          fontFamily={fonts.mono}
          fontSize="13px"
        >
          {token.slice(1, -1)}
        </Box>
      )
    } else {
      parts.push(
        <Box as="em" key={key}>
          {token.slice(1, -1)}
        </Box>
      )
    }
    last = re.lastIndex
  }

  if (last < text.length) parts.push(text.slice(last))
  return parts
}

/**
 * 轻量 Markdown 渲染（不引入额外依赖）
 * 支持：标题、无序/有序列表、围栏代码块、粗体、行内代码、斜体、换行
 */
export default function MarkdownText({ text = '', color = ui.canvas.text }) {
  const source = String(text ?? '')
  const lines = source.split('\n')
  const blocks = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    // 围栏代码块
    if (/^```/.test(line.trim())) {
      const code = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        code.push(lines[i])
        i++
      }
      if (i < lines.length) i++
      blocks.push(
        <Box
          key={`b${key++}`}
          as="pre"
          my={2}
          p={3}
          bg={ui.canvas.codeBg}
          borderWidth={ui.dividerWidth}
          borderColor={ui.canvas.border}
          borderRadius="8px"
          overflowX="auto"
          fontSize="13px"
          lineHeight={1.6}
          fontFamily={fonts.mono}
          color={ui.canvas.codeText}
          whiteSpace="pre-wrap"
          wordBreak="break-word"
        >
          {code.join('\n')}
        </Box>
      )
      continue
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      blocks.push(
        <Text
          key={`b${key++}`}
          fontWeight={700}
          fontSize={level <= 2 ? '17px' : '16px'}
          color={ui.accent.base}
          mt={2}
          mb={1}
        >
          {renderInline(heading[2], `h${key}`)}
        </Text>
      )
      i++
      continue
    }

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''))
        i++
      }
      blocks.push(
        <Box key={`b${key++}`} as="ul" pl={4} my={1.5} css={{ listStyleType: 'disc' }}>
          {items.map((item, idx) => (
            <Box as="li" key={idx} fontSize="15px" lineHeight={1.7} color={color} mb="2px">
              {renderInline(item, `ul${key}-${idx}`)}
            </Box>
          ))}
        </Box>
      )
      continue
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      blocks.push(
        <Box key={`b${key++}`} as="ol" pl={4} my={1.5} css={{ listStyleType: 'decimal' }}>
          {items.map((item, idx) => (
            <Box as="li" key={idx} fontSize="15px" lineHeight={1.7} color={color} mb="2px">
              {renderInline(item, `ol${key}-${idx}`)}
            </Box>
          ))}
        </Box>
      )
      continue
    }

    // 空行
    if (!line.trim()) {
      i++
      continue
    }

    // 普通段落
    const para = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i].trim()) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i])
      i++
    }
    blocks.push(
      <Text
        key={`b${key++}`}
        fontSize="15px"
        lineHeight={1.7}
        color={color}
        whiteSpace="pre-wrap"
        wordBreak="break-word"
        my="2px"
      >
        {para.map((p, idx) => (
          <React.Fragment key={idx}>
            {idx > 0 && '\n'}
            {renderInline(p, `p${key}-${idx}`)}
          </React.Fragment>
        ))}
      </Text>
    )
  }

  return <>{blocks}</>
}
