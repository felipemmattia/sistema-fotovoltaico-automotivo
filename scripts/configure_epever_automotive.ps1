<#
.SYNOPSIS
    Configura a controladora Epever XTRA 2210N via Modbus RTU (RS485) para uso automotivo 12V
    com saída Load sempre ativa ao ligar (para alimentar o módulo ESP32-S3 via LM2596).
#>

param(
    [string]$PortName = "COM3",
    [int]$BaudRate = 115200,
    [byte]$SlaveId = 1
)

$ErrorActionPreference = "Stop"

function Calc-CRC16([byte[]]$buf) {
    [uint16]$crc = 0xFFFF
    for ($i = 0; $i -lt $buf.Length; $i++) {
        $crc = $crc -bxor [uint16]$buf[$i]
        for ($j = 0; $j -lt 8; $j++) {
            if (($crc -band 0x0001) -ne 0) { $crc = ($crc -shr 1) -bxor 0xA001 } else { $crc = $crc -shr 1 }
        }
    }
    return $crc
}

function Send-RawFrame($port, [byte[]]$payload, [int]$expectedBytes) {
    $crc = Calc-CRC16 $payload
    [byte[]]$frame = $payload + @([byte]($crc -band 0xFF), [byte](($crc -shr 8) -band 0xFF))
    $port.DiscardInBuffer()
    $port.DiscardOutBuffer()
    $port.Write($frame, 0, $frame.Length)
    Start-Sleep -Milliseconds 140

    [byte[]]$buf = New-Object byte[] $expectedBytes
    $r = 0
    $t0 = [DateTime]::Now
    while ($r -lt $expectedBytes -and ([DateTime]::Now - $t0).TotalMilliseconds -lt 1500) {
        if ($port.BytesToRead -gt 0) {
            $r += $port.Read($buf, $r, $expectedBytes - $r)
        } else {
            Start-Sleep -Milliseconds 10
        }
    }
    if ($r -lt 5) { return $null }
    return $buf[0..($r - 1)]
}

function Read-Holding($port, [uint16]$addr, [uint16]$count) {
    [byte[]]$p = @($SlaveId, 0x03, [byte](($addr -shr 8) -band 0xFF), [byte]($addr -band 0xFF), [byte](($count -shr 8) -band 0xFF), [byte]($count -band 0xFF))
    $resp = Send-RawFrame $port $p (3 + $count * 2 + 2)
    if (-not $resp -or ($resp[1] -band 0x80)) { return $null }
    $out = @()
    for ($i = 0; $i -lt $count; $i++) {
        $out += (([int]$resp[3 + $i * 2] -shl 8) -bor [int]$resp[4 + $i * 2])
    }
    return $out
}

function Write-MultipleHolding($port, [uint16]$startAddr, [uint16[]]$values) {
    $count = [uint16]$values.Length
    $byteCount = [byte]($count * 2)
    $list = [System.Collections.Generic.List[byte]]::new()
    $list.Add($SlaveId)
    $list.Add(0x10)
    $list.Add([byte](($startAddr -shr 8) -band 0xFF))
    $list.Add([byte]($startAddr -band 0xFF))
    $list.Add([byte](($count -shr 8) -band 0xFF))
    $list.Add([byte]($count -band 0xFF))
    $list.Add($byteCount)
    foreach ($val in $values) {
        $list.Add([byte](($val -shr 8) -band 0xFF))
        $list.Add([byte]($val -band 0xFF))
    }
    $resp = Send-RawFrame $port $list.ToArray() 8
    if (-not $resp) { return @{ ok = $false; err = "Sem resposta" } }
    if (($resp[1] -band 0x80) -ne 0) {
        return @{ ok = $false; err = ("Excecao Modbus 0x{0:X2}" -f $resp[2]) }
    }
    return @{ ok = $true }
}

function Write-SingleCoil($port, [uint16]$coilAddr, [bool]$on) {
    $valHi = if ($on) { [byte]0xFF } else { [byte]0x00 }
    [byte[]]$p = @($SlaveId, 0x05, [byte](($coilAddr -shr 8) -band 0xFF), [byte]($coilAddr -band 0xFF), $valHi, 0x00)
    $resp = Send-RawFrame $port $p 8
    if (-not $resp) { return @{ ok = $false; err = "Sem resposta" } }
    if (($resp[1] -band 0x80) -ne 0) {
        return @{ ok = $false; err = ("Excecao Modbus 0x{0:X2}" -f $resp[2]) }
    }
    return @{ ok = $true }
}

$port = [System.IO.Ports.SerialPort]::new($PortName, $BaudRate, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
$port.ReadTimeout = 1500
$port.WriteTimeout = 1500
$port.Open()
Start-Sleep -Milliseconds 300

try {
    # Leitura inicial de acordar o barramento RS485
    $null = Read-Holding $port 0x9000 1

    Write-Host "=== 1. GRAVANDO PERFIL DE BATERIA AUTOMOTIVA 12V (0x9000..0x900E) ===" -ForegroundColor Cyan
    [uint16[]]$batBlock = @(
        0,    # 0x9000 User-Defined
        80,   # 0x9001 80 Ah (Amarok)
        300,  # 0x9002 Temp Comp 3.00 mV/C/2V
        1600, # 0x9003 HVD 16.00V
        1500, # 0x9004 Chg Limit 15.00V
        1500, # 0x9005 OVR 15.00V
        1440, # 0x9006 Equalize 14.40V
        1440, # 0x9007 Boost 14.40V (Absorcao real ate 100%, igual ao alternador)
        1360, # 0x9008 Float 13.60V (Flutuacao segura em 100%)
        1320, # 0x9009 Boost Reconnect 13.20V
        1220, # 0x900A LVR 12.20V (religa porta Load mais rapido apos queda)
        1200, # 0x900B UVR 12.00V
        1180, # 0x900C UVW 11.80V
        1110, # 0x900D LVD 11.10V (protecao da bateria de partida do veiculo)
        1060  # 0x900E Discharging Limit 10.60V
    )
    # Primeiro garante 0x9000 = 0 (User) e grava o bloco completo com espera de EEPROM
    $rBat = Write-MultipleHolding $port 0x9000 $batBlock
    Start-Sleep -Milliseconds 300
    $rBat = Write-MultipleHolding $port 0x9000 $batBlock
    Write-Host ("Bloco 0x9000..0x900E: ok={0} err={1}" -f $rBat.ok, $rBat.err)

    Write-Host "=== 2. TRAVANDO SISTEMA EM 12V E EQUALIZACAO 0 MIN (0x9067 / 0x906B) ===" -ForegroundColor Cyan
    $rSys = Write-MultipleHolding $port 0x9067 @([uint16]1)
    Write-Host ("0x9067 Rated System Voltage = 1 (12V fixo): ok={0} err={1}" -f $rSys.ok, $rSys.err)
    $rEqDur = Write-MultipleHolding $port 0x906B @([uint16]0)
    Write-Host ("0x906B Equalize Duration = 0 min (selada/automotiva): ok={0} err={1}" -f $rEqDur.ok, $rEqDur.err)

    Write-Host "=== 3. CONFIGURANDO PORTA LOAD SEMPRE LIGADA AO ENERGIZAR (0x903D / 0x906A / Coils) ===" -ForegroundColor Cyan
    $rMode = Write-MultipleHolding $port 0x903D @([uint16]0)
    Write-Host ("0x903D Load Control Mode = 0 (Manual): ok={0} err={1}" -f $rMode.ok, $rMode.err)
    $rDef = Write-MultipleHolding $port 0x906A @([uint16]1)
    Write-Host ("0x906A Default Load ON in Manual Mode = 1 (Ligada ao iniciar): ok={0} err={1}" -f $rDef.ok, $rDef.err)
    $rC0 = Write-SingleCoil $port 0x0000 $true
    $rC1 = Write-SingleCoil $port 0x0001 $true
    $rC2 = Write-SingleCoil $port 0x0002 $true
    Write-Host ("Coils: 0x0000(ChgON)={0} | 0x0001(Manual)={1} | 0x0002(LoadON)={2}" -f $rC0.ok, $rC1.ok, $rC2.ok)

    Start-Sleep -Milliseconds 300

    Write-Host "=== 4. VERIFICACAO DE LEITURA POS-GRAVACAO ===" -ForegroundColor Green
    $vBat = Read-Holding $port 0x9000 15
    $names = @(
        "0x9000 Battery Type (0=User)",
        "0x9001 Capacity (Ah)",
        "0x9002 Temp Comp",
        "0x9003 High Voltage Disconnect",
        "0x9004 Charging Limit",
        "0x9005 Over Voltage Reconnect",
        "0x9006 Equalization Voltage",
        "0x9007 Boost Voltage",
        "0x9008 Float Voltage",
        "0x9009 Boost Reconnect",
        "0x900A Low Voltage Reconnect",
        "0x900B Under Voltage Recover",
        "0x900C Under Voltage Warning",
        "0x900D Low Voltage Disconnect",
        "0x900E Discharging Limit"
    )
    for ($i = 0; $i -lt 15; $i++) {
        $valStr = if ($i -le 1) { "$($vBat[$i])" } else { "{0:N2} V" -f ($vBat[$i] / 100.0) }
        Write-Host ("  {0}: {1}" -f $names[$i], $valStr)
    }
    $vSys = Read-Holding $port 0x9067 1
    $vMode = Read-Holding $port 0x903D 1
    $vDef = Read-Holding $port 0x906A 1
    $vEq = Read-Holding $port 0x906B 1
    $coilsResp = Send-RawFrame $port @($SlaveId, 0x01, 0x00, 0x00, 0x00, 0x07) 6
    Write-Host ("  0x9067 System Voltage Code: {0} (1=12V)" -f $vSys[0])
    Write-Host ("  0x906B Equalize Duration: {0} min" -f $vEq[0])
    Write-Host ("  0x903D Load Control Mode: {0} (0=Manual)" -f $vMode[0])
    Write-Host ("  0x906A Default Load ON: {0} (1=ON)" -f $vDef[0])
    if ($coilsResp) {
        Write-Host ("  Coils 0x0000..0x0006: 0x{0:X2} (bits={1})" -f $coilsResp[3], [Convert]::ToString($coilsResp[3], 2).PadLeft(8, '0'))
    }
} finally {
    if ($port.IsOpen) { $port.Close() }
}
