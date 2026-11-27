# 以管理员权限由计划任务 JarvisAdminBridge 执行
# 读取 userdata\admin-bridge\request.json，执行其中的命令脚本，
# 把结果写入 result-<id>.json，并追加审计日志。
$ErrorActionPreference = 'Stop'

# 由脚本位置推导 Jarvis 根目录：<root>\agents\tools\admin_request\scripts\run.ps1
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
$dir = Join-Path $root 'userdata\admin-bridge'

function ExitWith($code) { exit $code }

if (-not (Test-Path -LiteralPath $dir)) { ExitWith 2 }
$reqPath = Join-Path $dir 'request.json'
if (-not (Test-Path -LiteralPath $reqPath)) { ExitWith 2 }

$req = Get-Content -LiteralPath $reqPath -Raw -Encoding UTF8 | ConvertFrom-Json
$id = [string]$req.id
if (-not $id) { ExitWith 3 }

# 防止重复执行同一个请求
$lastIdFile = Join-Path $dir 'last-run-id.txt'
if (Test-Path -LiteralPath $lastIdFile) {
  $lastId = ''
  try { $lastId = (Get-Content -LiteralPath $lastIdFile -Raw -Encoding UTF8).Trim() } catch {}
  if ($lastId -eq $id) { ExitWith 0 }
}

$cmdFile = [string]$req.commandFile
if (-not $cmdFile -or -not (Test-Path -LiteralPath $cmdFile)) { ExitWith 4 }

$timeoutSec = 120
if ($req.timeoutSec) { $timeoutSec = [int]$req.timeoutSec }
if ($timeoutSec -lt 10) { $timeoutSec = 10 }
if ($timeoutSec -gt 1800) { $timeoutSec = 1800 }

$workDir = 'C:\Windows\System32'
if ($req.workDir -and (Test-Path -LiteralPath ([string]$req.workDir))) { $workDir = [string]$req.workDir }

$resultPath = Join-Path $dir ('result-' + $id + '.json')
$startedAt = Get-Date

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'powershell.exe'
$psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $cmdFile + '"'
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$psi.WorkingDirectory = $workDir
try {
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
} catch {}

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
[void]$proc.Start()

$outTask = $proc.StandardOutput.ReadToEndAsync()
$errTask = $proc.StandardError.ReadToEndAsync()

$timedOut = $false
if (-not $proc.WaitForExit($timeoutSec * 1000)) {
  $timedOut = $true
  try { $proc.Kill() } catch {}
  Start-Sleep -Milliseconds 500
}

$stdout = ''
$stderr = ''
try { $stdout = $outTask.Result } catch {}
try { $stderr = $errTask.Result } catch {}

$code = -1
try { $code = [int]$proc.ExitCode } catch {}

$finishedAt = Get-Date
$durationMs = [int]($finishedAt - $startedAt).TotalMilliseconds

$result = [ordered]@{
  id        = $id
  ok        = ($code -eq 0 -and -not $timedOut)
  exitCode  = $code
  timedOut  = $timedOut
  durationMs = $durationMs
  stdout    = $stdout
  stderr    = $stderr
  startedAt = $startedAt.ToString('o')
  finishedAt = $finishedAt.ToString('o')
}

$json = $result | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($resultPath, $json, (New-Object System.Text.UTF8Encoding($false)))

Set-Content -LiteralPath $lastIdFile -Value $id -Encoding ASCII

$auditLine = ('{0} | id={1} | exit={2} | timeout={3} | {4}' -f $finishedAt.ToString('s'), $id, $code, $timedOut, [string]$req.summary)
Add-Content -LiteralPath (Join-Path $dir 'audit.log') -Value $auditLine -Encoding UTF8

exit 0
