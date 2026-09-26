$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$keyFile = Join-Path $projectRoot 'deepseekAPI.txt'
$server = Join-Path $projectRoot 'server'

if (-not (Test-Path -LiteralPath $keyFile)) {
    throw 'deepseekAPI.txt was not found in the project root.'
}

$raw = (Get-Content -LiteralPath $keyFile -Raw).Trim()
if ($raw -notmatch '^API_KEY\s*=\s*(\S+)\s*$') {
    throw 'deepseekAPI.txt must contain a single API_KEY assignment.'
}

$env:PLAYLETFLOW_LLM_API_KEY = $Matches[1]
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
    $raw = $null
}
