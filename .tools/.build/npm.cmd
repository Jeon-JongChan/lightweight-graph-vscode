@echo off
setlocal

set "BUILD_DIR=%~dp0"
set "NODE_DIR=%BUILD_DIR%nodejs\node"
set "NODE_EXE=%NODE_DIR%\node.exe"
set "NPM_CLI=%NODE_DIR%\node_modules\npm\bin\npm-cli.js"

:: 1. Ensure portable Node.js is present
if not exist "%NODE_EXE%" (
    echo [npm.cmd] Portable Node.js not found. Installing...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%BUILD_DIR%nodejs.ps1" -Action install
    if errorlevel 1 (
        echo [npm.cmd] Failed to install portable Node.js.
        exit /b 1
    )
)

:: 2. Set portable isolated environment variables
set "PATH=%NODE_DIR%;%PATH%"
set "npm_config_cache=%BUILD_DIR%nodejs\npm-cache"
set "npm_config_prefix=%BUILD_DIR%nodejs\npm-global"
set "npm_config_userconfig=%BUILD_DIR%nodejs\npmrc"
set "COREPACK_HOME=%BUILD_DIR%nodejs\corepack"
set "npm_config_update_notifier=false"

:: 3. Show Build Instructions if no arguments
if "%~1"=="" goto SHOW_USAGE
if "%~1"=="help" goto SHOW_USAGE

:: 4. Run portable npm
"%NODE_EXE%" "%NPM_CLI%" %*
exit /b %ERRORLEVEL%

:SHOW_USAGE
echo ============================================================
echo  lightweight-graph-mcp Portable npm [.build]
echo ============================================================
echo Usage: .build\npm.cmd ^<command^>
echo.
echo README Build Instructions [4 Methods]:
echo   1. .build\npm.cmd install      - Install dependencies
echo   2. .build\npm.cmd run bundle   - Bundle extension and MCP server
echo   3. .build\npm.cmd test         - Run tests with jest
echo   4. .build\npm.cmd run package  - Package extension into VSIX
echo ============================================================
exit /b 0
