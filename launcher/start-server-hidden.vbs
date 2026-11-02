Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\josepires\Documents\Projetos\UniversalDownloader"
sh.Run """C:\Program Files\nodejs\node.exe"" ""C:\Users\josepires\Documents\Projetos\UniversalDownloader\server.js""", 0, False
