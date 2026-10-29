@echo off
if exist "%~dp0.tools\.build\nodejs\node\node.exe" ("%~dp0.tools\.build\nodejs\node\node.exe" "%~dp0dist\mcp\server.js" %*) else (node "%~dp0dist\mcp\server.js" %*)
