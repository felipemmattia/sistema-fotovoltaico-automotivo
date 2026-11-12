<#
.SYNOPSIS
    Servico 24/7 para manter o Dashboard no ar com dominio fixo DuckDNS (telemetriafv.duckdns.org).
.DESCRIPTION
    1. Inicia o servidor backend Node.js nativamente na porta 3000 (sem depender do Docker Desktop estar aberto).
    2. Atualiza o registro A do DuckDNS (telemetriafv.duckdns.org -> 185.199.108.153).
    3. Inicia e supervisiona o tunel HTTPS Cloudflare em segundo plano, sem poluir o terminal.
    4. Sincroniza automaticamente a URL viva do tunel com a branch gh-pages para acesso mundial imediato.
    5. Registra inicializacao automatica silenciosa no Windows (Startup).
#>

param(
    [int]$LocalPort = 3000,
    [switch]$RegisterStartup = $true
)

$ErrorActionPreference = "SilentlyContinue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $projectRoot "dashboard\backend"
$binDir = Join-Path $PSScriptRoot "bin"
$cloudflaredExe = Join-Path $binDir "cloudflared.exe"
$tunnelLog = Join-Path $binDir "tunnel_live.log"
$envDuckFile = Join-Path $projectRoot ".env.duckdns"

if (-not (Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
}

# 1. Evita multiplas instancias simultaneas do supervisor 24/7
$currentPid = $PID
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object {
    $_.ProcessId -ne $currentPid -and $_.CommandLine -match "start_public_tunnel\.ps1"
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

# 2. Configura atalho de inicializacao silenciosa no Windows (sem abrir janela CMD ao ligar o PC)
if ($RegisterStartup) {
    try {
        $startupFolder = [Environment]::GetFolderPath("Startup")
        $scriptPath = Join-Path $PSScriptRoot "start_public_tunnel.ps1"
        $lnkPath = Join-Path $startupFolder "TelemetriaFV_Servidor_24_7.lnk"
        $wsh = New-Object -ComObject WScript.Shell
        $shortcut = $wsh.CreateShortcut($lnkPath)
        $shortcut.TargetPath = "powershell.exe"
        $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
        $shortcut.WorkingDirectory = $projectRoot
        $shortcut.WindowStyle = 7
        $shortcut.Description = "Inicia automaticamente em segundo plano o Servidor e Tunel 24/7 do Sistema Fotovoltaico Automotivo"
        $shortcut.Save()
    } catch {}
}

# 3. Funcao que garante que o servidor Backend (porta 3000) esta rodando (nativo via Node.js ou Docker)
function Ensure-BackendRunning {
    try {
        $hc = Invoke-RestMethod -Uri "http://localhost:$LocalPort/api/health" -TimeoutSec 2 -ErrorAction Stop
        if ($hc -and $hc.status -eq "UP") {
            return $true
        }
    } catch {}

    Write-Host "[SERVIDOR] Iniciando servidor backend local na porta $LocalPort..." -ForegroundColor Cyan

    # Instala dependencias caso ainda nao existam (ex.: primeiro uso no computador da sala de aula)
    $nodeModules = Join-Path $backendDir "node_modules"
    if (-not (Test-Path $nodeModules)) {
        Push-Location $backendDir
        npm install --production --silent 2>$null | Out-Null
        Pop-Location
    }

    $env:PORT = "$LocalPort"
    $env:NODE_ENV = "production"
    Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $backendDir -WindowStyle Hidden | Out-Null

    # Aguarda ate 8 segundos para o servidor responder na porta 3000
    for ($i = 0; $i -lt 16; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $hc = Invoke-RestMethod -Uri "http://localhost:$LocalPort/api/health" -TimeoutSec 2 -ErrorAction Stop
            if ($hc -and $hc.status -eq "UP") {
                Write-Host "[OK] Servidor Backend ativo em http://localhost:$LocalPort" -ForegroundColor Green
                return $true
            }
        } catch {}
    }

    Write-Host "[AVISO] O servidor na porta $LocalPort ainda esta inicializando..." -ForegroundColor Yellow
    return $false
}

# 4. Atualiza DuckDNS (aponta telemetriafv.duckdns.org para o gateway 185.199.108.153)
$duckDomain = "telemetriafv"
$duckToken = $env:DUCKDNS_TOKEN
if (Test-Path $envDuckFile) {
    Get-Content $envDuckFile | ForEach-Object {
        if ($_ -match "^DUCKDNS_DOMAIN=(.+)$") { $duckDomain = $Matches[1].Trim() }
        if ($_ -match "^DUCKDNS_TOKEN=(.+)$")  { $duckToken  = $Matches[1].Trim() }
    }
}
if ($duckToken) {
    try {
        $resp = Invoke-RestMethod -Uri "https://www.duckdns.org/update?domains=$duckDomain&token=$duckToken&ip=185.199.108.153" -TimeoutSec 10 -ErrorAction Stop
        Write-Host "[OK] Dominio DuckDNS verificado: https://$duckDomain.duckdns.org ($resp)" -ForegroundColor Green
    } catch {}
}

# 5. Baixa cloudflared caso nao exista no computador
if (-not (Test-Path $cloudflaredExe)) {
    Write-Host "[TUNNEL] Baixando cliente oficial Cloudflare Tunnel (cloudflared)..." -ForegroundColor Cyan
    $downloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    Invoke-WebRequest -Uri $downloadUrl -OutFile $cloudflaredExe -UseBasicParsing
}

function Publish-TunnelEndpoint([string]$tunnelUrl) {
    $cfgPath = Join-Path $projectRoot "dashboard\frontend\runtime-config.json"
    $jsonObj = [ordered]@{
        domain     = "$duckDomain.duckdns.org"
        tunnel_url = $tunnelUrl
        updated_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    }
    $jsonContent = $jsonObj | ConvertTo-Json -Depth 3
    Set-Content -Path $cfgPath -Value $jsonContent -Encoding UTF8

    $ghExe = Join-Path $binDir "bin\gh.exe"
    if (-not (Test-Path $ghExe)) { $ghExe = "gh" }
    try {
        $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($jsonContent))
        $existing = & $ghExe api "repos/felipemmattia/sistema-fotovoltaico-automotivo/contents/runtime-config.json?ref=gh-pages" 2>$null | ConvertFrom-Json
        if ($existing -and $existing.sha) {
            & $ghExe api --method PUT "repos/felipemmattia/sistema-fotovoltaico-automotivo/contents/runtime-config.json" `
                -f message="chore: update live classroom tunnel endpoint" `
                -f content="$b64" `
                -f sha="$($existing.sha)" `
                -f branch="gh-pages" 2>$null | Out-Null
            Write-Host "[OK] https://$duckDomain.duckdns.org conectado ao tunel $tunnelUrl" -ForegroundColor Green
        }
    } catch {}
}

Ensure-BackendRunning | Out-Null

Write-Host "=====================================================================" -ForegroundColor Cyan
Write-Host " SERVIDOR 24/7 ATIVO - SISTEMA FOTOVOLTAICO AUTOMOTIVO" -ForegroundColor Cyan
Write-Host " Endereco Oficial: https://$duckDomain.duckdns.org" -ForegroundColor Green
Write-Host " Painel Local:     http://localhost:$LocalPort" -ForegroundColor Yellow
Write-Host "=====================================================================" -ForegroundColor Cyan

# 6. Loop de supervisao 24/7 silencioso e resiliente
while ($true) {
    Ensure-BackendRunning | Out-Null

    Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    if (Test-Path $tunnelLog) { Remove-Item $tunnelLog -Force -ErrorAction SilentlyContinue }

    $proc = Start-Process -FilePath $cloudflaredExe `
        -ArgumentList "tunnel --url http://localhost:$LocalPort --no-autoupdate --logfile `"$tunnelLog`"" `
        -WindowStyle Hidden -PassThru

    $publishedUrl = $null
    $failCount = 0
    $lastHealthCheck = [DateTime]::UtcNow

    while ($proc -and (-not $proc.HasExited)) {
        if ((-not $publishedUrl) -and (Test-Path $tunnelLog)) {
            $logText = Get-Content $tunnelLog -Raw -ErrorAction SilentlyContinue
            if ($logText -match "(https://[a-zA-Z0-9-]+\.trycloudflare\.com)") {
                $publishedUrl = $Matches[1]
                Write-Host "[OK] Tunel ativo estabelecido: $publishedUrl" -ForegroundColor Cyan
                Publish-TunnelEndpoint -tunnelUrl $publishedUrl
                $lastHealthCheck = [DateTime]::UtcNow
            }
        } elseif ($publishedUrl -and (([DateTime]::UtcNow - $lastHealthCheck).TotalSeconds -ge 35)) {
            $lastHealthCheck = [DateTime]::UtcNow
            # Garante primeiro que o backend local esta ativo antes de testar o tunel externo
            Ensure-BackendRunning | Out-Null
            try {
                $hc = Invoke-RestMethod -Uri "$publishedUrl/api/health" -TimeoutSec 8 -ErrorAction Stop
                if ($hc -and $hc.status -eq "UP") {
                    $failCount = 0
                } else {
                    $failCount++
                }
            } catch {
                $failCount++
            }
            if ($failCount -ge 3) {
                Write-Host "[24/7] Reconectando tunel apos mudanca de rede ou suspensao..." -ForegroundColor Yellow
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                break
            }
        }
        Start-Sleep -Seconds 3
    }

    Start-Sleep -Seconds 5
}
