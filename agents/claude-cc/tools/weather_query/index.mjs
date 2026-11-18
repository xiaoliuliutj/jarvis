import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ProxyAgent, setGlobalDispatcher } from 'undici'
import { execSync } from 'child_process'
import { z } from 'zod'

// 自动读取 Windows 系统代理
function getSystemProxy() {
  if (process.env.HTTPS_PROXY) return process.env.HTTPS_PROXY
  if (process.env.https_proxy) return process.env.https_proxy
  if (process.platform === 'win32') {
    try {
      const out = execSync(
        'powershell -Command "(Get-ItemProperty -Path \'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\' | Where-Object { $_.ProxyEnable -eq 1 }).ProxyServer"',
        { encoding: 'utf8', timeout: 4000 }
      ).trim()
      if (out && out !== '' && !out.includes('null')) return `http://${out}`
    } catch {}
  }
  return null
}

const proxy = getSystemProxy()
if (proxy) {
  setGlobalDispatcher(new ProxyAgent(proxy))
}

const server = new McpServer({ name: 'weather_query', version: '1.0.0' })

// WMO 天气代码映射
const WMO_CODES = {
  0: '☀️ 晴天', 1: '🌤 基本晴朗', 2: '⛅ 局部多云', 3: '☁️ 阴天',
  45: '🌫 雾', 48: '🌫 冻雾',
  51: '🌦 小毛毛雨', 53: '🌦 中毛毛雨', 55: '🌧 大毛毛雨',
  56: '🌨 冻毛毛雨（小）', 57: '🌨 冻毛毛雨（大）',
  61: '🌧 小雨', 63: '🌧 中雨', 65: '🌧 大雨',
  66: '🌨 冻雨（小）', 67: '🌨 冻雨（大）',
  71: '❄️ 小雪', 73: '❄️ 中雪', 75: '❄️ 大雪', 77: '🌨 冰粒',
  80: '🌦 小阵雨', 81: '🌧 中阵雨', 82: '⛈ 大阵雨',
  85: '🌨 小阵雪', 86: '🌨 大阵雪',
  95: '⛈ 雷雨', 96: '⛈ 雷雨夹小冰雹', 99: '⛈ 雷雨夹大冰雹',
}

// 风向映射
const WIND_DIR = ['北', '北偏东', '东北', '东偏北', '东', '东偏南', '东南', '南偏东',
                   '南', '南偏西', '西南', '西偏南', '西', '西偏北', '西北', '北偏西']

function getWindDir(deg) {
  const idx = Math.round(deg / 22.5) % 16
  return WIND_DIR[idx] + '风'
}

server.tool(
  'weather_query',
  '查询指定地点的当前天气信息，支持中文地名、英文地名、城市名等',
  {
    location: z.string().describe('要查询天气的地点，支持中英文，例如：北京、上海、Tokyo、New York'),
  },
  async ({ location }) => {
    try {
      // Step 1: 地理编码，支持中英文地名
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=zh&format=json`
      const geoRes = await fetch(geoUrl)
      if (!geoRes.ok) return { content: [{ type: 'text', text: `地理编码失败：HTTP ${geoRes.status}` }] }

      const geoData = await geoRes.json()
      const place = geoData.results?.[0]
      if (!place) {
        return { content: [{ type: 'text', text: `未找到"${location}"，请检查地名是否正确` }] }
      }

      const { latitude, longitude, name, country, admin1, timezone } = place

      // Step 2: 查询天气
      const params = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current: [
          'temperature_2m', 'relative_humidity_2m', 'apparent_temperature',
          'weather_code', 'wind_speed_10m', 'wind_direction_10m',
          'surface_pressure', 'visibility', 'precipitation', 'cloud_cover',
        ].join(','),
        daily: 'temperature_2m_max,temperature_2m_min,sunrise,sunset',
        wind_speed_unit: 'kmh',
        timezone: timezone || 'auto',
        forecast_days: '1',
      })

      const weatherUrl = `https://api.open-meteo.com/v1/forecast?${params}`
      const wRes = await fetch(weatherUrl)
      if (!wRes.ok) return { content: [{ type: 'text', text: `天气查询失败：HTTP ${wRes.status}` }] }

      const w = await wRes.json()
      const c = w.current
      const d = w.daily

      const desc = WMO_CODES[c.weather_code] ?? `代码 ${c.weather_code}`
      const windDir = getWindDir(c.wind_direction_10m)
      const locationStr = [name, admin1, country].filter(Boolean).join(', ')

      const sunrise = d?.sunrise?.[0]?.slice(11) || '-'
      const sunset = d?.sunset?.[0]?.slice(11) || '-'
      const maxTemp = d?.temperature_2m_max?.[0] ?? '-'
      const minTemp = d?.temperature_2m_min?.[0] ?? '-'

      const result = `
📍 ${locationStr} 实时天气

${desc}
🌡  当前气温：${c.temperature_2m}°C（体感 ${c.apparent_temperature}°C）
📊  今日温度：${minTemp}°C ～ ${maxTemp}°C
💧  相对湿度：${c.relative_humidity_2m}%
🌧  降水量：${c.precipitation} mm
☁️  云量：${c.cloud_cover}%
🌬  风速风向：${windDir} ${c.wind_speed_10m} km/h
👁  能见度：${(c.visibility / 1000).toFixed(1)} km
🔵  气压：${c.surface_pressure} hPa
🌅  日出 / 日落：${sunrise} / ${sunset}
      `.trim()

      return { content: [{ type: 'text', text: result }] }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text: `查询出错：${msg}` }] }
    }
  }
)

await server.connect(new StdioServerTransport())
