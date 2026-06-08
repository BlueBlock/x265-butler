[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ProductName = 'x265-butler Agent',
    [string]$Manufacturer = 'x265-butler',
    [string]$ProductVersion = '1.0.0',
    [string]$UpgradeCode = 'A4A74C3A-7A55-4C57-8D6A-C5A5C7ED0972',
    [string]$ServiceName = 'x265-butler-agent',
    [string]$ServiceDisplayName = 'x265-butler Agent',
    [string]$ServiceDescription = 'Windows-first remote GPU worker for x265-butler.',
    [string]$ServiceAccount = 'LocalSystem',
    [string]$ServicePassword = '',
    [string]$Configuration = 'Release',
    [string]$Runtime = 'win-x64',
    [string]$OutputDir = '',
    [string]$FfmpegSourcePath = '',
    [string]$EnrollmentUrl = '',
    [string]$EnrollmentToken = '',
    [switch]$BundleFfmpeg,
    [switch]$SelfContained
)

$ErrorActionPreference = 'Stop'

function New-SafeId {
    param(
        [Parameter(Mandatory = $true)][string]$Prefix,
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][hashtable]$UsedIds
    )

    $base = ($Value -replace '[^A-Za-z0-9_]', '_')
    if ([string]::IsNullOrWhiteSpace($base)) {
        $base = 'id'
    }

    if ($base[0] -notmatch '[A-Za-z_]') {
        $base = "_$base"
    }

    $candidate = "$Prefix$base"
    if ($candidate.Length -gt 68) {
        $candidate = $candidate.Substring(0, 68)
    }

    $suffix = 1
    $unique = $candidate
    while ($UsedIds.ContainsKey($unique)) {
        $suffixText = "_$suffix"
        $trimTo = [Math]::Min($candidate.Length, 72 - $suffixText.Length)
        $unique = $candidate.Substring(0, $trimTo) + $suffixText
        $suffix++
    }

    $UsedIds[$unique] = $true
    return $unique
}

function Escape-Xml {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)

    if ($null -eq $Text) {
        return ''
    }

    return [System.Security.SecurityElement]::Escape($Text)
}

function Normalize-Version {
    param([Parameter(Mandatory = $true)][string]$Version)

    if ($Version -notmatch '^\d+\.\d+\.\d+$') {
        throw "ProductVersion must be in Major.Minor.Build format, for example 1.0.0"
    }

    return $Version
}

function Resolve-FfmpegBinDir {
    param([string]$ExplicitPath)

    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (-not (Test-Path $ExplicitPath)) {
            throw "FfmpegSourcePath not found: $ExplicitPath"
        }

        $item = Get-Item $ExplicitPath
        if ($item.PSIsContainer) {
            if (-not (Test-Path (Join-Path $item.FullName 'ffmpeg.exe'))) {
                throw "FfmpegSourcePath directory must contain ffmpeg.exe"
            }

            return $item.FullName
        }

        if (-not ($item.Name -ieq 'ffmpeg.exe')) {
            throw "FfmpegSourcePath file must be ffmpeg.exe"
        }

        return $item.DirectoryName
    }

    $ffmpegCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if (-not $ffmpegCmd) {
        return $null
    }

    $ffmpegPath = $ffmpegCmd.Source
    if (-not (Test-Path $ffmpegPath)) {
        return $null
    }

    try {
        $resolved = (Resolve-Path $ffmpegPath -ErrorAction SilentlyContinue).Path
        if ($resolved) {
            $ffmpegPath = $resolved
        }
    }
    catch {
        # Keep unresolved path when resolve fails.
    }

    return (Split-Path -Parent $ffmpegPath)
}

$productVersionNormalized = Normalize-Version -Version $ProductVersion

$agentRoot = Split-Path -Parent $PSScriptRoot
$workerProjectPath = Join-Path $agentRoot 'src\X265Butler.Agent.Worker\X265Butler.Agent.Worker.csproj'
$publishRoot = Join-Path $agentRoot 'artifacts\publish\msi'
$stagingRoot = Join-Path $agentRoot 'installer\obj\msi'

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $outputRoot = Join-Path $agentRoot 'artifacts\msi'
}
else {
    $outputRoot = $OutputDir
}

$msiName = "x265-butler-agent-$productVersionNormalized-$Runtime.msi"
$msiPath = Join-Path $outputRoot $msiName
$wxsPath = Join-Path $stagingRoot 'Product.wxs'
$bundleFfmpegEffective = $BundleFfmpeg.IsPresent -or -not [string]::IsNullOrWhiteSpace($FfmpegSourcePath)

if ($PSCmdlet.ShouldProcess($publishRoot, 'Clean publish staging')) {
    Remove-Item -Recurse -Force $publishRoot -ErrorAction SilentlyContinue
}

if ($PSCmdlet.ShouldProcess($stagingRoot, 'Clean wix staging')) {
    Remove-Item -Recurse -Force $stagingRoot -ErrorAction SilentlyContinue
}

if ($PSCmdlet.ShouldProcess($outputRoot, 'Ensure MSI output directory exists')) {
    New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
}

if ($PSCmdlet.ShouldProcess($stagingRoot, 'Ensure wix staging directory exists')) {
    New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
}

$publishArgs = @(
    'publish',
    $workerProjectPath,
    '-c', $Configuration,
    '-r', $Runtime,
    '--self-contained', ($SelfContained.IsPresent ? 'true' : 'false'),
    '-o', $publishRoot
)

if ($PSCmdlet.ShouldProcess($workerProjectPath, 'Publish agent for MSI payload')) {
    & dotnet @publishArgs
    if ($LASTEXITCODE -ne 0) {
        throw "dotnet publish failed with exit code $LASTEXITCODE"
    }
}

if ($bundleFfmpegEffective) {
    $ffmpegBinDir = Resolve-FfmpegBinDir -ExplicitPath $FfmpegSourcePath
    if (-not $ffmpegBinDir) {
        if ($WhatIfPreference) {
            Write-Host 'WhatIf: would bundle ffmpeg, but ffmpeg.exe source was not found on this build host.'
            Write-Host 'WhatIf: install ffmpeg or pass -FfmpegSourcePath <ffmpeg-bin-dir> for real MSI builds.'
            $ffmpegBinDir = $null
        }
        else {
        throw 'BundleFfmpeg requested, but ffmpeg.exe was not found. Install ffmpeg on build host or pass -FfmpegSourcePath.'
        }
    }

    if ($ffmpegBinDir) {
        $ffmpegTargetDir = Join-Path $publishRoot 'ffmpeg'
        if ($PSCmdlet.ShouldProcess($ffmpegTargetDir, "Bundle ffmpeg binaries from $ffmpegBinDir")) {
            New-Item -ItemType Directory -Path $ffmpegTargetDir -Force | Out-Null
            Get-ChildItem -Path $ffmpegBinDir -File | ForEach-Object {
                Copy-Item -Path $_.FullName -Destination (Join-Path $ffmpegTargetDir $_.Name) -Force
            }
        }

        $publishedSettingsPath = Join-Path $publishRoot 'appsettings.json'
        if ((Test-Path $publishedSettingsPath) -and $PSCmdlet.ShouldProcess($publishedSettingsPath, 'Set bundled ffmpeg path in appsettings')) {
            $settings = Get-Content $publishedSettingsPath -Raw | ConvertFrom-Json
            if (-not $settings.Agent) {
                $settings | Add-Member -MemberType NoteProperty -Name Agent -Value ([pscustomobject]@{})
            }

            $settings.Agent.FfmpegPath = 'ffmpeg\\ffmpeg.exe'
            $settings | ConvertTo-Json -Depth 20 | Set-Content -Path $publishedSettingsPath -Encoding UTF8
        }
    }
}

$publishedSettingsPath = Join-Path $publishRoot 'appsettings.json'
if (Test-Path $publishedSettingsPath) {
    $settings = Get-Content $publishedSettingsPath -Raw | ConvertFrom-Json
    $modified = $false

    if ($EnrollmentUrl -and $PSCmdlet.ShouldProcess($publishedSettingsPath, 'Set Butler base URL in appsettings')) {
        if (-not $settings.Butler) {
            $settings | Add-Member -MemberType NoteProperty -Name Butler -Value ([pscustomobject]@{})
        }

        $settings.Butler.BaseUrl = $EnrollmentUrl
        $settings.Butler.Enabled = $true
        $modified = $true
    }

    if ($EnrollmentToken -and $PSCmdlet.ShouldProcess($publishedSettingsPath, 'Set Butler enrollment token in appsettings')) {
        if (-not $settings.Butler) {
            $settings | Add-Member -MemberType NoteProperty -Name Butler -Value ([pscustomobject]@{})
        }

        $settings.Butler.EnrollmentToken = $EnrollmentToken
        $modified = $true
    }

    if ($modified) {
        $settings | ConvertTo-Json -Depth 20 | Set-Content -Path $publishedSettingsPath -Encoding UTF8
    }
}

$exePath = Join-Path $publishRoot 'x265-butler-agent.exe'
if (-not (Test-Path $exePath)) {
    if ($WhatIfPreference) {
        Write-Host "WhatIf: skipping publish output validation at $exePath"
        Write-Host "MSI would be created at: $msiPath"
        return
    }

    throw "Expected publish output executable not found at $exePath"
}

if ($PSCmdlet.ShouldProcess((Join-Path $agentRoot 'dotnet-tools.json'), 'Restore local dotnet tools')) {
    Push-Location $agentRoot
    try {
        & dotnet tool restore
        if ($LASTEXITCODE -ne 0) {
            throw "dotnet tool restore failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

$usedIds = @{}
$directories = @{}
$directories[''] = 'INSTALLFOLDER'

$relativeDirs = Get-ChildItem -Path $publishRoot -Directory -Recurse |
    ForEach-Object { $_.FullName.Substring($publishRoot.Length).TrimStart('\\') } |
    Sort-Object

foreach ($relativeDir in $relativeDirs) {
    $directories[$relativeDir] = New-SafeId -Prefix 'DIR_' -Value $relativeDir -UsedIds $usedIds
}

$directoryChildren = @{}
foreach ($relativeDir in $directories.Keys) {
    if ($relativeDir -eq '') {
        continue
    }

    $parent = Split-Path -Parent $relativeDir
    if ($parent -eq '.') {
        $parent = ''
    }

    if (-not $directoryChildren.ContainsKey($parent)) {
        $directoryChildren[$parent] = [System.Collections.Generic.List[string]]::new()
    }

    $directoryChildren[$parent].Add($relativeDir)
}

function Build-DirectoryXml {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$RelativePath,
        [Parameter(Mandatory = $true)][hashtable]$DirMap,
        [Parameter(Mandatory = $true)][hashtable]$DirChildren
    )

    $children = @()
    if ($DirChildren.ContainsKey($RelativePath)) {
        $children = $DirChildren[$RelativePath] | Sort-Object
    }

    $parts = [System.Collections.Generic.List[string]]::new()
    foreach ($child in $children) {
        $childName = Split-Path -Leaf $child
        $childId = $DirMap[$child]
        $directoryLine = [string]::Format('<Directory Id="{0}" Name="{1}">', $childId, (Escape-Xml -Text $childName))
        $parts.Add($directoryLine)
        $parts.Add((Build-DirectoryXml -RelativePath $child -DirMap $DirMap -DirChildren $DirChildren))
        $parts.Add('</Directory>')
    }

    return ($parts -join "`n")
}

$directoryTreeXml = Build-DirectoryXml -RelativePath '' -DirMap $directories -DirChildren $directoryChildren

$files = Get-ChildItem -Path $publishRoot -File -Recurse | Sort-Object FullName
$componentLines = [System.Collections.Generic.List[string]]::new()

foreach ($file in $files) {
    $relativeFile = $file.FullName.Substring($publishRoot.Length).TrimStart('\\')
    $relativeDir = Split-Path -Parent $relativeFile
    if ($relativeDir -eq '.') {
        $relativeDir = ''
    }

    $directoryId = $directories[$relativeDir]
    $componentId = New-SafeId -Prefix 'CMP_' -Value $relativeFile -UsedIds $usedIds
    $fileId = New-SafeId -Prefix 'FIL_' -Value $relativeFile -UsedIds $usedIds

    $componentLine = [string]::Format('<Component Id="{0}" Directory="{1}" Guid="*">', $componentId, $directoryId)
    $fileLine = [string]::Format('  <File Id="{0}" Source="{1}" KeyPath="yes" />', $fileId, (Escape-Xml -Text $file.FullName))
    $componentLines.Add($componentLine)
    $componentLines.Add($fileLine)

    if ($file.Name -ieq 'x265-butler-agent.exe') {
        $serviceInstallLine = [string]::Format('  <ServiceInstall Id="SvcInstall" Name="{0}" DisplayName="{1}" Description="{2}" Start="auto" Type="ownProcess" ErrorControl="normal" Vital="yes" Account="[AGENT_SERVICE_ACCOUNT]" Password="[AGENT_SERVICE_PASSWORD]" />', (Escape-Xml -Text $ServiceName), (Escape-Xml -Text $ServiceDisplayName), (Escape-Xml -Text $ServiceDescription))
        $serviceControlLine = [string]::Format('  <ServiceControl Id="SvcControl" Name="{0}" Start="install" Stop="both" Remove="uninstall" Wait="yes" />', (Escape-Xml -Text $ServiceName))
        $componentLines.Add($serviceInstallLine)
        $componentLines.Add($serviceControlLine)
    }

    $componentLines.Add('</Component>')
}

$componentXml = $componentLines -join "`n"

$serviceAccountPropertyXml = [string]::Format('<Property Id="AGENT_SERVICE_ACCOUNT" Value="{0}" Secure="yes" />', (Escape-Xml -Text $ServiceAccount))
if ([string]::IsNullOrWhiteSpace($ServicePassword)) {
    $servicePasswordPropertyXml = '<Property Id="AGENT_SERVICE_PASSWORD" Secure="yes" />'
}
else {
    $servicePasswordPropertyXml = [string]::Format('<Property Id="AGENT_SERVICE_PASSWORD" Value="{0}" Secure="yes" />', (Escape-Xml -Text $ServicePassword))
}

$serviceNameEscaped = Escape-Xml -Text $ServiceName
$configureServiceArgsEscaped = Escape-Xml -Text "/c sc.exe config `"$ServiceName`" obj= `"[AGENT_SERVICE_ACCOUNT]`" password= `"[AGENT_SERVICE_PASSWORD]`""

$wxs = @"
<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package
    Name="$(Escape-Xml -Text $ProductName)"
    Manufacturer="$(Escape-Xml -Text $Manufacturer)"
    Version="$productVersionNormalized"
    UpgradeCode="$UpgradeCode"
    InstallerVersion="500"
    Scope="perMachine"
    Language="1033">
    <MajorUpgrade DowngradeErrorMessage="A newer version of $(Escape-Xml -Text $ProductName) is already installed." />
    <MediaTemplate EmbedCab="yes" />
    $serviceAccountPropertyXml
    $servicePasswordPropertyXml

    <StandardDirectory Id="ProgramFiles64Folder">
      <Directory Id="INSTALLFOLDER" Name="x265-butler-agent">
$directoryTreeXml
      </Directory>
    </StandardDirectory>

        <CustomAction Id="ConfigureServiceAccount" Directory="SystemFolder" ExeCommand="cmd.exe $configureServiceArgsEscaped" Return="ignore" />

        <InstallExecuteSequence>
            <Custom Action="ConfigureServiceAccount" After="StartServices" Condition="NOT REMOVE AND AGENT_SERVICE_ACCOUNT AND AGENT_SERVICE_ACCOUNT &lt;&gt; &quot;LocalSystem&quot; AND AGENT_SERVICE_PASSWORD" />
        </InstallExecuteSequence>

    <Feature Id="MainFeature" Title="$(Escape-Xml -Text $ProductName)" Level="1">
      <ComponentGroupRef Id="ProductComponents" />
    </Feature>
  </Package>

  <Fragment>
    <ComponentGroup Id="ProductComponents">
$componentXml
    </ComponentGroup>
  </Fragment>
</Wix>
"@

if ($PSCmdlet.ShouldProcess($wxsPath, 'Write generated wix source')) {
    $wxs | Set-Content -Path $wxsPath -Encoding UTF8
}

$wixBuildArgs = @(
    'tool', 'run', 'wix', 'build',
    $wxsPath,
    '-arch', 'x64',
    '-o', $msiPath
)

if ($PSCmdlet.ShouldProcess($msiPath, 'Build MSI')) {
    Push-Location $agentRoot
    try {
        & dotnet @wixBuildArgs
        if ($LASTEXITCODE -ne 0) {
            throw "WiX build failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

Write-Host "MSI created: $msiPath"