@echo off
title Token Monitor Stop
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8787 " ^| findstr LISTENING') do taskkill /F /PID %%p
echo Token Monitor stopped.
timeout /t 2 >nul
