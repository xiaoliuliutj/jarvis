# 以管理员身份运行：注册计划任务 JarvisAdminBridge（最高权限、按需运行）
# 注册后，任何本机用户进程都可以通过 schtasks /run 触发它（无需再弹 UAC），
# 是否执行由 Jarvis 的授权弹窗控制。
$ErrorActionPreference = 'Stop'

$taskName = 'JarvisAdminBridge'
$runner = Join-Path $PSScriptRoot 'run.ps1'

if (-not (Test-Path -LiteralPath $runner)) {
  Write-Error "run.ps1 不存在：$runner"
  exit 2
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $runner)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

$principal = New-ScheduledTaskPrincipal `
  -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) `
  -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null

exit 0
