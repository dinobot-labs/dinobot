& {
    $ErrorActionPreference = "Stop"
    $bun = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue
    if (-not $bun) { throw "Bun is required. Install it from https://bun.sh then run this installer again." }
    $temp = $null
    try {
        $temp = Join-Path ([IO.Path]::GetTempPath()) ("dinobot-install-" + [Guid]::NewGuid().ToString("N"))
        [IO.Directory]::CreateDirectory($temp) | Out-Null
        $installer = Join-Path $temp "install.mjs"
        $response = Invoke-WebRequest -Uri "https://releases.dinobot.workers.dev/install.mjs" -MaximumRedirection 0 -TimeoutSec 120 -UseBasicParsing -OutFile $installer -PassThru
        if ([int]$response.StatusCode -ne 200) { throw "Installer download rejected." }
        & $bun.Source $installer --install
        if ($LASTEXITCODE -ne 0) { throw "Dinobot installation failed (Bun exit $LASTEXITCODE)." }
    } finally {
        if ($temp -and (Test-Path -LiteralPath $temp)) { Remove-Item -LiteralPath $temp -Recurse -Force }
    }
}
