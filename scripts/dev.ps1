[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'restart', 'status', 'run')]
    [string]$Command = 'start',

    [ValidateRange(1, 120)]
    [int]$StartupTimeoutSeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = Join-Path $projectRoot '.videoflow\dev'
$supervisorPidFile = Join-Path $runtimeDirectory 'supervisor.pid'
$supervisorStatusFile = Join-Path $runtimeDirectory 'status.json'
$stopRequestFile = Join-Path $runtimeDirectory 'stop.request'
$lockFile = Join-Path $runtimeDirectory 'supervisor.lock'
$supervisorLog = Join-Path $runtimeDirectory 'supervisor.log'
$supervisorStdoutLog = Join-Path $runtimeDirectory 'supervisor.stdout.log'
$supervisorStderrLog = Join-Path $runtimeDirectory 'supervisor.stderr.log'

function Initialize-RuntimeDirectory {
    if (-not (Test-Path -LiteralPath $runtimeDirectory)) {
        New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
    }
}

function Get-RecordedSupervisorPid {
    if (-not (Test-Path -LiteralPath $supervisorPidFile)) {
        return $null
    }

    $recordedPid = 0
    $rawPid = (Get-Content -LiteralPath $supervisorPidFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ([int]::TryParse($rawPid, [ref]$recordedPid)) {
        return $recordedPid
    }

    return $null
}

function Test-ProcessIsAlive {
    param([AllowNull()][int]$ProcessId)

    if (-not $ProcessId) {
        return $false
    }

    return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Test-SupervisorIsAlive {
    param([AllowNull()][int]$ProcessId)

    if (-not (Test-ProcessIsAlive -ProcessId $ProcessId)) {
        return $false
    }

    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if (-not $process -or -not $process.CommandLine) {
        return $false
    }

    $escapedScriptPath = [regex]::Escape($PSCommandPath)
    return $process.CommandLine -match $escapedScriptPath -and $process.CommandLine -match '(?i)-Command\s+run(?:\s|$)'
}

function Test-TcpPort {
    param(
        [string]$HostName = '127.0.0.1',
        [Parameter(Mandatory)][int]$Port,
        [int]$TimeoutMilliseconds = 250
    )

    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connection = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $connection.AsyncWaitHandle.WaitOne($TimeoutMilliseconds)) {
            return $false
        }

        $client.EndConnect($connection)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Get-CurrentPowerShellPath {
    $currentProcess = Get-Process -Id $PID
    if ($currentProcess.Path) {
        return $currentProcess.Path
    }

    $pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    if ($pwsh) {
        return $pwsh.Source
    }

    return (Get-Command powershell.exe -ErrorAction Stop).Source
}

function Write-SupervisorLog {
    param([Parameter(Mandatory)][string]$Message)

    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Message
    Add-Content -LiteralPath $supervisorLog -Value $line -Encoding utf8
    Write-Output $line
}

function Get-ProcessTreeIds {
    param([Parameter(Mandatory)][int]$RootProcessId)

    $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Select-Object ProcessId, ParentProcessId, CreationDate)
    $root = $processes | Where-Object { $_.ProcessId -eq $RootProcessId } | Select-Object -First 1
    if (-not $root) {
        return @($RootProcessId)
    }

    $descendants = [System.Collections.Generic.List[int]]::new()
    $pending = [System.Collections.Generic.Queue[object]]::new()
    $pending.Enqueue($root)

    while ($pending.Count -gt 0) {
        $parent = $pending.Dequeue()
        foreach ($child in $processes | Where-Object {
            $_.ParentProcessId -eq $parent.ProcessId -and $_.CreationDate -ge $parent.CreationDate
        }) {
            $childId = [int]$child.ProcessId
            $descendants.Add($childId)
            $pending.Enqueue($child)
        }
    }

    $ordered = @($descendants)
    [array]::Reverse($ordered)
    return @($ordered) + $RootProcessId
}

function Stop-OwnedProcessTree {
    param([AllowNull()][System.Diagnostics.Process]$Process)

    if (-not $Process) {
        return
    }

    try {
        if ($Process.HasExited) {
            return
        }
    } catch {
        return
    }

    foreach ($processId in (Get-ProcessTreeIds -RootProcessId $Process.Id)) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
}

function Stop-ProcessTreeById {
    param([AllowNull()][int]$RootProcessId)

    if (-not $RootProcessId) {
        return
    }

    foreach ($processId in (Get-ProcessTreeIds -RootProcessId $RootProcessId)) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
}

function New-ServiceDescriptor {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    return [pscustomobject]@{
        Name = $Name
        Port = $Port
        WorkingDirectory = $WorkingDirectory
        Executable = $Executable
        Arguments = $Arguments
        Process = $null
        Ownership = 'none'
        State = 'down'
        RestartCount = 0
        StartedAt = $null
        NextStartAt = [datetime]::MinValue
        LastExitCode = $null
    }
}

function Start-ManagedService {
    param([Parameter(Mandatory)]$Service)

    $stdoutPath = Join-Path $runtimeDirectory ("{0}.stdout.log" -f $Service.Name)
    $stderrPath = Join-Path $runtimeDirectory ("{0}.stderr.log" -f $Service.Name)

    try {
        $child = Start-Process `
            -FilePath $Service.Executable `
            -ArgumentList $Service.Arguments `
            -WorkingDirectory $Service.WorkingDirectory `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath `
            -WindowStyle Hidden `
            -PassThru

        $Service.Process = $child
        $Service.Ownership = 'managed'
        $Service.State = 'starting'
        $Service.StartedAt = Get-Date
        Write-SupervisorLog ("Started {0} (PID {1}) on port {2}." -f $Service.Name, $child.Id, $Service.Port)
    } catch {
        $Service.Process = $null
        $Service.Ownership = 'none'
        $Service.State = 'failed'
        $Service.RestartCount++
        $delaySeconds = [Math]::Min([Math]::Pow(2, $Service.RestartCount), 30)
        $Service.NextStartAt = (Get-Date).AddSeconds($delaySeconds)
        Write-SupervisorLog ("Failed to start {0}: {1}. Retrying in {2}s." -f $Service.Name, $_.Exception.Message, $delaySeconds)
    }
}

function Update-ServiceState {
    param([Parameter(Mandatory)]$Service)

    $now = Get-Date
    $portIsOpen = Test-TcpPort -Port $Service.Port

    if ($Service.Process) {
        $hasExited = $false
        try {
            $hasExited = $Service.Process.HasExited
        } catch {
            $hasExited = $true
        }

        if ($hasExited) {
            try {
                $Service.LastExitCode = $Service.Process.ExitCode
            } catch {
                $Service.LastExitCode = $null
            }

            $runDuration = if ($Service.StartedAt) { $now - $Service.StartedAt } else { [timespan]::Zero }
            if ($runDuration.TotalSeconds -ge 30) {
                $Service.RestartCount = 0
            } else {
                $Service.RestartCount++
            }

            $delaySeconds = [Math]::Min([Math]::Pow(2, $Service.RestartCount), 30)
            $Service.NextStartAt = $now.AddSeconds($delaySeconds)
            Write-SupervisorLog ("{0} exited with code {1}; retrying in {2}s." -f $Service.Name, $Service.LastExitCode, $delaySeconds)
            $Service.Process = $null
            $Service.Ownership = 'none'
            $Service.State = 'down'
            $portIsOpen = Test-TcpPort -Port $Service.Port
        } else {
            $Service.State = if ($portIsOpen) { 'ready' } else { 'starting' }
            return
        }
    }

    if ($portIsOpen) {
        if ($Service.Ownership -ne 'external') {
            Write-SupervisorLog ("Monitoring externally started {0} on port {1}; it will not be stopped by this supervisor." -f $Service.Name, $Service.Port)
        }
        $Service.Ownership = 'external'
        $Service.State = 'ready'
        $Service.RestartCount = 0
        return
    }

    if ($Service.Ownership -eq 'external') {
        Write-SupervisorLog ("External {0} on port {1} disappeared; taking ownership." -f $Service.Name, $Service.Port)
        $Service.NextStartAt = $now
    }

    $Service.Ownership = 'none'
    $Service.State = 'down'
    if ($now -ge $Service.NextStartAt) {
        Start-ManagedService -Service $Service
    }
}

function Write-SupervisorStatus {
    param([Parameter(Mandatory)][object[]]$Services)

    $serviceStatus = [ordered]@{}
    foreach ($service in $Services) {
        $childPid = if ($service.Process -and -not $service.Process.HasExited) { $service.Process.Id } else { $null }
        $serviceStatus[$service.Name] = [ordered]@{
            state = $service.State
            ownership = $service.Ownership
            port = $service.Port
            pid = $childPid
            restartCount = $service.RestartCount
            lastExitCode = $service.LastExitCode
        }
    }

    $status = [ordered]@{
        supervisorPid = $PID
        updatedAt = (Get-Date).ToString('o')
        services = $serviceStatus
    }
    $status | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $supervisorStatusFile -Encoding utf8
}

function Invoke-Supervisor {
    Initialize-RuntimeDirectory

    $existingPid = Get-RecordedSupervisorPid
    if ($existingPid -and $existingPid -ne $PID -and (Test-SupervisorIsAlive -ProcessId $existingPid)) {
        throw "A VideoFlow development supervisor is already running with PID $existingPid."
    }

    Remove-Item -LiteralPath $stopRequestFile -Force -ErrorAction SilentlyContinue
    $lockStream = $null
    $services = @()

    try {
        $lockStream = [System.IO.File]::Open($lockFile, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        Set-Content -LiteralPath $supervisorPidFile -Value $PID -Encoding ascii

        $pnpm = Get-Command pnpm.cmd -ErrorAction Stop
        $powerShellPath = Get-CurrentPowerShellPath
        $frontend = New-ServiceDescriptor `
            -Name 'frontend' `
            -Port 5173 `
            -WorkingDirectory (Join-Path $projectRoot 'web') `
            -Executable $pnpm.Source `
            -Arguments @('dev')
        $backend = New-ServiceDescriptor `
            -Name 'backend' `
            -Port 8788 `
            -WorkingDirectory $projectRoot `
            -Executable $powerShellPath `
            -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'run-with-deepseek-key.ps1'))
        $services = @($frontend, $backend)

        Write-SupervisorLog ("Supervisor started with PID {0}." -f $PID)
        while (-not (Test-Path -LiteralPath $stopRequestFile)) {
            foreach ($service in $services) {
                Update-ServiceState -Service $service
            }
            Write-SupervisorStatus -Services $services
            Start-Sleep -Milliseconds 750
        }
        Write-SupervisorLog 'Stop requested.'
    } finally {
        foreach ($service in $services) {
            if ($service.Ownership -eq 'managed') {
                Stop-OwnedProcessTree -Process $service.Process
                Write-SupervisorLog ("Stopped managed {0}." -f $service.Name)
            }
        }

        if ($lockStream) {
            $lockStream.Dispose()
        }
        Remove-Item -LiteralPath $supervisorPidFile, $supervisorStatusFile, $stopRequestFile, $lockFile -Force -ErrorAction SilentlyContinue
        Write-SupervisorLog 'Supervisor stopped.'
    }
}

function Show-DevelopmentStatus {
    $recordedPid = Get-RecordedSupervisorPid
    $isRunning = $recordedPid -and (Test-SupervisorIsAlive -ProcessId $recordedPid)
    $frontendReady = Test-TcpPort -Port 5173
    $backendReady = Test-TcpPort -Port 8788

    if ($isRunning) {
        Write-Output "VideoFlow supervisor: running (PID $recordedPid)"
    } else {
        Write-Output 'VideoFlow supervisor: stopped'
    }

    $savedStatus = $null
    if (Test-Path -LiteralPath $supervisorStatusFile) {
        try {
            $savedStatus = Get-Content -LiteralPath $supervisorStatusFile -Raw | ConvertFrom-Json
        } catch {
            $savedStatus = $null
        }
    }

    foreach ($serviceName in @('frontend', 'backend')) {
        $port = if ($serviceName -eq 'frontend') { 5173 } else { 8788 }
        $ready = if ($serviceName -eq 'frontend') { $frontendReady } else { $backendReady }
        $url = if ($serviceName -eq 'frontend') { 'http://127.0.0.1:5173/' } else { 'http://127.0.0.1:8788/health' }
        $details = ''
        if ($savedStatus -and $savedStatus.services.$serviceName) {
            $service = $savedStatus.services.$serviceName
            $details = ", $($service.ownership), $($service.state)"
        }
        Write-Output ("{0}: {1}{2} ({3})" -f $serviceName, $(if ($ready) { 'ready' } else { 'down' }), $details, $url)
    }

    Write-Output "Logs: $runtimeDirectory"
}

function Start-DevelopmentSupervisor {
    Initialize-RuntimeDirectory
    $recordedPid = Get-RecordedSupervisorPid
    if ($recordedPid -and (Test-SupervisorIsAlive -ProcessId $recordedPid)) {
        Write-Output "VideoFlow supervisor is already running (PID $recordedPid)."
        Show-DevelopmentStatus
        return
    }

    Remove-Item -LiteralPath $supervisorPidFile, $supervisorStatusFile, $stopRequestFile, $lockFile -Force -ErrorAction SilentlyContinue
    $powerShellPath = Get-CurrentPowerShellPath
    $argumentList = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', ('"{0}"' -f $PSCommandPath),
        '-Command', 'run'
    )
    $process = Start-Process `
        -FilePath $powerShellPath `
        -ArgumentList $argumentList `
        -WorkingDirectory $projectRoot `
        -RedirectStandardOutput $supervisorStdoutLog `
        -RedirectStandardError $supervisorStderrLog `
        -WindowStyle Hidden `
        -PassThru

    $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-ProcessIsAlive -ProcessId $process.Id)) {
            $errorText = if (Test-Path -LiteralPath $supervisorStderrLog) {
                (Get-Content -LiteralPath $supervisorStderrLog -Raw -ErrorAction SilentlyContinue).Trim()
            } else {
                ''
            }
            throw "VideoFlow supervisor exited during startup. $errorText"
        }

        if ((Test-TcpPort -Port 5173) -and (Test-Path -LiteralPath $supervisorStatusFile)) {
            Write-Output "VideoFlow development services started (supervisor PID $($process.Id))."
            Show-DevelopmentStatus
            return
        }
        Start-Sleep -Milliseconds 250
    }

    throw "VideoFlow supervisor did not make the frontend ready within $StartupTimeoutSeconds seconds. Check $supervisorStderrLog and $supervisorLog."
}

function Stop-DevelopmentSupervisor {
    Initialize-RuntimeDirectory
    $recordedPid = Get-RecordedSupervisorPid
    if (-not $recordedPid -or -not (Test-SupervisorIsAlive -ProcessId $recordedPid)) {
        Remove-Item -LiteralPath $supervisorPidFile, $supervisorStatusFile, $stopRequestFile, $lockFile -Force -ErrorAction SilentlyContinue
        Write-Output 'VideoFlow supervisor is already stopped.'
        return
    }

    Set-Content -LiteralPath $stopRequestFile -Value (Get-Date).ToString('o') -Encoding ascii
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline -and (Test-SupervisorIsAlive -ProcessId $recordedPid)) {
        Start-Sleep -Milliseconds 250
    }

    if (Test-SupervisorIsAlive -ProcessId $recordedPid) {
        Write-Warning "Supervisor PID $recordedPid did not stop cleanly; terminating its owned process tree."
        Stop-ProcessTreeById -RootProcessId $recordedPid
    }

    Remove-Item -LiteralPath $supervisorPidFile, $supervisorStatusFile, $stopRequestFile, $lockFile -Force -ErrorAction SilentlyContinue
    Write-Output 'VideoFlow development supervisor stopped.'
}

switch ($Command) {
    'start' { Start-DevelopmentSupervisor }
    'stop' { Stop-DevelopmentSupervisor }
    'restart' {
        Stop-DevelopmentSupervisor
        Start-DevelopmentSupervisor
    }
    'status' { Show-DevelopmentStatus }
    'run' { Invoke-Supervisor }
}
