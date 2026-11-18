# Bridge Server 启动脚本（供 Task Scheduler 调用）
# 清除 CLAUDECODE 环境变量
$env:CLAUDECODE = $null

# 切到 Jarvis 目录
Set-Location "E:\Jarvis"

# 等待网络就绪（最多 30 秒）
$maxWait = 30
$waited = 0
while ($waited -lt $maxWait) {
    try {
        $null = [System.Net.Dns]::GetHostEntry("ilinkai.weixin.qq.com")
        break
    } catch {
        Start-Sleep -Seconds 2
        $waited += 2
    }
}

# 已有实例在运行则不重复启动
$existing = Get-NetTCPConnection -LocalPort 7779 -State Listen -ErrorAction SilentlyContinue
if ($existing) { exit 0 }

# 启动 Bridge Server
# 注意：
#   1. Start-Process 不允许 stdout 和 stderr 指向同一个文件，必须分开
#   2. 使用独立隐藏窗口（不要 -NoNewWindow），避免计划任务/父控制台退出时
#      把 Bridge 一起 Ctrl+C 杀掉
$logFile = "E:\Jarvis\bridge\bridge.log"
$errFile = "E:\Jarvis\bridge\bridge.err.log"
try {
    Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
        -ArgumentList "E:\Jarvis\bridge\server.mjs" `
        -WorkingDirectory "E:\Jarvis" `
        -RedirectStandardOutput $logFile `
        -RedirectStandardError $errFile `
        -WindowStyle Hidden | Out-Null
} catch {
    $_ | Out-String | Out-File $errFile -Append -Encoding utf8
    exit 1
}
