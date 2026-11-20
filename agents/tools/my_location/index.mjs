import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { execFileSync } from 'child_process'
import { writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const server = new McpServer({ name: 'my_location', version: '1.0.0' })

// ── Windows 精确定位（若系统位置服务已开启）────────────────────────────
const PS_SCRIPT = `Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(8000) | Out-Null
    if (-not $netTask.IsCompleted) { throw "timeout" }
    $netTask.Result
}
[Windows.Devices.Geolocation.Geolocator, Windows.Devices.Geolocation, ContentType = WindowsRuntime] | Out-Null
try {
    $locator = New-Object Windows.Devices.Geolocation.Geolocator
    $pos = Await ($locator.GetGeopositionAsync()) ([Windows.Devices.Geolocation.Geoposition])
    $p = $pos.Coordinate.Point.Position
    Write-Output ("OK|" + $p.Latitude + "|" + $p.Longitude + "|" + $pos.Coordinate.Accuracy)
} catch {
    Write-Output ("FAIL|" + $_.Exception.Message)
}`

function tryWindowsGeolocation() {
  if (process.platform !== 'win32') return null
  try {
    const scriptPath = join(tmpdir(), 'jarvis_geolocate.ps1')
    if (!existsSync(scriptPath)) writeFileSync(scriptPath, PS_SCRIPT, 'utf-8')
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      encoding: 'utf8',
      timeout: 12000,
      stdio: 'pipe',
    }).trim()
    if (!out.startsWith('OK|')) return null
    const [, lat, lon, acc] = out.split('|')
    return { lat: Number(lat), lon: Number(lon), accuracy: Math.round(Number(acc)) }
  } catch {
    return null
  }
}

// ── IP 归属地定位（城市级兜底）───────────────────────────────────────
async function tryIpLocation() {
  // 源1: ip-api.com（中文，HTTP）
  try {
    const res = await fetch('http://ip-api.com/json/?lang=zh-CN&fields=status,country,regionName,city,lat,lon,isp', {
      signal: AbortSignal.timeout(8000),
    })
    const j = await res.json()
    if (j.status === 'success') {
      return { city: j.city, region: j.regionName, country: j.country, lat: j.lat, lon: j.lon, isp: j.isp, source: 'ip-api.com' }
    }
  } catch {}

  // 源2: ipwho.is（HTTPS）
  try {
    const res = await fetch('https://ipwho.is/', { signal: AbortSignal.timeout(8000) })
    const j = await res.json()
    if (j.success) {
      return { city: j.city, region: j.region, country: j.country, lat: j.latitude, lon: j.longitude, isp: null, source: 'ipwho.is' }
    }
  } catch {}

  // 源3: ipinfo.io（HTTPS）
  try {
    const res = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(8000) })
    const j = await res.json()
    if (j.city) {
      const [lat, lon] = (j.loc || ',').split(',').map(Number)
      return { city: j.city, region: j.region, country: j.country, lat, lon, isp: j.org, source: 'ipinfo.io' }
    }
  } catch {}

  return null
}

// ── 缓存（10 分钟）─────────────────────────────────────────────────
let cache = null
const CACHE_TTL = 10 * 60 * 1000

async function detectLocation(forceRefresh) {
  if (!forceRefresh && cache && Date.now() < cache.expires) return cache.value

  // 1) 先试 Windows 精确定位
  const win = tryWindowsGeolocation()
  if (win) {
    const value = {
      source: 'windows',
      precision: '精确（系统定位）',
      lat: win.lat,
      lon: win.lon,
      accuracy: win.accuracy + ' 米',
    }
    cache = { value, expires: Date.now() + CACHE_TTL }
    return value
  }

  // 2) 退回 IP 归属地
  const ip = await tryIpLocation()
  if (ip) {
    const value = {
      source: ip.source,
      precision: '城市级（IP 归属地）',
      city: ip.city,
      region: ip.region,
      country: ip.country,
      lat: ip.lat,
      lon: ip.lon,
      isp: ip.isp,
      hint: '如果需要更精确的定位（街区级），请在 Windows 设置 → 隐私和安全性 → 位置 中开启「位置服务」和「让桌面应用访问你的位置」，之后我会自动使用系统精确定位。',
    }
    cache = { value, expires: Date.now() + CACHE_TTL }
    return value
  }

  return null
}

server.tool(
  'my_location',
  '自动检测用户当前位置。优先用 Windows 系统精确定位，不可用时退回 IP 归属地（城市级）。结果缓存 10 分钟。',
  {
    forceRefresh: z.boolean().optional().describe('是否强制刷新（忽略缓存），默认 false'),
  },
  async ({ forceRefresh = false } = {}) => {
    const loc = await detectLocation(forceRefresh)
    if (!loc) {
      return { content: [{ type: 'text', text: '❌ 无法检测位置：系统定位不可用，IP 归属地查询也失败了' }] }
    }
    return { content: [{ type: 'text', text: JSON.stringify(loc, null, 2) }] }
  }
)

await server.connect(new StdioServerTransport())
