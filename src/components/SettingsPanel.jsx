import React from 'react'
import { VStack, HStack, Box, Button, Text } from '@chakra-ui/react'

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
      bg="#181825"
      borderLeftWidth={1}
      borderColor="#313244"
      boxShadow="-2px 0 8px rgba(0,0,0,0.3)"
      zIndex={100}
      overflow="auto"
    >
      <VStack align="flex-start" gap={0} h="100%">
        <HStack w="100%" px={4} py={3} justify="space-between" borderBottomWidth={1} borderColor="#313244" flex="none">
          <Text fontWeight={600} fontSize="14px" color="#cdd6f4">设置</Text>
          <Button size="sm" variant="ghost" onClick={onClose} color="#cdd6f4" _hover={{ bg: '#1a1a22' }}>✕</Button>
        </HStack>

        <VStack w="100%" flex={1} px={3} py={3} gap={4} align="flex-start">
          <VStack w="100%" gap={1} align="flex-start">
            <Text fontSize="12px" fontWeight={500} color="#6c7086">当前模型</Text>
            <Box w="100%" px={2} py={1.5} bg="#1a1a22" borderRadius="4px" fontSize="12px" borderWidth={1} borderColor="#313244" color="#cdd6f4">
              {config?.model || '—'}
            </Box>
          </VStack>

          <Text fontSize="11px" color="#6c7086" lineHeight={1.6}>
            权限由后端按用户角色决定。凭证和全局规则只能手动改本地文件，不通过界面展示。
          </Text>
        </VStack>
      </VStack>
    </Box>
  )
}
