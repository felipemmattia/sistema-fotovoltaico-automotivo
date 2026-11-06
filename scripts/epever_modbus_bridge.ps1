<#
.SYNOPSIS
    Ponte serial direta Epever Modbus RTU -> Dashboard Web (para bancada / testes via USB-RS485).
.DESCRIPTION
    Lê os registradores Modbus RTU (função 0x04) da controladora Epever XTRA 2210N
    conectada a uma porta serial local (ex.: COM3) e envia as leituras via HTTP POST
    para o endpoint /api/telemetry do dashboard.
#>

param(
    [string]$PortName = "COM3",
    [int]$BaudRate = 115200,
    [string]$DashboardUrl = "http://localhost:3000/api/telemetry",
    [int]$IntervalSeconds = 2
)

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " INICIANDO PONTE SERIAL MODBUS RTU -> DASHBOARD" -ForegroundColor Cyan
Write-Host " Porta: $PortName | Baudrate: $BaudRate | Destino: $DashboardUrl" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

function Calculate-ModbusCRC16([byte[]]$buf) {
    [uint16]$crc = 0xFFFF
    for ($i = 0; $i -lt $buf.Length; $i++) {
        $crc = $crc -bxor [uint16]$buf[$i]
        for ($j = 0; $j -lt 8; $j++) {
            if (($crc -band 0x0001) -ne 0) {
                $crc = ($crc -shr 1) -bxor 0xA001
            } else {
                $crc = $crc -shr 1
            }
        }
    }
    return $crc
}

function Build-ModbusFrame([byte]$slaveId, [byte]$funcCode, [uint16]$startAddr, [uint16]$numRegs) {
    [byte[]]$payload = @(
        $slaveId,
        $funcCode,
        [byte](($startAddr -shr 8) -band 0xFF),
        [byte]($startAddr -band 0xFF),
        [byte](($numRegs -shr 8) -band 0xFF),
        [byte]($numRegs -band 0xFF)
    )
    $crc = Calculate-ModbusCRC16 $payload
    [byte[]]$frame = @(
        $payload[0], $payload[1], $payload[2], $payload[3], $payload[4], $payload[5],
        [byte]($crc -band 0xFF),
        [byte](($crc -shr 8) -band 0xFF)
    )
    return $frame
}

try {
    $port = [System.IO.Ports.SerialPort]::new($PortName, $BaudRate, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
    $port.ReadTimeout = 1500
    $port.WriteTimeout = 1500
    $port.Open()
    Write-Host "[OK] Porta $PortName aberta com sucesso." -ForegroundColor Green
} catch {
    Write-Host "[ERRO] Não foi possível abrir a porta $PortName. Verifique se outro programa está utilizando a porta serial." -ForegroundColor Red
    Write-Host "Detalhe: $($_.Exception.Message)" -ForegroundColor Yellow
    exit 1
}

function Read-Registers([byte]$slaveId, [uint16]$startAddr, [uint16]$numRegs) {
    $req = Build-ModbusFrame $slaveId 0x04 $startAddr $numRegs
    $port.DiscardInBuffer()
    $port.DiscardOutBuffer()
    $port.Write($req, 0, $req.Length)

    Start-Sleep -Milliseconds 120

    $expectedBytes = 3 + ($numRegs * 2) + 2
    [byte[]]$response = New-Object byte[] $expectedBytes
    $readCount = 0
    $startTime = [System.DateTime]::Now

    while ($readCount -lt $expectedBytes -and ([System.DateTime]::Now - $startTime).TotalMilliseconds -lt 1500) {
        if ($port.BytesToRead -gt 0) {
            $bytesChunk = $port.Read($response, $readCount, ($expectedBytes - $readCount))
            $readCount += $bytesChunk
        } else {
            Start-Sleep -Milliseconds 10
        }
    }

    if ($readCount -lt $expectedBytes) {
        return $null
    }

    return $response
}

try {
    while ($true) {
        try {
            $respRealTime = Read-Registers 0x01 0x3100 28
            $respStatus   = Read-Registers 0x01 0x3200 3
            $respStats    = Read-Registers 0x01 0x3300 20

            if ($respRealTime -ne $null -and $respRealTime.Length -ge 59) {
                $pvVoltage = ([int]($respRealTime[3] -shl 8) -bor [int]$respRealTime[4]) / 100.0
                $pvCurrent = ([int]($respRealTime[5] -shl 8) -bor [int]$respRealTime[6]) / 100.0
                $pvPowerLow = [int]($respRealTime[7] -shl 8) -bor [int]$respRealTime[8]
                $pvPowerHigh = [int]($respRealTime[9] -shl 8) -bor [int]$respRealTime[10]
                $pvPower = (($pvPowerHigh -shl 16) -bor $pvPowerLow) / 100.0

                $battVoltage = ([int]($respRealTime[11] -shl 8) -bor [int]$respRealTime[12]) / 100.0
                $battCurrent = ([int]($respRealTime[13] -shl 8) -bor [int]$respRealTime[14]) / 100.0
                $battPowerLow = [int]($respRealTime[15] -shl 8) -bor [int]$respRealTime[16]
                $battPowerHigh = [int]($respRealTime[17] -shl 8) -bor [int]$respRealTime[18]
                $battPower = (($battPowerHigh -shl 16) -bor $battPowerLow) / 100.0

                $battTempRaw = [int]($respRealTime[35] -shl 8) -bor [int]$respRealTime[36]
                if ($battTempRaw -gt 32767) { $battTempRaw = $battTempRaw - 65536 }
                $battTemp = $battTempRaw / 100.0

                $battSoc = [int]($respRealTime[55] -shl 8) -bor [int]$respRealTime[56]

                $batStatus = 0
                $chgStatus = 0
                $disStatus = 0
                if ($respStatus -ne $null -and $respStatus.Length -ge 9) {
                    $batStatus = ([int]($respStatus[3] -shl 8) -bor [int]$respStatus[4])
                    $chgStatus = ([int]($respStatus[5] -shl 8) -bor [int]$respStatus[6])
                    $disStatus = ([int]($respStatus[7] -shl 8) -bor [int]$respStatus[8])
                }

                $dailyEnergy = 0.0
                $totalEnergy = 0.0
                if ($respStats -ne $null -and $respStats.Length -ge 43) {
                    $dailyLow = [int]($respStats[27] -shl 8) -bor [int]$respStats[28]
                    $dailyHigh = [int]($respStats[29] -shl 8) -bor [int]$respStats[30]
                    $dailyEnergy = (($dailyHigh -shl 16) -bor $dailyLow) / 100.0

                    $totalLow = [int]($respStats[39] -shl 8) -bor [int]$respStats[40]
                    $totalHigh = [int]($respStats[41] -shl 8) -bor [int]$respStats[42]
                    $totalEnergy = (($totalHigh -shl 16) -bor $totalLow) / 100.0
                }

                $payload = @{
                    device_id          = "EPEVER_USB_BRIDGE"
                    online             = $true
                    pv_voltage         = [Math]::Round($pvVoltage, 2)
                    pv_current         = [Math]::Round($pvCurrent, 2)
                    pv_power           = [Math]::Round($pvPower, 2)
                    battery_voltage    = [Math]::Round($battVoltage, 2)
                    battery_current    = [Math]::Round($battCurrent, 2)
                    battery_power      = [Math]::Round($battPower, 2)
                    battery_soc        = $battSoc
                    external_temp      = [Math]::Round($battTemp, 1)
                    controller_temp    = [Math]::Round($battTemp, 1)
                    peak_pv_power      = [Math]::Round($pvPower, 2)
                    energy_today       = [Math]::Round($dailyEnergy, 2)
                    energy_total       = [Math]::Round($totalEnergy, 2)
                    battery_status     = $batStatus
                    charging_status    = $chgStatus
                    discharging_status = $disStatus
                }

                $jsonBody = $payload | ConvertTo-Json -Compress

                try {
                    $headers = @{
                        "Content-Type" = "application/json"
                        "X-Api-Key"    = "solar_sec_key_production_2026_epever"
                    }
                    $null = Invoke-RestMethod -Uri $DashboardUrl -Method Post -Body $jsonBody -Headers $headers -TimeoutSec 3
                    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Telemetria enviada: FV=$($payload.pv_voltage)V/$($payload.pv_power)W | Bat=$($payload.battery_voltage)V/$($payload.battery_soc)% | Temp=$($payload.external_temp)°C" -ForegroundColor Green
                } catch {
                    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Erro ao enviar para Dashboard: $($_.Exception.Message)" -ForegroundColor Red
                }
            } else {
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Sem resposta da controladora Epever..." -ForegroundColor Yellow
            }
        } catch {
            Write-Host "[AVISO] Erro na leitura Modbus: $($_.Exception.Message)" -ForegroundColor Yellow
        }

        Start-Sleep -Seconds $IntervalSeconds
    }
} finally {
    if ($port -and $port.IsOpen) {
        $port.Close()
        Write-Host "Porta $PortName fechada." -ForegroundColor Cyan
    }
}
