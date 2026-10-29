#requires -Version 5.1
<#
.SYNOPSIS
  lightweight-graph-mcp 프로젝트를 .build 내 포터블 Node.js 환경으로 빌드하고 .vsix 패키지를 생성합니다.
.DESCRIPTION
  .build/nodejs 포터블 런타임이 없으면 자동으로 설치하고,
  npm install을 거쳐 vsce package를 통해 VS Code 확장 프로그램(.vsix)을 생성합니다.
.PARAMETER Task
  실행할 npm script 이름 (기본값: 'package' -> bundle + vsix 패키징)
  'bundle'을 지정하면 번들링(dist)만 수행합니다.
.PARAMETER Clean
  빌드 전 dist 정리 여부
.PARAMETER InstallOnly
  의존성 설치만 진행하고 빌드는 건너뛸지 여부
#>
[CmdletBinding()]
param(
  [string]$Task = 'package',
  [switch]$Clean,
  [switch]$InstallOnly
)

$ErrorActionPreference = 'Stop'

$BuildDir = $PSScriptRoot
$ProjectDir = Split-Path -Parent $BuildDir

# 1. 포터블 Node.js 설치 확인 및 자동 설치
$NodeDir = Join-Path $BuildDir 'nodejs\node'
$NodeExe = Join-Path $NodeDir 'node.exe'
if (-not (Test-Path -LiteralPath $NodeExe)) {
  Write-Host '[build] 포터블 Node.js가 감지되지 않아 설치를 진행합니다...' -ForegroundColor Cyan
  & (Join-Path $BuildDir 'nodejs.ps1') -Action install
  if (-not (Test-Path -LiteralPath $NodeExe)) {
    throw '포터블 Node.js 설치에 실패했습니다.'
  }
}

# 2. 포터블 환경변수 설정 (시스템 환경 격리)
$env:Path = "$NodeDir;$env:Path"
$env:npm_config_cache = Join-Path $BuildDir 'nodejs\npm-cache'
$env:npm_config_prefix = Join-Path $BuildDir 'nodejs\npm-global'
$env:npm_config_userconfig = Join-Path $BuildDir 'nodejs\npmrc'
$env:COREPACK_HOME = Join-Path $BuildDir 'nodejs\corepack'
$env:npm_config_update_notifier = 'false'

Push-Location $ProjectDir
try {
  # 3. Clean 플래그 처리
  if ($Clean) {
    Write-Host '[build] 이전 빌드 아티팩트 정리 중...' -ForegroundColor Yellow
    if (Test-Path 'dist') {
      Get-ChildItem -LiteralPath 'dist' -Recurse | Remove-Item -Recurse -Force
    }
    # 이전 생성된 .vsix 정리
    Get-ChildItem -Filter '*.vsix' -File | Remove-Item -Force
  }

  # 4. 의존성 설치
  if (-not (Test-Path 'node_modules')) {
    Write-Host '[build] npm 의존성을 설치합니다...' -ForegroundColor Cyan
    & cmd.exe /c "npm install"
    if ($LASTEXITCODE -ne 0) { throw "npm install 실패 (종료 코드: $LASTEXITCODE)" }
  }

  if ($InstallOnly) {
    Write-Host '[build] 의존성 설치 완료.' -ForegroundColor Green
    return
  }

  # 5. 지정된 빌드 태스크 실행 (기본값: package -> .vsix 생성)
  Write-Host "[build] npm run $Task 실행 중 (.vsix 패키징)..." -ForegroundColor Cyan
  & cmd.exe /c "npm run $Task"
  if ($LASTEXITCODE -ne 0) { throw "빌드 태스크($Task) 실패 (종료 코드: $LASTEXITCODE)" }

  $vsix = Get-ChildItem -Filter '*.vsix' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($vsix) {
    Write-Host "[build] VSIX 패키지 생성 완료: $($vsix.Name) ($([math]::Round($vsix.Length / 1KB, 2)) KB)" -ForegroundColor Green
  } else {
    Write-Host "[build] 빌드 태스크 완료: $Task" -ForegroundColor Green
  }
}
finally {
  Pop-Location
}
