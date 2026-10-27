@echo off
rem Installs the electron-tab command globally, so it works in any Electron app folder.
echo Installing electron-tab globally...
call npm install -g "%~dp0electron-tab-0.1.0.tgz"
if errorlevel 1 (
  echo.
  echo Install failed. See the error above.
  pause
  exit /b 1
)
echo.
echo Done. In any Electron app folder, run:
echo     electron-tab -- npm start
echo.
pause
