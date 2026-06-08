[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ServiceName = 'x265-butler-agent',
    [string]$DisplayName = 'x265-butler Agent',
    [string]$Description = 'Windows-first remote GPU worker for x265-butler.',
    [string]$InstallRoot = 'C:\x265-butler-agent',
    [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$projectPath = Join-Path $repoRoot 'src\X265Butler.Agent.Worker\X265Butler.Agent.Worker.csproj'
$publishPath = Join-Path $InstallRoot 'current'

if ($PSCmdlet.ShouldProcess($projectPath, 'Publish x265-butler-agent')) {
    & dotnet publish $projectPath -c $Configuration -o $publishPath
}

$exePath = Join-Path $publishPath 'x265-butler-agent.exe'

if (-not (Test-Path $exePath)) {
    throw "Published executable not found at $exePath"
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    if ($PSCmdlet.ShouldProcess($ServiceName, 'Stop existing service')) {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    }

    if ($PSCmdlet.ShouldProcess($ServiceName, 'Delete existing service')) {
        & sc.exe delete $ServiceName | Out-Null
    }
}

if ($PSCmdlet.ShouldProcess($ServiceName, 'Create Windows service')) {
    New-Service -Name $ServiceName -BinaryPathName ('"' + $exePath + '"') -DisplayName $DisplayName -Description $Description -StartupType Automatic
}

if ($PSCmdlet.ShouldProcess($ServiceName, 'Start Windows service')) {
    Start-Service -Name $ServiceName
}