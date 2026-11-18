import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import sevenZip from '7zip-min'

const server = new McpServer({ name: 'unzip_file', version: '2.0.0' })

server.tool(
  'unzip_file',
  '解压压缩文件到指定目录，支持 zip、rar、7z 等格式',
  {
    archivePath: z.string().describe('压缩文件的完整路径（支持 .zip .rar .7z .tar.gz 等）'),
    targetDir:   z.string().describe('目标解压目录的完整路径（不存在会自动创建）'),
  },
  async ({ archivePath, targetDir }) => {
    if (!fs.existsSync(archivePath)) {
      return { content: [{ type: 'text', text: `❌ 文件不存在：${archivePath}` }] }
    }

    fs.mkdirSync(targetDir, { recursive: true })

    try {
      await new Promise((resolve, reject) => {
        sevenZip.unpack(archivePath, targetDir, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })

      let count = 0
      const countFiles = (dir) => {
        for (const f of fs.readdirSync(dir)) {
          const full = path.join(dir, f)
          if (fs.statSync(full).isDirectory()) countFiles(full)
          else count++
        }
      }
      countFiles(targetDir)

      const ext = path.extname(archivePath).toLowerCase()
      return { content: [{ type: 'text', text: `✅ 解压成功\n格式：${ext}\n来源：${archivePath}\n目标：${targetDir}\n文件数：${count} 个` }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ 解压失败：${err.message}` }] }
    }
  }
)

await server.connect(new StdioServerTransport())
