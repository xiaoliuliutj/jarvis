# 非提权入口：弹出 UAC，以管理员身份运行 setup-task.ps1 注册计划任务
# 退出码：0 = 成功；1223 = 用户取消 UAC；其他 = 失败
$ErrorActionPreference = 'Stop'

$helpersDir = $PSScriptRoot
$target = Join-Path $helpersDir 'setup-task.ps1'

if (-not (Test-Path -LiteralPath $target)) {
  Write-Error "setup-task.ps1 不存在：$target"
  exit 2
}

try {
  $p = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $target) `
    -Verb RunAs -Wait -PassThru
  exit $p.ExitCode
} catch {
  # 用户点了「否」或 UAC 被取消
  exit 1223
}
