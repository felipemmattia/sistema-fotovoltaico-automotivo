<#
.SYNOPSIS
    Servico 24/7 para manter o Dashboard no ar com dominio fixo DuckDNS (telemetriafv.duckdns.org).
#>

param(
    [int]$LocalPort = 3000,
    [switch]$RegisterStartup = $true
)

$ErrorActionPreference = "Continue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$binDir = Join-Path $PSScriptRoot "bin"
$cloudflaredExe = Join-Path $binDir "cloudflared.exe"
$tunnelLog = Join-Path $binDir "tunnel_live.log"
$envDuckFile = Join-Path $projectRoot ".env.duckdns"

if (-not (Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
}

# 1. Registra atalho na inicializacao automatica do Windows (24/7)
if ($RegisterStartup) {
    try {
        $startupFolder = [Environment]::GetFolderPath("Startup")
        $batPath = Join-Path $projectRoot "iniciar_servidor_24_7.bat"
        $lnkPath = Join-Path $startupFolder "TelemetriaFV_Servidor_24_7.lnk"
        if ((Test-Path $batPath) -and (-not (Test-Path $lnkPath))) {
            $wsh = New-Object -ComObject WScript.Shell
            $shortcut = $wsh.CreateShortcut($lnkPath)
            $shortcut.TargetPath = $batPath
            $shortcut.WorkingDirectory = $projectRoot
            $shortcut.WindowStyle = 7
            $shortcut.Description = "Inicia automaticamente o Servidor e Tunel 24/7 do Sistema Fotovoltaico Automotivo"
            $shortcut.Save()
            Write-Host "[24/7] Inicializacao automatica com o Windows configurada em: $lnkPath" -ForegroundColor Green
        }
    } catch {}
}

# 2. Garante que o container Docker esta rodando
Write-Host "[DOCKER] Verificando container solar_telemetry_dashboard..." -ForegroundColor Cyan
$running = docker ps --filter "name=solar_telemetry_dashboard" --format "{{.Names}}" 2>$null
if (-not $running) {
    Push-Location (Join-Path $projectRoot "dashboard")
    docker compose up -d
    Pop-Location
}

# 3. Atualiza DuckDNS (aponta telemetriafv.duckdns.org para o gateway 185.199.108.153)
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
        $resp = Invoke-RestMethod -Uri "https://www.duckdns.org/update?domains=$duckDomain&token=$duckToken&ip=185.199.108.153" -TimeoutSec 10
        Write-Host "[DUCKDNS] Dominio https://$duckDomain.duckdns.org verificado ($resp)" -ForegroundColor Green
    } catch {
        Write-Host "[DUCKDNS] Aviso ao contatar DuckDNS: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# 4. Baixa cloudflared caso nao exista no computador da sala de aula
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
                -f branch="gh-pages" | Out-Null
            Write-Host "[DUCKDNS] https://$duckDomain.duckdns.org vinculado ao tunel $tunnelUrl !" -ForegroundColor Green
        }
    } catch {
        Write-Host "[SYNC] Aviso ao publicar runtime-config no GitHub: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

Write-Host "=====================================================================" -ForegroundColor Cyan
Write-Host " SERVIDOR 24/7 ATIVO - SISTEMA FOTOVOLTAICO AUTOMOTIVO" -ForegroundColor Cyan
Write-Host " Endereco Fixo: https://$duckDomain.duckdns.org" -ForegroundColor Green
Write-Host " Painel Local:  http://localhost:$LocalPort" -ForegroundColor Yellow
Write-Host "=====================================================================" -ForegroundColor Cyan

# 5. Loop de supervisao 24/7 (reconecta automaticamente caso a internet oscile ou PC volte de suspensao)
while ($true) {
    if (Test-Path $tunnelLog) { Remove-Item $tunnelLog -Force -ErrorAction SilentlyContinue }
    $proc = Start-Process -FilePath $cloudflaredExe `
        -ArgumentList "tunnel --url http://localhost:$LocalPort --no-autoupdate --logfile `"$tunnelLog`"" `
        -NoNewWindow -PassThru

    $publishedUrl = $null
    $failCount = 0
    $lastHealthCheck = [DateTime]::UtcNow

    while (-not $proc.HasExited) {
        if ((-not $publishedUrl) -and (Test-Path $tunnelLog)) {
            $logText = Get-Content $tunnelLog -Raw -ErrorAction SilentlyContinue
            if ($logText -match "(https://[a-zA-Z0-9-]+\.trycloudflare\.com)") {
                $publishedUrl = $Matches[1]
                Write-Host "[TUNNEL] Tunel ativo estabelecido: $publishedUrl" -ForegroundColor Cyan
                Publish-TunnelEndpoint -tunnelUrl $publishedUrl
                $lastHealthCheck = [DateTime]::UtcNow
            }
        } elseif ($publishedUrl -and (([DateTime]::UtcNow - $lastHealthCheck).TotalSeconds -ge 25)) {
            $lastHealthCheck = [DateTime]::UtcNow
            try {
                $hc = Invoke-RestMethod -Uri "$publishedUrl/api/health" -TimeoutSec 6
                if ($hc -and $hc.status -eq "UP") {
                    $failCount = 0
                } else {
                    $failCount++
                }
            } catch {
                $failCount++
            }
            if ($failCount -ge 2) {
                Write-Host "[24/7] Tunel expirou apos suspensao/oscilacao de rede. Renovando tunel automaticamente..." -ForegroundColor Yellow
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                break
            }
        }
        Start-Sleep -Seconds 3
    }

    Write-Host "[24/7] Tunel encerrado. Reiniciando automaticamente em 5 segundos..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}
