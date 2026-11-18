Set objShell = CreateObject("WScript.Shell")
jarvisDir = "E:\Jarvis"
objShell.CurrentDirectory = jarvisDir
objShell.Run "cmd /C npm run electron", 0, False
