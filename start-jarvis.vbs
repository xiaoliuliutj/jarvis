Set objShell = CreateObject("WScript.Shell")
jarvisDir = "E:\Jarvis"
objShell.CurrentDirectory = jarvisDir
objShell.Run "cmd /C npm run dev", 0, False
