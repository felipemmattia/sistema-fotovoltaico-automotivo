/**
 * Camada de Persistência de Dados para Telemetria Fotovoltaica.
 * Utiliza gravação sequencial atômica (Write-Ahead Log em JSONL) para evitar
 * corrupção de arquivos em desligamentos abruptos e mantém índice em memória.
 */

const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, 'data');
const TELEMETRY_FILE = path.join(DB_DIR, 'telemetry_history.jsonl');
const SETTINGS_FILE = path.join(DB_DIR, 'settings.json');

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

if (!fs.existsSync(SETTINGS_FILE)) {
  const defaultSettings = {
    vehicle_name: 'Volkswagen Amarok - Prata',
    system_voltage: 12,
    battery_capacity_ah: 80,
    solar_kwp: 0.2,
    updated_at: new Date().toISOString()
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 2));
}

class TelemetryDatabase {
  constructor() {
    this.memoryCache = [];
    this.loadInitialCache();
  }

  loadInitialCache() {
    if (fs.existsSync(TELEMETRY_FILE)) {
      try {
        const lines = fs.readFileSync(TELEMETRY_FILE, 'utf-8').trim().split('\n');
        this.memoryCache = lines
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean);

        if (this.memoryCache.length > 50000) {
          this.memoryCache = this.memoryCache.slice(-50000);
        }
        console.log(`[DATABASE] ${this.memoryCache.length} registros carregados em memória.`);
      } catch (err) {
        console.error('[DATABASE] Falha ao ler histórico:', err.message);
        this.memoryCache = [];
      }
    }
  }

  /**
   * Grava uma leitura de telemetria de forma atômica no disco e atualiza o índice em memória.
   */
  insertTelemetry(data) {
    const record = {
      id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
      timestamp: new Date().toISOString(),
      timestamp_epoch: Math.floor(Date.now() / 1000),
      ...data
    };

    fs.appendFileSync(TELEMETRY_FILE, JSON.stringify(record) + '\n', 'utf-8');

    this.memoryCache.push(record);
    if (this.memoryCache.length > 50000) {
      this.memoryCache.shift();
    }

    return record;
  }

  /**
   * Retorna o histórico agregado em janelas fixas de tempo:
   * - 'hours': últimas 24h com resolução de 1 minuto (60s)
   * - 'days' : últimos 7 dias com resolução de 10 minutos (600s)
   * - 'weeks': últimos 30 dias com resolução de 30 minutos (1800s)
   */
  getHistory(period = 'hours') {
    const now = Math.floor(Date.now() / 1000);
    let secondsBack = 24 * 3600;
    let bucketIntervalSec = 60;

    if (period === 'days') {
      secondsBack = 7 * 24 * 3600;
      bucketIntervalSec = 10 * 60;
    } else if (period === 'weeks') {
      secondsBack = 30 * 24 * 3600;
      bucketIntervalSec = 30 * 60;
    }

    const cutoff = now - secondsBack;
    const filtered = this.memoryCache.filter((r) => r.timestamp_epoch >= cutoff);

    const sampled = [];
    let lastBucketTime = 0;

    for (const record of filtered) {
      const bucket = Math.floor(record.timestamp_epoch / bucketIntervalSec) * bucketIntervalSec;
      if (bucket > lastBucketTime) {
        sampled.push(record);
        lastBucketTime = bucket;
      }
    }

    return sampled;
  }

  getLatest() {
    if (this.memoryCache.length === 0) return null;
    return this.memoryCache[this.memoryCache.length - 1];
  }

  getSettings() {
    try {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      return JSON.parse(data);
    } catch {
      return {
        vehicle_name: 'Volkswagen Fox',
        system_voltage: 12,
        battery_capacity_ah: 200,
        solar_kwp: 0.45
      };
    }
  }

  updateSettings(newSettings) {
    const current = this.getSettings();
    const updated = {
      ...current,
      ...newSettings,
      updated_at: new Date().toISOString()
    };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2));
    return updated;
  }
}

module.exports = new TelemetryDatabase();
