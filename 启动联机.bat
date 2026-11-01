@echo off
chcp 65001 >nul
title Poker Duel - LAN
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 18+ is required. Download: https://nodejs.org/
  pause
  exit /b 1
)
echo Starting LAN server and opening the browser...
echo.
node "%~dp0tools\launch.js" %*
if errorlevel 1 (
  echo.
  echo [ERROR] Launch failed. See messages above.
  pause
)
