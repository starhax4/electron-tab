@echo off
rem Installs the electron2web command globally, so it works in any Electron app folder.
echo Installing electron2web globally...
call npm install -g "%~dp0electron2web-0.1.0-beta.2.tgz"
if errorlevel 1 (
  echo.
  echo Install failed. See the error above.
  pause
  exit /b 1
)
echo.
echo Done. In any Electron app folder, run:
echo     electron2web -- npm start
echo.
pause
