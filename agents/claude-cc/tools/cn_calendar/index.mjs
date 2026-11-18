import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'cn_calendar', version: '1.0.0' })

server.tool(
  'cn_calendar',
  '查询某天的中国法定日历信息：是否工作日、是否调休、节假日名称等。数据来源 NateScarlet/holiday-cn，包含调休安排。',
  {
    date: z.string().optional().describe('查询日期，格式 YYYY-MM-DD，不填默认今天'),
  },
  async ({ date }) => {
    // 确定查询日期
    const target = date ? new Date(date) : new Date()
    const yyyy = target.getFullYear()
    const mm = String(target.getMonth() + 1).padStart(2, '0')
    const dd = String(target.getDate()).padStart(2, '0')
    const dateStr = `${yyyy}-${mm}-${dd}`
    const weekday = target.getDay() // 0=周日, 6=周六

    // 拉取当年节假日数据
    const url = `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${yyyy}.json`
    let days = []
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      days = json.days || []
    } catch (e) {
      return { content: [{ type: 'text', text: `❌ 获取节假日数据失败：${e.message}\n数据源：${url}` }] }
    }

    // 在 days 中查找该日期
    const record = days.find(d => d.date === dateStr)

    let dayType, isWorkday, isMakeupWork, holidayName, summary

    if (record) {
      holidayName = record.name
      if (record.isOffDay) {
        // 法定假日休息
        dayType = 'holiday'
        isWorkday = false
        isMakeupWork = false
        summary = `【法定假日】${holidayName}，休息日`
      } else {
        // 调休上班（原本是周末，但要上班）
        dayType = 'makeup_workday'
        isWorkday = true
        isMakeupWork = true
        summary = `【调休上班】${holidayName}假期前/后调休，今天需要上班`
      }
    } else {
      // 普通日期，看是否周末
      holidayName = null
      isMakeupWork = false
      if (weekday === 0 || weekday === 6) {
        dayType = 'normal_weekend'
        isWorkday = false
        summary = `【普通周末】正常休息日`
      } else {
        dayType = 'normal_workday'
        isWorkday = true
        summary = `【普通工作日】正常上班`
      }
    }

    const weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    const result = {
      date: dateStr,
      weekday: weekNames[weekday],
      isWorkday,
      isMakeupWork,
      dayType,
      holidayName,
      summary,
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

await server.connect(new StdioServerTransport())
