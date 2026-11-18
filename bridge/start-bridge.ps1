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

# 启动 Bridge Server
# 注意：Start-Process 不允许 stdout 和 stderr 指向同一个文件，必须分开
$logFile = "E:\Jarvis\bridge\bridge.log"
$errFile = "E:\Jarvis\bridge\bridge.err.log"
$proc = Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
    -ArgumentList "E:\Jarvis\bridge\server.mjs" `
    -WorkingDirectory "E:\Jarvis" `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError $errFile `
    -NoNewWindow `
    -PassThru
$proc.WaitForExit()
