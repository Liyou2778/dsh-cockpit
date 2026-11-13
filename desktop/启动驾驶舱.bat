@echo off
rem DSH 驾驶舱 · 桌面托盘启动器
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tray.ps1"
exit /b 0
