# Diagnose which request SHAPE a hostile network breaks for an Anthropic-compatible
# provider. Run this ON the machine that fails.
#
# Why: a provider connectivity test can pass (small, buffered, non-streaming POST)
# while every chat turn fails with Bun's "InvalidHTTPResponse" or an empty
# fallback response. That means the network path is not simply "blocked" - some
# specific dimension of the request breaks it. This probes the four combinations
# of {small, large} x {non-streaming, streaming} and reports what came back.
#
# Privacy: the API key is read from the local provider store and passed to curl
# through a temporary --config file (never on the command line, never printed).
# Only status codes, timings, sizes, content types and a short body excerpt are
# shown. The temp directory is deleted at the end.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\diagnose-provider-network.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\diagnose-provider-network.ps1 -Provider MiniMax

param(
  [string]$Provider = '',
  [int]$LargeChars = 170000
)

$ErrorActionPreference = 'Stop'

$curl = Join-Path $env:SystemRoot 'System32\curl.exe'
if (-not (Test-Path $curl)) { throw "curl.exe not found at $curl (needs Windows 10 1803+)" }

$storePath = Join-Path $HOME '.claude\superai\providers.json'
if (-not (Test-Path $storePath)) { throw "provider store not found: $storePath" }
$store = Get-Content $storePath -Raw -Encoding UTF8 | ConvertFrom-Json

$candidates = @($store.providers)
if ($Provider) {
  $p = $candidates | Where-Object { $_.name -eq $Provider } | Select-Object -First 1
  if (-not $p) { throw "provider '$Provider' not found. Available: $(($candidates | ForEach-Object { $_.name }) -join ', ')" }
} else {
  $p = $candidates | Where-Object { $_.isDefault -eq $true } | Select-Object -First 1
  if (-not $p) { $p = $candidates | Where-Object { $_.apiKey } | Select-Object -First 1 }
  if (-not $p) { throw "no provider with an API key found in $storePath" }
}

$base = ($p.baseUrl -replace '/$', '')
$model = $p.model
if (-not $p.apiKey) { throw "provider '$($p.name)' has no API key stored" }

Write-Host "provider : $($p.name)"
Write-Host "base url : $base"
Write-Host "model    : $model"
Write-Host "api key  : present (length $($p.apiKey.Length))"
Write-Host ""

$tmp = Join-Path $env:TEMP ("superai-netdiag-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $tmp | Out-Null

try {
  # Header config file - keeps the key out of the process command line.
  $cfg = Join-Path $tmp 'curl.cfg'
  $cfgLines = @(
    'header = "content-type: application/json"',
    'header = "anthropic-version: 2023-06-01"',
    ('header = "x-api-key: ' + $p.apiKey + '"'),
    ('header = "authorization: Bearer ' + $p.apiKey + '"')
  )
  Set-Content -Path $cfg -Value $cfgLines -Encoding ASCII

  # Padding for the large-body cases. The app sends the whole CLAUDE.md as the
  # system prompt, so a large project file makes every request body large.
  $para = 'Project convention: verify shipped artifacts, use explicit staging, add timeouts and retries to API calls. '
  $sb = New-Object System.Text.StringBuilder
  while ($sb.Length -lt $LargeChars) { [void]$sb.Append($para) }
  $bigSystem = $sb.ToString()

  function New-Body {
    param([bool]$Stream, [bool]$Large)
    $obj = [ordered]@{
      model      = $model
      max_tokens = 64
      stream     = $Stream
      system     = $(if ($Large) { $bigSystem } else { 'You are a helpful assistant.' })
      messages   = @(@{ role = 'user'; content = 'hello?' })
    }
    return ($obj | ConvertTo-Json -Depth 6 -Compress)
  }

  $cases = @(
    @{ Name = 'A small  non-stream'; Stream = $false; Large = $false; Beta = $false },
    @{ Name = 'B small  stream    '; Stream = $true;  Large = $false; Beta = $true  },
    @{ Name = 'C large  non-stream'; Stream = $false; Large = $true;  Beta = $false },
    @{ Name = 'D large  stream    '; Stream = $true;  Large = $true;  Beta = $true  }
  )

  Write-Host ("{0,-20} {1,-9} {2,-6} {3,-9} {4,-9} {5}" -f 'CASE', 'CURL-EXIT', 'HTTP', 'SECONDS', 'BYTES', 'CONTENT-TYPE / NOTE')
  Write-Host ('-' * 100)

  foreach ($c in $cases) {
    $bodyFile = Join-Path $tmp ('body-' + $c.Name.Trim().Split(' ')[0] + '.json')
    $outFile = Join-Path $tmp ('out-' + $c.Name.Trim().Split(' ')[0] + '.txt')
    $hdrFile = Join-Path $tmp ('hdr-' + $c.Name.Trim().Split(' ')[0] + '.txt')
    [System.IO.File]::WriteAllText($bodyFile, (New-Body -Stream $c.Stream -Large $c.Large), (New-Object System.Text.UTF8Encoding($false)))

    # The app's chat path uses ?beta=true; the provider test does not.
    $url = "$base/v1/messages" + $(if ($c.Beta) { '?beta=true' } else { '' })

    $args = @(
      '--config', $cfg,
      '-s', '-S',
      '--max-time', '120',
      '-o', $outFile,
      '-D', $hdrFile,
      '-w', '%{http_code}|%{time_total}|%{size_download}',
      '-X', 'POST',
      '--data-binary', ('@' + $bodyFile),
      $url
    )
    $w = & $curl @args 2>&1
    $curlExit = $LASTEXITCODE
    $parts = ($w | Select-Object -Last 1).ToString().Split('|')
    $code = if ($parts.Count -ge 1) { $parts[0] } else { '?' }
    $secs = if ($parts.Count -ge 2) { $parts[1] } else { '?' }
    $bytes = if ($parts.Count -ge 3) { $parts[2] } else { '?' }

    $ctype = ''
    if (Test-Path $hdrFile) {
      $ctLine = Select-String -Path $hdrFile -Pattern '^content-type:' -CaseSensitive:$false | Select-Object -First 1
      if ($ctLine) { $ctype = $ctLine.Line.Trim() }
    }
    $note = $ctype
    if ($curlExit -ne 0) { $note = "curl error: $w" }
    elseif (Test-Path $outFile) {
      $head = (Get-Content $outFile -Raw -ErrorAction SilentlyContinue)
      if ($head) {
        $head = ($head -replace '\s+', ' ').Trim()
        if ($head.Length -gt 60) { $head = $head.Substring(0, 60) + '...' }
        $note = "$ctype | $head"
      }
    }
    Write-Host ("{0,-20} {1,-9} {2,-6} {3,-9} {4,-9} {5}" -f $c.Name, $curlExit, $code, $secs, $bytes, $note)
  }

  Write-Host ""
  Write-Host "How to read this:"
  Write-Host "  All four OK        -> the network is fine; the fault is in the app, send this output plus a --debug log."
  Write-Host "  A ok, B/D fail     -> the appliance breaks streaming (SSE). Streaming is what chat uses."
  Write-Host "  A/B ok, C/D fail   -> the appliance breaks LARGE request bodies. Shrink CLAUDE.md (see the startup warning)."
  Write-Host "  Non-200 with HTML  -> an interception page was substituted; the excerpt above names the appliance."
  Write-Host "  curl exit 35/56/92 -> TLS or HTTP framing was rewritten in flight (same fault Bun reports as InvalidHTTPResponse)."
}
finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
