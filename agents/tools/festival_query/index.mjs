import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'festival_query', version: '1.0.0' })

// 查询的主要国家/地区（Nager.Date 公共假日）
const COUNTRIES = ['CN', 'US', 'GB', 'JP', 'KR', 'DE', 'FR', 'IT', 'ES', 'RU', 'IN', 'BR', 'CA', 'AU', 'SG', 'TH', 'VN', 'MX', 'TR', 'ZA']

// 内存缓存：`${year}-${code}` -> 假日数组
const cache = new Map()

async function fetchCountryHolidays(year, code) {
  const key = `${year}-${code}`
  if (cache.has(key)) return cache.get(key)
  try {
    const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${code}`, {
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return []
    const data = await res.json()
    const list = Array.isArray(data) ? data : []
    cache.set(key, list)
    return list
  } catch {
    return []
  }
}

// 常见国际节日/纪念日（固定日期，不在公共假日数据里的）
const OBSERVANCES = {
  '02-14': '情人节',
  '03-08': '国际妇女节',
  '03-14': '白色情人节',
  '03-15': '国际消费者权益日',
  '03-22': '世界水日',
  '04-01': '愚人节',
  '04-22': '世界地球日',
  '04-23': '世界读书日',
  '05-04': '五四青年节',
  '05-31': '世界无烟日',
  '06-05': '世界环境日',
  '08-12': '国际青年日',
  '09-10': '教师节',
  '09-21': '国际和平日',
  '10-16': '世界粮食日',
  '10-31': '万圣节',
  '11-11': '双十一购物节',
  '11-19': '世界厕所日',
  '12-01': '世界艾滋病日',
  '12-05': '国际志愿人员日',
  '12-24': '平安夜',
  '12-31': '跨年夜',
}

// 某月第 n 个周日是几号（用于母亲节/父亲节）
function nthSundayOfMonth(year, month, n) {
  let count = 0
  for (let day = 1; day <= 31; day++) {
    const cur = new Date(Date.UTC(year, month - 1, day))
    if (cur.getUTCMonth() !== month - 1) break
    if (cur.getUTCDay() === 0) {
      count++
      if (count === n) return day
    }
  }
  return -1
}

server.tool(
  'festival_query',
  '查询某一天世界各地的节日和纪念日（中国及 20 个主要国家的公共假日 + 常见国际节日/纪念日）。',
  {
    date: z.string().optional().describe('查询日期，格式 YYYY-MM-DD，不填默认今天'),
  },
  async ({ date }) => {
    const target = date ? new Date(date) : new Date()
    if (isNaN(target.getTime())) {
      return { content: [{ type: 'text', text: '❌ 日期格式错误，请使用 YYYY-MM-DD 格式' }] }
    }
    const yyyy = target.getFullYear()
    const mm = String(target.getMonth() + 1).padStart(2, '0')
    const dd = String(target.getDate()).padStart(2, '0')
    const dateStr = `${yyyy}-${mm}-${dd}`
    const weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

    // 并行拉取各国公共假日
    const results = await Promise.all(COUNTRIES.map(code => fetchCountryHolidays(yyyy, code)))

    // 收集当天的节日，按英文名去重，记录出现国家
    const map = new Map()
    results.forEach((list, i) => {
      const code = COUNTRIES[i]
      for (const h of list) {
        if (h.date !== dateStr) continue
        const key = h.name
        if (!map.has(key)) {
          map.set(key, { name: h.name, localName: h.localName, countries: new Set() })
        }
        map.get(key).countries.add(code)
      }
    })

    const publicHolidays = [...map.values()].map(h => ({
      name: h.name,
      localName: h.localName,
      countries: [...h.countries],
    }))

    // 常见国际节日/纪念日
    const observances = []
    const mmdd = `${mm}-${dd}`
    if (OBSERVANCES[mmdd]) observances.push(OBSERVANCES[mmdd])
    if (mm === '05' && Number(dd) === nthSundayOfMonth(yyyy, 5, 2)) observances.push('母亲节')
    if (mm === '06' && Number(dd) === nthSundayOfMonth(yyyy, 6, 3)) observances.push('父亲节')

    const result = {
      date: dateStr,
      weekday: weekNames[target.getDay()],
      publicHolidays,
      observances,
      note: publicHolidays.length === 0 && observances.length === 0
        ? '今天没有查到的节日或纪念日'
        : `共 ${publicHolidays.length} 个公共假日、${observances.length} 个国际纪念日`,
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

await server.connect(new StdioServerTransport())
