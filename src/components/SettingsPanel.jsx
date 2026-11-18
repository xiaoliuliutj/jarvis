import React from 'react'
import { VStack, HStack, Box, Button, Text } from '@chakra-ui/react'
import { ui } from '../theme'

/**
 * 设置面板：只展示非敏感信息。
 * API Key / 微信 token / 全局 rules 不在这里展示，也不通过 UI 修改。
 */
export default function SettingsPanel({ config, onClose }) {
  return (
    <Box
      position="fixed"
      top="40px"
      right={0}
      bottom={0}
      w="300px"
      bg={ui.canvas.surface}
      borderLeftWidth={1}
      borderColor={ui.canvas.border}
      boxShadow="-8px 0 24px rgba(11, 31, 20, 0.10)"
      zIndex={100}
      overflow="auto"
    >
      <VStack align="flex-start" gap={0} h="100%">
        <HStack w="100%" px={4} py={3} justify="space-between" borderBottomWidth={1} borderColor={ui.canvas.border} flex="none">
          <Text fontWeight={600} fontSize="14px" color={ui.canvas.text}>设置</Text>
          <Button
            size="sm"
            variant="ghost"
            onClick={onClose}
            color={ui.canvas.subtext}
            _hover={{ bg: ui.canvas.surfaceMuted }}
            _focusVisible={{ outline: `2px solid ${ui.accent.base}`, outlineOffset: '2px' }}
          >✕</Button>
        </HStack>

        <VStack w="100%" flex={1} px={3} py={3} gap={4} align="flex-start">
          <VStack w="100%" gap={1} align="flex-start">
            <Text fontSize="12px" fontWeight={500} color={ui.canvas.subtext}>当前模型</Text>
            <Box w="100%" px={2} py={1.5} bg={ui.canvas.surfaceMuted} borderRadius="4px" fontSize="12px" borderWidth={1} borderColor={ui.canvas.border} color={ui.canvas.text}>
              {config?.model || '—'}
            </Box>
          </VStack>

          <Text fontSize="11px" color={ui.canvas.subtext} lineHeight={1.6}>
            权限由后端按用户角色决定。凭证和全局规则只能手动改本地文件，不通过界面展示。
          </Text>
        </VStack>
      </VStack>
    </Box>
  )
}
