@echo off
title Token Monitor (close this window = stop server)
rem run from this file's own folder (no hard-coded path, works after git clone anywhere)
cd /d "%~dp0"
rem stop any old instance on port 8787 first
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8787 " ^| findstr LISTENING') do taskkill /F /PID %%p >nul 2>&1
start "" http://localhost:8787
node --expose-gc --max-semi-space-size=1 --optimize-for-size --jitless server.js
if errorlevel 1 pause
