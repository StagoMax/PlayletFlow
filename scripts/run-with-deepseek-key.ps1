$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$keyFile = Join-Path $projectRoot 'deepseekAPI.txt'
$arkKeyFile = Join-Path $projectRoot 'ApiKey.txt'
$server = Join-Path $projectRoot 'server'

if (-not (Test-Path -LiteralPath $keyFile)) {
    throw 'deepseekAPI.txt was not found in the project root.'
}

$raw = (Get-Content -LiteralPath $keyFile -Raw).Trim()
if ($raw -notmatch '^API_KEY\s*=\s*(\S+)\s*$') {
    throw 'deepseekAPI.txt must contain a single API_KEY assignment.'
}

$env:PLAYLETFLOW_LLM_API_KEY = $Matches[1]
$loadedArkKey = $false
if ([string]::IsNullOrWhiteSpace($env:ARK_API_KEY) -and (Test-Path -LiteralPath $arkKeyFile)) {
    $arkAssignments = @(Get-Content -LiteralPath $arkKeyFile | Where-Object { $_ -match '^API_KEY\s*:\s*\S+\s*$' })
    if ($arkAssignments.Count -ne 1 -or $arkAssignments[0] -notmatch '^API_KEY\s*:\s*(\S+)\s*$') {
        throw 'ApiKey.txt must contain exactly one API_KEY: assignment.'
    }
    $env:ARK_API_KEY = $Matches[1]
    $loadedArkKey = $true
}
try {
    Push-Location $server
    try {
        & cargo run --manifest-path (Join-Path $server 'Cargo.toml') -- @args
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
        Pop-Location
    }
} finally {
    Remove-Item Env:PLAYLETFLOW_LLM_API_KEY -ErrorAction SilentlyContinue
    if ($loadedArkKey) { Remove-Item Env:ARK_API_KEY -ErrorAction SilentlyContinue }
    $raw = $null
}
