@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instala em https://nodejs.org e corre este ficheiro outra vez.
  pause
  exit /b 1
)
node launcher\register.js
if errorlevel 1 (
  echo A instalacao falhou. Copia o erro acima e da-o ao Claude.
  pause
  exit /b 1
)
start "" wscript.exe //B "%~dp0launcher\start-server-hidden.vbs"
echo.
echo Pronto. Agora recarrega a extensao em brave://extensions e tenta de novo.
pause
