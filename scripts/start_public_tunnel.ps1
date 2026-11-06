<#
.SYNOPSIS
    Publica o Dashboard gratuitamente na internet (HTTPS + WebSockets) usando Cloudflare Quick Tunnel.
.DESCRIPTION
    Não exige domínio pago, servidor em nuvem pago nem cadastro de cartão.
    Baixa o binário oficial cloudflared (caso ausente) e cria um túnel HTTPS público
    apontando para http://localhost:3000 para acesso imediato pela equipe e avaliadores do SENAI.
#>

param(
    [int]$LocalPort = 3000
)

$ErrorActionPreference = "Stop"
$binDir = Join-Path $PSScriptRoot "bin"
$cloudflaredExe = Join-Path $binDir "cloudflared.exe"

if (-not (Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
}

if (-not (Test-Path $cloudflaredExe)) {
    Write-Host "[TUNNEL] Baixando cliente oficial Cloudflare Tunnel (cloudflared)..." -ForegroundColor Cyan
    $downloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    Invoke-WebRequest -Uri $downloadUrl -OutFile $cloudflaredExe -UseBasicParsing
    Write-Host "[TUNNEL] Download concluído!" -ForegroundColor Green
}

Write-Host "=====================================================================" -ForegroundColor Cyan
Write-Host " INICIANDO TÚNEL PÚBLICO GRATUITO PARA O DASHBOARD (PORTA $LocalPort)" -ForegroundColor Cyan
Write-Host " Copie o link https://....trycloudflare.com exibido abaixo" -ForegroundColor Yellow
Write-Host " e compartilhe com os avaliadores e colegas do SENAI." -ForegroundColor Yellow
Write-Host "=====================================================================" -ForegroundColor Cyan

& $cloudflaredExe tunnel --url "http://localhost:$LocalPort" --no-autoupdate

