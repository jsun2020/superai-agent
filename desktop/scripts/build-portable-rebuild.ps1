$ErrorActionPreference = 'Stop'
$cleaned = ($env:Path -split ';' | Where-Object { $_ -and ($_ -notmatch 'AppData\\Roaming\\npm') }) -join ';'
$env:Path = "$env:USERPROFILE\.bun\bin;$env:USERPROFILE\.cargo\bin;$cleaned"

$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw "vswhere not found at $vswhere" }
$vswhereArgs = @('-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath')
$installPath = (& $vswhere @vswhereArgs | Select-Object -First 1)
if (-not $installPath) { throw "VC.Tools.x86.x64 workload not found via vswhere" }
$vsDevCmd = Join-Path $installPath 'Common7\Tools\VsDevCmd.bat'
if (-not (Test-Path $vsDevCmd)) { throw "VsDevCmd.bat not found at $vsDevCmd" }
$env:VSCMD_SKIP_SENDTELEMETRY = '1'
$envDump = & cmd.exe /d /s /c "`"$vsDevCmd`" -arch=x64 -host_arch=x64 >nul && set"
foreach ($line in $envDump) { if ($line -match '^(.*?)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') } }

$desktopDir = Join-Path $PSScriptRoot '..'
Push-Location $desktopDir
$env:TAURI_ENV_TARGET_TRIPLE = 'x86_64-pc-windows-msvc'
& bunx tauri build --target x86_64-pc-windows-msvc --no-bundle --ci
$exitCode = $LASTEXITCODE
Pop-Location
Write-Host "EXIT_CODE: $exitCode"
exit $exitCode
