#Requires -Version 5.1
<#
.SYNOPSIS
    Lightweight Graph MCP의 Antigravity · Codex · Claude · Cursor · VS Code 전역 MCP 및 스킬 설정을 자동화한다.
#>
param(
    [ValidateSet('Setup', 'ServeMcp', 'Paths', 'Status')]
    [string]$Action = 'Setup',
    [string]$WorkspaceRoot = '',
    [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PortableNode = Join-Path $ProjectRoot '.tools\.build\nodejs\node\node.exe'
$ServerJs = Join-Path $ProjectRoot 'dist\mcp\server.js'
$LauncherCmd = Join-Path $ProjectRoot 'graph-mcp.cmd'
$SkillSourceFile = Join-Path $ProjectRoot 'skill\SKILL.md'

function Resolve-NodeExe {
    <# 확장에서 전달한 런타임을 우선하고 CLI에서는 로컬·시스템 Node.js를 찾는다. #>
    if ($NodePath) {
        if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
            throw "전달된 Node.js 런타임이 없습니다: $NodePath"
        }
        return $NodePath
    }
    if (Test-Path -LiteralPath $PortableNode) {
        return $PortableNode
    }
    $sysNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($sysNode) {
        return $sysNode.Source
    }
    $nodeScript = Join-Path $ProjectRoot '.tools\.build\nodejs.ps1'
    if (Test-Path -LiteralPath $nodeScript) {
        & $nodeScript -Action install | Out-Host
        if (Test-Path -LiteralPath $PortableNode) {
            return $PortableNode
        }
    }
    throw 'Node.js 런타임을 찾지 못했습니다. VS Code의 전역 연결 메뉴를 사용하거나 Node.js를 설치하세요.'
}

function Write-Utf8File([string]$Path, [string]$Content) {
    <# 디렉터리를 보장하고 UTF-8(BOM 없음)로 파일을 기록한다. #>
    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    [System.IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
}

function Backup-ConfigFile([string]$Path) {
    <# 기존 설정 파일을 덮어쓰기 전에 백업 사본을 남긴다. #>
    if (Test-Path -LiteralPath $Path) {
        $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
        Copy-Item -LiteralPath $Path -Destination "$Path.$stamp.bak" -Force
    }
}

function Update-JsonMcpConfig([string]$ConfigPath, [string]$ServerKey, [string]$CommandPath, [string[]]$CommandArgs, [switch]$IncludeVsCodeType) {
    <# JSON 기반 MCP 설정(Antigravity, Claude, Cursor, VS Code)에 lightweight-graph-mcp 항목을 병합한다. #>
    $rootObj = @{}
    if (Test-Path -LiteralPath $ConfigPath) {
        $raw = [System.IO.File]::ReadAllText($ConfigPath, $Utf8NoBom).Trim()
        if ($raw) {
            try {
                $parsed = ConvertFrom-Json $raw
                foreach ($prop in $parsed.PSObject.Properties) {
                    $rootObj[$prop.Name] = $prop.Value
                }
            } catch {
                throw "기존 JSON 설정을 해석하지 못해 파일을 유지합니다: $ConfigPath"
            }
        }
    }

    $servers = @{}
    if ($rootObj.ContainsKey($ServerKey) -and $null -ne $rootObj[$ServerKey]) {
        foreach ($prop in $rootObj[$ServerKey].PSObject.Properties) {
            $servers[$prop.Name] = $prop.Value
        }
    }

    $entry = [ordered]@{}
    if ($IncludeVsCodeType) {
        $entry['type'] = 'stdio'
    }
    $entry['command'] = $CommandPath
    $entry['args'] = $CommandArgs
    $runtimeEnv = @{}
    if ($servers.ContainsKey('lightweight-graph-mcp') -and $servers['lightweight-graph-mcp'].env) {
        foreach ($prop in $servers['lightweight-graph-mcp'].env.PSObject.Properties) {
            $runtimeEnv[$prop.Name] = $prop.Value
        }
    }
    $runtimeEnv['ELECTRON_RUN_AS_NODE'] = '1'
    $entry['env'] = [pscustomobject]$runtimeEnv
    $servers['lightweight-graph-mcp'] = [pscustomobject]$entry
    $rootObj[$ServerKey] = [pscustomobject]$servers

    if (Test-Path -LiteralPath $ConfigPath) {
        Backup-ConfigFile -Path $ConfigPath
    }
    $json = ([pscustomobject]$rootObj) | ConvertTo-Json -Depth 20
    Write-Utf8File -Path $ConfigPath -Content ($json + "`r`n")
}

function Update-CodexConfig([string]$ConfigPath, [string]$CommandPath, [string[]]$CommandArgs) {
    <# Codex config.toml의 [mcp_servers.lightweight-graph-mcp] 섹션을 추가하거나 갱신한다. #>
    $escapedCmd = $CommandPath.Replace('\', '\\')
    $escapedArgs = ($CommandArgs | ForEach-Object { '"' + $_.Replace('\', '\\') + '"' }) -join ', '
    $block = @(
        '[mcp_servers.lightweight-graph-mcp]',
        "command = `"$escapedCmd`"",
        "args = [$escapedArgs]",
        'startup_timeout_sec = 30'
    ) -join "`r`n"

    $existing = ''
    if (Test-Path -LiteralPath $ConfigPath) {
        Backup-ConfigFile -Path $ConfigPath
        $existing = [System.IO.File]::ReadAllText($ConfigPath, $Utf8NoBom)
    }

    # 기존 환경변수 하위 테이블을 보존하고 Electron 실행 모드만 갱신한다.
    $envPattern = '(?ms)^\[mcp_servers\.lightweight-graph-mcp\.env\]\r?\n.*?(?=^\[|\z)'
    $envMatch = [regex]::Match($existing, $envPattern)
    if ($envMatch.Success) {
        $envKeyPattern = '(?m)^ELECTRON_RUN_AS_NODE\s*=.*$'
        $envBlock = if ($envMatch.Value -match $envKeyPattern) {
            [regex]::Replace($envMatch.Value, $envKeyPattern, 'ELECTRON_RUN_AS_NODE = "1"')
        } else {
            $envMatch.Value.Replace('[mcp_servers.lightweight-graph-mcp.env]', "[mcp_servers.lightweight-graph-mcp.env]`r`nELECTRON_RUN_AS_NODE = `"1`"")
        }
        $existing = $existing.Replace($envMatch.Value, $envBlock)
    } else {
        $block += "`r`nenv = { ELECTRON_RUN_AS_NODE = `"1`" }"
    }

    $pattern = '(?ms)^\[mcp_servers\.lightweight-graph-mcp\]\r?\n.*?(?=^\[|\z)'
    if ($existing -match $pattern) {
        $updated = $existing.Replace([regex]::Match($existing, $pattern).Value, $block + "`r`n`r`n")
    } else {
        $trimmed = $existing.TrimEnd()
        $updated = if ($trimmed) { $trimmed + "`r`n`r`n" + $block + "`r`n" } else { $block + "`r`n" }
    }
    Write-Utf8File -Path $ConfigPath -Content $updated
}

function Install-SkillLinks {
    <# Antigravity, Codex, Agents, Claude, Cursor 스킬 디렉터리에 SKILL.md를 배포한다. #>
    $skillContent = [System.IO.File]::ReadAllText($SkillSourceFile, $Utf8NoBom)
    $targets = @(
        (Join-Path $HOME '.gemini\config\skills\lightweight-graph-mcp\SKILL.md'),
        (Join-Path $HOME '.gemini\skills\lightweight-graph-mcp\SKILL.md'),
        (Join-Path $HOME '.codex\skills\lightweight-graph-mcp\SKILL.md'),
        (Join-Path $HOME '.agents\skills\lightweight-graph-mcp\SKILL.md'),
        (Join-Path $HOME '.cursor\skills\lightweight-graph-mcp\SKILL.md'),
        (Join-Path $HOME '.claude\skills\lightweight-graph-mcp\SKILL.md')
    )
    foreach ($target in $targets) {
        Write-Utf8File -Path $target -Content $skillContent
    }
    return $targets
}

$nodeExe = Resolve-NodeExe

switch ($Action) {
    'ServeMcp' {
        $targetRoot = if ($WorkspaceRoot) { $WorkspaceRoot } else { (Get-Location).Path }
        & $nodeExe $ServerJs $targetRoot
        exit $LASTEXITCODE
    }
    'Paths' {
        [pscustomobject]@{
            ProjectRoot = $ProjectRoot
            NodeExe = $nodeExe
            ServerJs = $ServerJs
            LauncherCmd = $LauncherCmd
            SkillFile = $SkillSourceFile
            AntigravityMcpConfig = (Join-Path $HOME '.gemini\config\mcp_config.json')
            CodexConfig = (Join-Path $HOME '.codex\config.toml')
        } | ConvertTo-Json -Depth 5
        exit 0
    }
    'Status' {
        $agConfig = Join-Path $HOME '.gemini\config\mcp_config.json'
        $codexConfig = Join-Path $HOME '.codex\config.toml'
        $agSkill = Join-Path $HOME '.gemini\config\skills\lightweight-graph-mcp\SKILL.md'
        $codexSkill = Join-Path $HOME '.codex\skills\lightweight-graph-mcp\SKILL.md'
        [pscustomobject]@{
            NodeReady = (Test-Path -LiteralPath $nodeExe)
            BundleReady = (Test-Path -LiteralPath $ServerJs)
            AntigravityMcpRegistered = (Test-Path -LiteralPath $agConfig) -and ([System.IO.File]::ReadAllText($agConfig) -match 'lightweight-graph-mcp')
            CodexMcpRegistered = (Test-Path -LiteralPath $codexConfig) -and ([System.IO.File]::ReadAllText($codexConfig) -match 'lightweight-graph-mcp')
            AntigravitySkillInstalled = (Test-Path -LiteralPath $agSkill)
            CodexSkillInstalled = (Test-Path -LiteralPath $codexSkill)
        } | ConvertTo-Json -Depth 5
        exit 0
    }
    'Setup' {
        if (-not (Test-Path -LiteralPath $ServerJs)) {
            Push-Location $ProjectRoot
            try {
                & (Join-Path $ProjectRoot '.tools\.build\npm.cmd') run bundle | Out-Host
            } finally {
                Pop-Location
            }
        }

        $mcpArgs = @($ServerJs)
        $jsonTargets = @(
            @{ Path = (Join-Path $HOME '.gemini\config\mcp_config.json'); Key = 'mcpServers'; VsCode = $false },
            @{ Path = (Join-Path $HOME '.gemini\settings.json'); Key = 'mcpServers'; VsCode = $false },
            @{ Path = (Join-Path $HOME '.cursor\mcp.json'); Key = 'mcpServers'; VsCode = $false },
            @{ Path = (Join-Path $HOME '.claude.json'); Key = 'mcpServers'; VsCode = $false },
            @{ Path = (Join-Path $env:APPDATA 'Code\User\mcp.json'); Key = 'servers'; VsCode = $true }
        )

        foreach ($t in $jsonTargets) {
            Update-JsonMcpConfig -ConfigPath $t.Path -ServerKey $t.Key -CommandPath $nodeExe -CommandArgs $mcpArgs -IncludeVsCodeType:([bool]$t.VsCode)
        }

        $codexPath = Join-Path $HOME '.codex\config.toml'
        Update-CodexConfig -ConfigPath $codexPath -CommandPath $nodeExe -CommandArgs $mcpArgs
        $installedSkills = Install-SkillLinks

        [pscustomobject]@{
            status = 'Configured'
            nodeExe = $nodeExe
            serverJs = $ServerJs
            launcherCmd = $LauncherCmd
            configuredMcpFiles = ($jsonTargets | ForEach-Object { $_.Path }) + @($codexPath)
            installedSkills = $installedSkills
        } | ConvertTo-Json -Depth 5
        exit 0
    }
}
