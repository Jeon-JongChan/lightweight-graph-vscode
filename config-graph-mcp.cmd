@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\config-graph-mcp.ps1" %*
exit /b %ERRORLEVEL%
