# Jarvis 管理员授权弹窗（非提权，仅在用户桌面显示 是/否 对话框）
# 返回值：6 = 是（授权）；7 = 否（拒绝）；-1 = 超时
param(
  [Parameter(Mandatory = $true)][string]$MessageFile
)

$ErrorActionPreference = 'Stop'

try {
  $msg = Get-Content -LiteralPath $MessageFile -Raw -Encoding UTF8
  $shell = New-Object -ComObject WScript.Shell
  # 4 = 是/否, 48 = 警告图标, 4096 = 置顶（系统模态）
  $result = $shell.Popup($msg, 300, 'Jarvis 请求管理员权限', 4 + 48 + 4096)
  exit $result
} catch {
  exit 1
}
