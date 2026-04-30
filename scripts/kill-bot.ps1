# Kills any running cursor-tg-bot process (tsx/node running src/index.ts
# or the compiled dist/index.js). Used by start-bot.cmd before launching a
# fresh instance.

$ErrorActionPreference = 'Continue'

$processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Name -eq 'node.exe' -and $_.CommandLine -and (
            $_.CommandLine -match 'cursor-tg-bot' -or
            $_.CommandLine -match 'tsx.*src.index\.ts' -or
            $_.CommandLine -match 'dist.index\.js'
        )
    })

if ($processes.Count -eq 0) {
    Write-Host '  no previous instance found'
    exit 0
}

foreach ($p in $processes) {
    try {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
        Write-Host ('  killed pid ' + $p.ProcessId)
    }
    catch {
        Write-Host ('  failed to kill pid ' + $p.ProcessId + ': ' + $_.Exception.Message)
    }
}
