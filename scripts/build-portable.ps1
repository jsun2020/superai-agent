[CmdletBinding()]
param(
  [switch]$SkipInstall,
  [switch]$SkipZip,
  [switch]$SkipOfficeCLI,
  [switch]$SkipRipgrep,
  # Skip step 1 (Tauri + sidecar build) and only re-stage the folder/zip from
  # the artifacts already present - e.g. after a staging failure.
  [switch]$StageOnly,
  # Stage somewhere other than dist\portable - use this while something is
  # RUNNING from dist\portable (the staging step refuses to wipe a folder in use).
  [string]$OutDir
)

# ============================================================
#  Portable Windows build orchestrator.
#
#  Produces a copy-and-run folder under  dist/portable/  containing:
#    SuperAIAgent.exe                     — Tauri desktop window
#    superai-agent-sidecar.exe            — bundled Bun runtime + server/adapters
#    superai-agent-tui.exe                — standalone terminal TUI
#    .env.example                         — copy to .env and edit
#    README-portable.txt                  — three-line usage note
#
#  Lifecycle:
#    1. Double-click SuperAIAgent.exe → Tauri window opens
#    2. Tauri loads .env from the folder, spawns superai-agent-sidecar.exe children
#    3. Closing the window kills every child (lib.rs RunEvent::Exit handler
#       + Windows taskkill fallback)
#
#  Prerequisites: Bun, Rust, MSVC 2022 build tools (same as build-windows-x64.ps1).
# ============================================================

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
$desktopDir = Join-Path $repoRoot 'desktop'
$targetTriple = 'x86_64-pc-windows-msvc'
$portableDir = if ($OutDir) { [System.IO.Path]::GetFullPath($OutDir) } else { Join-Path $repoRoot 'dist\portable' }
$tauriTargetExe = Join-Path $desktopDir "src-tauri\target\$targetTriple\release\superai-agent-desktop.exe"
$binariesDir = Join-Path $desktopDir 'src-tauri\binaries'

function Write-Step { param([string]$Message) Write-Host "[build-portable] $Message" }

# Re-uses build-windows-x64.ps1's environment-setup helpers by dot-sourcing —
# but build-windows-x64.ps1 also runs `tauri build --bundles msi` which we
# don't want here. So we replicate the prereq checks inline and call tauri
# directly with --bundles none.

if ($env:OS -ne 'Windows_NT') { throw 'This script must run on Windows.' }
foreach ($cmd in 'bun','cargo','rustc','bunx') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $cmd"
  }
}

function Import-VsDevEnvironment {
  $vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) {
    throw 'Could not find vswhere.exe. Install Visual Studio 2022 Build Tools (C++ workload).'
  }
  $installationPath = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1
  if (-not $installationPath) { throw 'Missing Visual C++ build tools (VC.Tools.x86.x64).' }
  $vsDevCmd = Join-Path $installationPath 'Common7\Tools\VsDevCmd.bat'
  if (-not (Test-Path $vsDevCmd)) { throw "Could not find VsDevCmd.bat under $installationPath" }
  Write-Step "Importing MSVC environment from $vsDevCmd"
  $env:VSCMD_SKIP_SENDTELEMETRY = '1'
  $envDump = & cmd.exe /d /s /c "`"$vsDevCmd`" -arch=x64 -host_arch=x64 >nul && set"
  if ($LASTEXITCODE -ne 0) { throw "Failed to initialize VS build environment (exit $LASTEXITCODE)" }
  foreach ($line in $envDump) {
    if ($line -match '^(.*?)=(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
  }
}

Import-VsDevEnvironment

if (-not $SkipInstall) {
  # Some Bun-on-Windows builds (1.3.11–1.3.14 observed) panic on `bun install`
  # with an internal assertion failure. We fall back to `npm install` in that
  # case — npm is always available on a Bun host because Bun ships with one.
  function Install-WithFallback {
    param([string]$Dir, [string]$Label)
    Push-Location $Dir
    try {
      & bun install
      if ($LASTEXITCODE -eq 0) { return }
      Write-Step "bun install failed in $Label (exit $LASTEXITCODE), falling back to npm install"
      & npm install --no-audit --no-fund --loglevel=error
      if ($LASTEXITCODE -ne 0) { throw "npm install also failed in $Label (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
  }

  Write-Step 'Installing root dependencies...'
  Install-WithFallback -Dir $repoRoot -Label 'root'

  Write-Step 'Installing desktop dependencies...'
  Install-WithFallback -Dir $desktopDir -Label 'desktop'

  $adaptersDir = Join-Path $repoRoot 'adapters'
  if (Test-Path (Join-Path $adaptersDir 'package.json')) {
    Write-Step 'Installing adapter dependencies...'
    Install-WithFallback -Dir $adaptersDir -Label 'adapters'
  }
}

# 1) Tauri build with --no-bundle — produces just the .exe + sidecars,
#    no MSI / NSIS installer wrapping. (Tauri 2 doesn't accept "--bundles none";
#    --no-bundle is the dedicated flag for "compile only, don't package".)
#
# The override config (disabling updater artifacts so we don't need a signing
# key in this portable path) goes through a temp file because PowerShell's
# native-command quoting eats inline JSON.
$portableTauriCfg = Join-Path ([System.IO.Path]::GetTempPath()) 'superai-agent.tauri.portable.windows.json'
@{ bundle = @{ createUpdaterArtifacts = $false } } | ConvertTo-Json -Depth 5 | Set-Content -Path $portableTauriCfg -Encoding UTF8

if ($StageOnly) {
  Write-Step 'Skipping Tauri/sidecar build (-StageOnly) - staging existing artifacts'
} else {
Write-Step "Building Tauri Desktop (--no-bundle, no MSI/NSIS)"
Push-Location $desktopDir
try {
  $env:TAURI_ENV_TARGET_TRIPLE = $targetTriple
  & bunx tauri build --target $targetTriple --no-bundle --ci --config $portableTauriCfg
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed (exit $LASTEXITCODE)" }
} finally {
  Pop-Location
  if (Test-Path $portableTauriCfg) { Remove-Item -LiteralPath $portableTauriCfg -Force }
}
}

if (-not (Test-Path $tauriTargetExe)) {
  throw "Expected Tauri exe not found at $tauriTargetExe"
}

# 2) Stage the portable folder.
Write-Step "Staging portable folder at $portableDir"
if (Test-Path $portableDir) {
  # Remove-Item -Recurse is not atomic: aimed at a folder somebody is RUNNING
  # from, it deletes everything up to the first locked exe and leaves a gutted
  # package behind (that happened). Refuse while anything runs from the folder,
  # and otherwise rename the tree aside first so a failure destroys nothing.
  $inUse = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -and $_.Path.StartsWith($portableDir, [System.StringComparison]::OrdinalIgnoreCase)
    })
  if ($inUse.Count -gt 0) {
    $who = ($inUse | ForEach-Object { "$($_.ProcessName).exe (pid $($_.Id))" }) -join ', '
    throw ("Refusing to wipe $portableDir - in use by $who. Close them, or build to another " +
      "folder with -OutDir <path> and copy the new files over afterwards.")
  }
  $aside = "$portableDir.old-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Rename-Item -LiteralPath $portableDir -NewName (Split-Path -Leaf $aside)
  Remove-Item -LiteralPath $aside -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $portableDir | Out-Null

Copy-Item -LiteralPath $tauriTargetExe -Destination (Join-Path $portableDir 'SuperAIAgent.exe')

# Sidecars produced by build-sidecars.ts (run as part of beforeBuildCommand).
$sidecarSrc = Join-Path $binariesDir "superai-agent-sidecar-$targetTriple.exe"
$tuiSrc = Join-Path $binariesDir "superai-agent-tui-$targetTriple.exe"
if (-not (Test-Path $sidecarSrc)) { throw "superai-agent-sidecar binary missing: $sidecarSrc" }
if (-not (Test-Path $tuiSrc)) { throw "superai-agent-tui binary missing: $tuiSrc" }

# Tauri requires the sidecar filename to match the target-triple form for the
# externalBin lookup in lib.rs. We keep that name AND drop a friendlier alias
# so users running from a console see `superai-agent-sidecar.exe` / `superai-agent-tui.exe`.
Copy-Item -LiteralPath $sidecarSrc -Destination (Join-Path $portableDir "superai-agent-sidecar-$targetTriple.exe")
Copy-Item -LiteralPath $sidecarSrc -Destination (Join-Path $portableDir 'superai-agent-sidecar.exe')
Copy-Item -LiteralPath $tuiSrc -Destination (Join-Path $portableDir "superai-agent-tui-$targetTriple.exe")
Copy-Item -LiteralPath $tuiSrc -Destination (Join-Path $portableDir 'superai-agent-tui.exe')

# The TUI now identifies itself as `superai` (Usage:/--version/console title),
# so ship the matching command name too. Without this the user reads
# "Usage: superai ..." and has no `superai` to type. Named to NOT collide with
# Anthropic's own `claude` on PATH - that collision is the whole point.
Copy-Item -LiteralPath $tuiSrc -Destination (Join-Path $portableDir 'superai.exe')

Copy-Item -LiteralPath (Join-Path $repoRoot '.env.example') -Destination (Join-Path $portableDir '.env.example')

# 2b) Vendor third-party tool binaries. The sidecar/TUI entrypoints prepend
#     the exe-adjacent vendor\ folder to PATH at startup (src/utils/vendorBinDir.ts),
#     so anything staged here is available to agent shell commands on machines
#     with nothing else installed.
#
#     OfficeCLI (Apache-2.0, https://github.com/iOfficeAI/OfficeCLI) is the
#     office agent's preferred document engine for docx/xlsx/pptx work.
if (-not $SkipOfficeCLI) {
  $vendorDir = Join-Path $portableDir 'vendor'
  New-Item -ItemType Directory -Force -Path $vendorDir | Out-Null

  $officecliCandidates = @()
  if ($env:OFFICECLI_EXE) { $officecliCandidates += $env:OFFICECLI_EXE }
  # npm global install keeps the real binary in the package's vendor folder
  # (the PATH entry is only a .ps1/.cmd shim).
  $officecliCandidates += (Join-Path $env:APPDATA 'npm\node_modules\@officecli\officecli\vendor\officecli.exe')
  $officecliSrc = $officecliCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $officecliSrc) {
    throw ("OfficeCLI binary not found (looked at OFFICECLI_EXE env and the npm global package). " +
      "Run 'npm install -g @officecli/officecli' first, set OFFICECLI_EXE to the exe path, " +
      "or pass -SkipOfficeCLI to build without it.")
  }

  Copy-Item -LiteralPath $officecliSrc -Destination (Join-Path $vendorDir 'officecli.exe')
  $officecliVersion = & (Join-Path $vendorDir 'officecli.exe') --version
  if ($LASTEXITCODE -ne 0) { throw "Staged vendor\officecli.exe failed 'officecli --version' (exit $LASTEXITCODE)" }
  # Running officecli triggers its self-updater, which drops a full-size
  # officecli.exe.update next to the binary — 32MB of junk in the zip if left.
  Get-ChildItem -LiteralPath $vendorDir -Filter '*.update' -File -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
  Write-Step "Vendored OfficeCLI $officecliVersion from $officecliSrc"

  # Apache-2.0 redistribution notice: prefer the full upstream license text,
  # fall back to a pointer notice when offline / behind a blocking proxy.
  $licensePath = Join-Path $vendorDir 'OFFICECLI-LICENSE.txt'
  $licenseFetched = $false
  try {
    Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/main/LICENSE' `
      -OutFile $licensePath -TimeoutSec 20 -UseBasicParsing -ErrorAction Stop
    if ((Get-Item $licensePath).Length -gt 1000) { $licenseFetched = $true }
  } catch { }
  if (-not $licenseFetched) {
    $notice = @'
This folder bundles OfficeCLI (officecli.exe), copyright the iOfficeAI project,
licensed under the Apache License, Version 2.0.

  Project: https://github.com/iOfficeAI/OfficeCLI
  License: https://www.apache.org/licenses/LICENSE-2.0

OfficeCLI is redistributed unmodified as a convenience so the built-in office
agent can create and edit Word/Excel/PowerPoint documents out of the box.
'@
    Set-Content -LiteralPath $licensePath -Value $notice -Encoding UTF8
  }
} else {
  Write-Step 'Skipping OfficeCLI vendoring (-SkipOfficeCLI)'
}

# 2c) ripgrep - the search engine behind the Grep tool.
#
#     Portable users hit ENOENT on B:\~BUN\root\vendor\ripgrep\...: inside a
#     Bun-compiled exe import.meta.url points into the virtual bundle root, so
#     none of ripgrep.ts's built-in resolution modes can produce a real path.
#     It falls back to resolving 'rg' on PATH - which is empty on a clean
#     corporate machine. Staging rg.exe here puts it on PATH via
#     registerVendorBinDir, so Grep works with nothing else installed.
#
#     Pinned and checksum-verified: a build must not be able to silently ship a
#     different binary than the one that was reviewed. RIPGREP_EXE overrides
#     the download with a local copy for offline or blocked networks.
if (-not $SkipRipgrep) {
  $vendorDir = Join-Path $portableDir 'vendor'
  New-Item -ItemType Directory -Force -Path $vendorDir | Out-Null
  $rgDest = Join-Path $vendorDir 'rg.exe'

  $rgVersion = '14.1.1'
  $rgArchive = "ripgrep-$rgVersion-x86_64-pc-windows-msvc.zip"
  $rgUrl     = "https://github.com/BurntSushi/ripgrep/releases/download/$rgVersion/$rgArchive"
  # Upstream publishes this at "$rgUrl.sha256"; verified against the downloaded
  # bytes when the version was pinned.
  $rgSha256  = 'd0f534024c42afd6cb4d38907c25cd2b249b79bbe6cc1dbee8e3e37c2b6e25a1'

  if ($env:RIPGREP_EXE) {
    if (-not (Test-Path $env:RIPGREP_EXE)) {
      throw "RIPGREP_EXE is set but does not exist: $env:RIPGREP_EXE"
    }
    Copy-Item -LiteralPath $env:RIPGREP_EXE -Destination $rgDest -Force
    Write-Step "Vendored ripgrep from RIPGREP_EXE ($env:RIPGREP_EXE)"
  } else {
    $cacheDir = Join-Path $repoRoot 'dist\vendor-cache'
    New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
    $rgZip = Join-Path $cacheDir $rgArchive

    # Re-verify the cache on every build: a truncated or tampered cache entry
    # must trigger a re-download rather than be shipped.
    if ((Test-Path $rgZip) -and
        ((Get-FileHash -LiteralPath $rgZip -Algorithm SHA256).Hash.ToLower() -ne $rgSha256)) {
      Remove-Item -LiteralPath $rgZip -Force
    }
    if (-not (Test-Path $rgZip)) {
      Write-Step "Downloading ripgrep $rgVersion ..."
      try {
        Invoke-WebRequest -Uri $rgUrl -OutFile $rgZip -UseBasicParsing -TimeoutSec 300 -ErrorAction Stop
      } catch {
        throw ("Failed to download ripgrep from $rgUrl - $($_.Exception.Message). " +
          "Set RIPGREP_EXE to a local rg.exe, or pass -SkipRipgrep to build without it " +
          "(Grep then fails on machines that have no ripgrep installed).")
      }
    }
    $rgActual = (Get-FileHash -LiteralPath $rgZip -Algorithm SHA256).Hash.ToLower()
    if ($rgActual -ne $rgSha256) {
      throw ("ripgrep checksum mismatch for $rgArchive" +
        "  expected $rgSha256  actual $rgActual")
    }

    # Ship the licenses out of the same verified archive - no second fetch that
    # could fail, or drift from the binary it covers.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $rgRoot = "ripgrep-$rgVersion-x86_64-pc-windows-msvc"
    $wanted = [ordered]@{
      "$rgRoot/rg.exe"      = $rgDest
      "$rgRoot/COPYING"     = (Join-Path $vendorDir 'RIPGREP-COPYING.txt')
      "$rgRoot/LICENSE-MIT" = (Join-Path $vendorDir 'RIPGREP-LICENSE-MIT.txt')
      "$rgRoot/UNLICENSE"   = (Join-Path $vendorDir 'RIPGREP-UNLICENSE.txt')
    }
    $zipReader = [IO.Compression.ZipFile]::OpenRead($rgZip)
    try {
      foreach ($entryName in $wanted.Keys) {
        $entry = $zipReader.Entries | Where-Object { $_.FullName -eq $entryName } | Select-Object -First 1
        if (-not $entry) { throw "ripgrep archive is missing expected entry '$entryName'" }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $wanted[$entryName], $true)
      }
    } finally {
      $zipReader.Dispose()
    }
    Write-Step "Vendored ripgrep $rgVersion (sha256 verified)"
  }

  # Prove the staged binary actually runs. A wrong-arch or truncated copy is
  # invisible until a user's first Grep.
  $rgOut = & $rgDest --version
  if ($LASTEXITCODE -ne 0) { throw "Staged vendor\rg.exe failed 'rg --version' (exit $LASTEXITCODE)" }
  $rgReported = ($rgOut | Select-Object -First 1)
  if ((-not $env:RIPGREP_EXE) -and ($rgReported -notmatch [regex]::Escape($rgVersion))) {
    throw "Staged vendor\rg.exe reports '$rgReported', expected ripgrep $rgVersion"
  }
  Write-Step "vendor\rg.exe -> $rgReported"
} else {
  Write-Step 'Skipping ripgrep vendoring (-SkipRipgrep)'
}

$readme = @'
SuperAI Agent - Portable Windows Build
======================================

Usage:
  1. Copy this entire folder anywhere you want.
  2. Open .env.example in Notepad, fill in your API keys / model,
     and Save As ".env" (no .txt suffix).
  3. Double-click SuperAIAgent.exe to launch the desktop UI.
     - Or run superai.exe from a terminal for the text UI.
     - Closing the window kills every spawned child process automatically.

Sessions (terminal UI):
  Every conversation is saved per folder under %USERPROFILE%\.claude\projects.
  A plain "superai" always starts a NEW session, and its header shows a
  "Last session ..." line when this folder already has one.
      superai -c              continue the most recent session in this folder
      superai -r              pick a session from a list (or: /resume inside)
      /compact                shrink the current context to a summary to save
                              tokens; it also happens automatically when the
                              context window fills up (/context shows usage)

DO NOT double-click superai-agent-sidecar.exe - it is an internal helper that
SuperAIAgent.exe spawns automatically. Running it directly will print a
"missing mode argument" message and exit; that is by design.

Optional WeChat IM setup:
  This is the only situation where you run superai-agent-sidecar.exe yourself.
  Open a terminal in this folder and run:
      superai-agent-sidecar.exe wechat-login
  Scan the QR code (saved to %USERPROFILE%\.claude\wechat-qr.png),
  confirm in WeChat, then restart SuperAIAgent.exe - the WeChat adapter
  will pick up the new account.

Files:
  SuperAIAgent.exe                    Desktop window     (USER - double-click this)
  superai.exe                         Terminal UI        (USER - run from a terminal)
  superai-agent-tui.exe               Same binary, long-form name
  superai-agent-sidecar.exe           Server + adapters  (INTERNAL - do not run)
  superai-agent-sidecar-x86_64-...exe Target-triple alias Tauri''s externalBin needs
  superai-agent-tui-x86_64-...exe     Target-triple alias for the TUI
  .env.example                        Template - copy to .env and edit
  vendor\officecli.exe                Bundled OfficeCLI document engine the
                                      built-in office agent uses for Word /
                                      Excel / PowerPoint tasks (Apache-2.0,
                                      github.com/iOfficeAI/OfficeCLI)
  vendorg.exe                       Bundled ripgrep - the search engine the
                                      Grep tool uses. Without it Grep cannot
                                      run on a machine that has no ripgrep
                                      installed (MIT / Unlicense,
                                      github.com/BurntSushi/ripgrep)

WebView2:
  SuperAIAgent.exe needs Microsoft Edge WebView2. Pre-installed on Windows 11
  and most updated Windows 10 systems. If launching shows a "WebView2
  missing" dialog, install the Evergreen Bootstrapper from
      https://developer.microsoft.com/microsoft-edge/webview2/
'@
Set-Content -LiteralPath (Join-Path $portableDir 'README-portable.txt') -Value $readme -Encoding UTF8

# 3) Optional zip.
if (-not $SkipZip) {
  $version = (Get-Content -LiteralPath (Join-Path $desktopDir 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version
  $zipPath = Join-Path $repoRoot "dist\SuperAIAgent-Portable-v$version.zip"
  if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Write-Step "Zipping to $zipPath"
  Compress-Archive -Path (Join-Path $portableDir '*') -DestinationPath $zipPath -CompressionLevel Optimal
  Write-Step "Done. Portable folder: $portableDir"
  Write-Step "Done. Zip:             $zipPath"
} else {
  Write-Step "Done. Portable folder: $portableDir (zip skipped)"
}
