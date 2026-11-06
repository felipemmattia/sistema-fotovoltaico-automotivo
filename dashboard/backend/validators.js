/**
 * Validação, sanitização e decodificação de diagnósticos Modbus RTU
 * para a controladora MPPT Epever XTRA 2210N.
 */

/**
 * Decodifica os registradores de status da controladora (0x3200, 0x3201 e 0x3202)
 * e verifica limites operacionais de segurança.
 */
function decodeControllerDiagnostics(record, systemVoltage = 12) {
  if (!record || typeof record !== 'object') {
    return { controller_errors: [], charging_stage: null };
  }

  const alerts = [];
  const seenCodes = new Set();
  const addAlert = (code, label, severity = 'error', register = '0x3200') => {
    if (!code || seenCodes.has(code)) return;
    seenCodes.add(code);
    alerts.push({ code, label, severity, register });
  };

  if (Array.isArray(record.controller_errors)) {
    for (const item of record.controller_errors) {
      if (typeof item === 'string' && item.trim()) {
        addAlert(item.trim().toUpperCase(), item.trim(), 'error', '0x3200');
      } else if (item && typeof item === 'object' && item.label) {
        addAlert(
          item.code || item.label.toUpperCase(),
          String(item.label),
          item.severity === 'warn' ? 'warn' : 'error',
          item.register || '0x3200'
        );
      }
    }
  }

  const batReg = typeof record.battery_status === 'number' ? record.battery_status & 0xffff : 0;
  const chgReg = typeof record.charging_status === 'number' ? record.charging_status & 0xffff : 0;
  const disReg = typeof record.discharging_status === 'number' ? record.discharging_status & 0xffff : 0;

  // 1. Registrador 0x3200 — Status da Bateria (Tensão, Temperatura, Resistência Interna, Tensão Nominal)
  const voltBits = batReg & 0x000f;
  if (voltBits === 0x01) {
    addAlert('BAT_OVERVOLT', 'Sobretensão na bateria', 'error', '0x3200');
  } else if (voltBits === 0x02) {
    addAlert('BAT_UNDERVOLT', 'Subtensão na bateria', 'warn', '0x3200');
  } else if (voltBits === 0x03) {
    addAlert('BAT_LVD', 'Desconexão por descarga profunda (LVD)', 'error', '0x3200');
  } else if (voltBits === 0x04) {
    addAlert('BAT_FAULT', 'Falha na bateria', 'error', '0x3200');
  }

  const tempBits = (batReg >> 4) & 0x000f;
  if (tempBits === 0x01) {
    addAlert('BAT_OVERTEMP', 'Superaquecimento na bateria', 'error', '0x3200');
  } else if (tempBits === 0x02) {
    addAlert('BAT_LOWTEMP', 'Temperatura baixa crítica na bateria', 'warn', '0x3200');
  }

  if (batReg & 0x0100) {
    addAlert('BAT_INT_RES', 'Resistência interna anormal da bateria', 'warn', '0x3200');
  }
  if (batReg & 0x8000) {
    addAlert('SYS_VOLT_ERR', 'Identificação incorreta da tensão nominal', 'error', '0x3200');
  }

  // 2. Registrador 0x3201 — Status do Equipamento de Carregamento
  const pvVoltBits = (chgReg >> 14) & 0x0003;
  if (pvVoltBits === 0x02) {
    addAlert('PV_OVERVOLT', 'Sobretensão na entrada FV (painéis)', 'error', '0x3201');
  } else if (pvVoltBits === 0x03) {
    addAlert('PV_VOLT_ERR', 'Erro de tensão na entrada FV', 'error', '0x3201');
  }

  if (chgReg & 0x2000) {
    addAlert('CHG_MOSFET_SHORT', 'MOSFET de carregamento em curto-circuito', 'error', '0x3201');
  }
  if (chgReg & 0x1000) {
    addAlert('CHG_MOSFET_OPEN', 'MOSFET de carregamento ou anti-reverso aberto', 'error', '0x3201');
  }
  if (chgReg & 0x0800) {
    addAlert('ANTIREV_MOSFET_SHORT', 'MOSFET anti-reverso em curto-circuito', 'error', '0x3201');
  }
  if (chgReg & 0x0400) {
    addAlert('PV_OVERCURRENT', 'Sobrecorrente na entrada FV', 'error', '0x3201');
  }
  if (chgReg & 0x0200) {
    addAlert('LOAD_OVERCURRENT', 'Sobrecorrente na saída de carga', 'error', '0x3201');
  }
  if (chgReg & 0x0100) {
    addAlert('LOAD_SHORT', 'Curto-circuito na saída de carga', 'error', '0x3201');
  }
  if (chgReg & 0x0080) {
    addAlert('LOAD_MOSFET_SHORT', 'MOSFET de carga em curto-circuito', 'error', '0x3201');
  }
  if (chgReg & 0x0040) {
    addAlert('CIRCUIT_DISEQ', 'Desequilíbrio nos circuitos internos', 'warn', '0x3201');
  }
  if (chgReg & 0x0010) {
    addAlert('PV_SHORT', 'Entrada FV em curto-circuito', 'error', '0x3201');
  }
  if (chgReg & 0x0002) {
    addAlert('CTRL_FAULT', 'Falha interna na controladora MPPT', 'error', '0x3201');
  }

  const stageBits = (chgReg >> 2) & 0x0003;
  const STAGE_MAP = {
    0: null,
    1: 'Flutuação',
    2: 'Boost (Absorção)',
    3: 'Equalização'
  };
  const chargingStage = STAGE_MAP[stageBits] || null;

  // 3. Registrador 0x3202 — Status do Equipamento de Descarga
  if (disReg & 0x0800) {
    addAlert('DIS_OUT_SHORT', 'Curto-circuito na saída de descarga', 'error', '0x3202');
  }
  if (disReg & 0x0400) {
    addAlert('DIS_STOP_ERR', 'Falha ao interromper descarga', 'error', '0x3202');
  }
  if (disReg & 0x0100) {
    addAlert('DIS_VOLT_ABNORMAL', 'Tensão de saída anormal', 'warn', '0x3202');
  }
  if (disReg & 0x0040) {
    addAlert('HV_SIDE_SHORT', 'Curto-circuito no barramento de alta tensão', 'error', '0x3202');
  }
  if (disReg & 0x0020) {
    addAlert('BOOST_OVERVOLT', 'Sobretensão no estágio Boost', 'error', '0x3202');
  }
  if (disReg & 0x0010) {
    addAlert('DIS_OVERCURRENT', 'Sobrecorrente na saída', 'error', '0x3202');
  }

  // 4. Verificação complementar por limites físicos de tensão, corrente e temperatura
  const scale = systemVoltage === 24 ? 2 : 1;
  const vBat = typeof record.battery_voltage === 'number' ? record.battery_voltage : null;
  const tBat = typeof record.external_temp === 'number' ? record.external_temp : null;
  const vPv = typeof record.pv_voltage === 'number' ? record.pv_voltage : null;
  const iBat = typeof record.battery_current === 'number' ? record.battery_current : null;

  if (vBat !== null && vBat > 0.5) {
    if (vBat >= 15.5 * scale) {
      addAlert('BAT_OVERVOLT', 'Sobretensão na bateria', 'error', '0x3200');
    } else if (vBat <= 10.6 * scale) {
      addAlert('BAT_LVD', 'Tensão crítica de descarga (subtensão severa)', 'error', '0x3200');
    } else if (vBat <= 11.2 * scale) {
      addAlert('BAT_UNDERVOLT', 'Subtensão na bateria', 'warn', '0x3200');
    }
  }

  if (tBat !== null) {
    if (tBat >= 50) {
      addAlert('BAT_OVERTEMP', 'Superaquecimento na bateria', 'error', '0x3200');
    } else if (tBat >= 44) {
      addAlert('BAT_HIGHTEMP', 'Temperatura elevada na bateria', 'warn', '0x3200');
    } else if (tBat <= -10) {
      addAlert('BAT_LOWTEMP', 'Temperatura baixa crítica na bateria', 'warn', '0x3200');
    }
  }

  if (vPv !== null && vPv >= 95) {
    addAlert('PV_OVERVOLT', 'Sobretensão na entrada FV (painéis)', 'error', '0x3201');
  }

  if (iBat !== null && iBat >= 21.0) {
    addAlert('PV_OVERCURRENT', 'Sobrecorrente de carregamento (>20 A)', 'warn', '0x3201');
  }

  return {
    controller_errors: alerts,
    charging_stage: chargingStage
  };
}

function sanitizeTelemetryPayload(raw, systemVoltage = 12) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Payload nulo ou em formato inválido');
  }

  const clamp = (val, min, max, defaultVal = 0) => {
    const num = parseFloat(val);
    if (isNaN(num)) return defaultVal;
    return Math.min(Math.max(num, min), max);
  };

  const clampInt = (val, min, max, defaultVal = 0) => {
    const num = parseInt(val, 10);
    if (isNaN(num)) return defaultVal;
    return Math.min(Math.max(num, min), max);
  };

  const sanitized = {
    device_id: String(raw.device_id || 'ESP32S3_EPEVER_UNSET').trim(),
    online: Boolean(raw.online !== false),
    pv_voltage: clamp(raw.pv_voltage, 0, 120, 0),
    pv_current: clamp(raw.pv_current, 0, 30, 0),
    pv_power: clamp(raw.pv_power, 0, 1000, 0),
    battery_voltage: clamp(raw.battery_voltage, 0, 36, 0),
    battery_current: clamp(raw.battery_current, 0, 30, 0),
    battery_power: clamp(raw.battery_power, 0, 1000, 0),
    battery_soc: clamp(raw.battery_soc, 0, 100, 0),
    external_temp: clamp(raw.external_temp, -40, 85, 25),
    controller_temp: clamp(raw.controller_temp, -40, 85, 25),
    peak_pv_power: clamp(raw.peak_pv_power, 0, 2000, 0),
    energy_today: clamp(raw.energy_today, 0, 100, 0),
    energy_total: clamp(raw.energy_total, 0, 100000, 0),
    wifi_rssi: typeof raw.wifi_rssi === 'number' ? clamp(raw.wifi_rssi, -120, 0, -100) : null,
    battery_status: clampInt(raw.battery_status, 0, 65535, 0),
    charging_status: clampInt(raw.charging_status, 0, 65535, 0),
    discharging_status: clampInt(raw.discharging_status, 0, 65535, 0)
  };

  const diag = decodeControllerDiagnostics(
    { ...sanitized, controller_errors: raw.controller_errors },
    systemVoltage
  );
  sanitized.controller_errors = diag.controller_errors;
  if (diag.charging_stage) {
    sanitized.charging_stage = diag.charging_stage;
  }

  return sanitized;
}

module.exports = { sanitizeTelemetryPayload, decodeControllerDiagnostics };
