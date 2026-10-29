param([string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$source = Join-Path $ProjectRoot 'tools/config-graph-mcp.ps1'
$parseTokens = $null
$parseErrors = $null
$tree = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw '설정 스크립트 문법 오류' }
# 스크립트의 Setup 본문은 실행하지 않고 검사 대상 함수 정의만 로드한다.
foreach ($function in $tree.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($function.Extent.Text))
}
$directory = Join-Path $PSScriptRoot ('config-safety-' + [guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($directory) | Out-Null
$target = Join-Path $directory 'invalid.json'
$original = '{ invalid existing configuration'
[System.IO.File]::WriteAllText($target, $original, $Utf8NoBom)
$rejected = $false
try { Update-JsonMcpConfig -ConfigPath $target -ServerKey 'mcpServers' -CommandPath 'node.exe' -CommandArgs @('server.js') }
catch { $rejected = $true }
if (-not $rejected -or [System.IO.File]::ReadAllText($target) -cne $original) { throw '잘못된 기존 JSON을 덮어썼거나 오류를 전달하지 않았다.' }
Write-Output "통과: 잘못된 전역 설정 보존 및 오류 전달, $directory"
