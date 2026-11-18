import React from 'react'
import {
  VStack,
  HStack,
  Box,
  Button,
  Text,
  Select,
} from '@chakra-ui/react'

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
      <VStack align="flex-start" spacing={0} h="100%">
        {/* 标题栏 */}
        <HStack w="100%" px={4} py={3} justify="space-between" borderBottomWidth={1} borderColor="#313244" flex="none">
          <Text fontWeight={600} fontSize="14px" color="#cdd6f4">
            设置
          </Text>
          <Button size="sm" variant="ghost" onClick={onClose} color="#cdd6f4" _hover={{ bg: '#1a1a22' }}>
            ✕
          </Button>
        </HStack>

        {/* 内容 */}
        <VStack w="100%" flex={1} px={3} py={3} spacing={4} align="flex-start" overflow="auto">
          {config && (
            <>
              <VStack w="100%" spacing={1} align="flex-start">
                <Text fontSize="12px" fontWeight={500} color="#6c7086">
                  当前模型
                </Text>
                <Box
                  w="100%"
                  px={2}
                  py={1.5}
                  bg="#1a1a22"
                  borderRadius="4px"
                  fontSize="12px"
                  borderWidth={1}
                  borderColor="#313244"
                  color="#cdd6f4"
                >
                  {config.model || 'claude-sonnet-5-5'}
                </Box>
              </VStack>

              <VStack w="100%" spacing={1} align="flex-start">
                <Text fontSize="12px" fontWeight={500} color="#6c7086">
                  权限模式
                </Text>
                <Select fontSize="12px" borderRadius="4px" defaultValue="rulesOnly" bg="#1a1a22" color="#cdd6f4" borderColor="#313244">
                  <option value="rulesOnly">规则模式</option>
                  <option value="full">完全访问</option>
                </Select>
              </VStack>
            </>
          )}
        </VStack>
      </VStack>
    </Box>
  )
}
