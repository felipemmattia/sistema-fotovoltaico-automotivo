/**
 * Servidor HTTP e WebSocket para telemetria do sistema fotovoltaico automotivo.
 * Gerencia ingestão de pacotes do ESP32-S3, frequência adaptativa por RSSI,
 * transmissão em tempo real para clientes web e sinalização da rede Mesh P2P (WebRTC).
 */

const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const db = require('./database');
const { sanitizeTelemetryPayload, decodeControllerDiagnostics } = require('./validators');
const offlineDetector = require('./offlineDetector');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TELEMETRY_API_KEY || 'solar_sec_key_production_2026_epever';
const PUBLIC_KEEPALIVE_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Registro de nós conectados para sinalização WebRTC P2P Mesh
const peers = new Map();

app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

function broadcast(data, excludePeerId = null) {
  const jsonStr = JSON.stringify(data);
  peers.forEach((client, peerId) => {
    if (peerId !== excludePeerId && client.readyState === 1) {
      client.send(jsonStr);
    }
  });
}

function broadcastMeshTopology() {
  const peerList = Array.from(peers.keys());
  broadcast({
    type: 'MESH_TOPOLOGY',
    peers: peerList,
    count: peerList.length
  });
}

offlineDetector.onStatusChange((onlineState, lastHeartbeat) => {
  broadcast({
    type: 'STATUS_UPDATE',
    online: onlineState,
    last_heartbeat: lastHeartbeat ? new Date(lastHeartbeat).toISOString() : null
  });
});

// ==============================================================================
// Rotas REST da API
// ==============================================================================

/**
 * Recebe leituras enviadas pelo módulo ESP32-S3 via HTTP POST.
 * Retorna o próximo intervalo de envio calculado conforme a presença de usuários e o sinal Wi-Fi.
 */
app.post('/api/telemetry', (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey && apiKey !== API_KEY) {
      return res.status(401).json({ success: false, error: 'Chave de API inválida' });
    }

    const settings = db.getSettings();
    const sanitized = sanitizeTelemetryPayload(req.body, settings.system_voltage || 12);

    offlineDetector.recordPacket();

    const savedRecord = db.insertTelemetry({
      ...sanitized,
      online: true
    });

    broadcast({
      type: 'TELEMETRY_LIVE',
      payload: savedRecord
    });

    // Intervalo adaptativo: 10s quando sem usuários ativos; 1s a 5s conforme proximidade Wi-Fi (RSSI)
    const activeClients = peers.size;
    const rssi =
      sanitized.wifi_rssi !== null && sanitized.wifi_rssi !== undefined
        ? sanitized.wifi_rssi
        : -80;

    let nextIntervalMs = 10000;
    if (activeClients > 0) {
      if (rssi >= -55) {
        nextIntervalMs = 1000;
      } else if (rssi >= -70) {
        nextIntervalMs = 2000;
      } else {
        nextIntervalMs = 5000;
      }
    }

    return res.status(201).json({
      success: true,
      timestamp: savedRecord.timestamp,
      id: savedRecord.id,
      next_interval_ms: nextIntervalMs,
      mesh_nodes: activeClients
    });
  } catch (err) {
    console.error('[API] Erro em /api/telemetry:', err.message);
    return res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * Retorna a leitura atual apenas se o sistema estiver online, evitando exibir dados antigos como atuais.
 */
app.get('/api/telemetry/latest', (req, res) => {
  const latest = db.getLatest();
  const settings = db.getSettings();
  const status = offlineDetector.getStatus();

  let activeTelemetry = null;
  if (status.online && latest) {
    const diag = decodeControllerDiagnostics(latest, settings.system_voltage || 12);
    activeTelemetry = {
      ...latest,
      controller_errors: diag.controller_errors,
      charging_stage: diag.charging_stage || latest.charging_stage || null,
      online: true
    };
  }

  return res.json({
    success: true,
    data: activeTelemetry,
    vehicle_name: settings.vehicle_name,
    status: status,
    mesh_nodes: peers.size
  });
});

/**
 * Retorna a série histórica agregada conforme o período selecionado (hours | days | weeks).
 */
app.get('/api/telemetry/history', (req, res) => {
  const period = req.query.period || 'hours';
  const history = db.getHistory(period);
  return res.json({
    success: true,
    period: period,
    count: history.length,
    data: history
  });
});

/**
 * Consulta e atualização das especificações do sistema fotovoltaico e veículo.
 */
app.get('/api/settings', (req, res) => {
  return res.json({ success: true, data: db.getSettings() });
});

app.put('/api/settings', (req, res) => {
  try {
    const updated = db.updateSettings(req.body);

    broadcast({
      type: 'SETTINGS_UPDATE',
      payload: updated
    });

    return res.json({ success: true, data: updated });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * Endpoint de verificação de integridade do serviço (utilizado também por monitores 24/7).
 */
app.get('/api/health', (req, res) => {
  return res.json({
    status: 'UP',
    uptime_seconds: process.uptime(),
    offline_detector: offlineDetector.getStatus(),
    mesh_nodes: peers.size
  });
});

// ==============================================================================
// WebSocket e Sinalização WebRTC P2P Mesh
// ==============================================================================
wss.on('connection', (ws) => {
  const peerId = 'node_' + crypto.randomBytes(3).toString('hex');
  peers.set(peerId, ws);

  const latest = db.getLatest();
  const settings = db.getSettings();
  const status = offlineDetector.getStatus();

  let activeTelemetry = null;
  if (status.online && latest) {
    const diag = decodeControllerDiagnostics(latest, settings.system_voltage || 12);
    activeTelemetry = {
      ...latest,
      controller_errors: diag.controller_errors,
      charging_stage: diag.charging_stage || latest.charging_stage || null,
      online: true
    };
  }

  ws.send(
    JSON.stringify({
      type: 'INIT_STATE',
      peer_id: peerId,
      mesh_peers: Array.from(peers.keys()),
      payload: {
        latest: activeTelemetry,
        settings: settings,
        status: status
      }
    })
  );

  broadcastMeshTopology();

  ws.on('message', (rawMsg) => {
    let msg;
    try {
      msg = JSON.parse(rawMsg.toString());
    } catch {
      return;
    }

    if (msg.type === 'SIGNAL_RELAY' && msg.target && peers.has(msg.target)) {
      const targetWs = peers.get(msg.target);
      if (targetWs && targetWs.readyState === 1) {
        targetWs.send(
          JSON.stringify({
            type: 'SIGNAL_RELAY',
            from: peerId,
            signal: msg.signal
          })
        );
      }
    } else if (msg.type === 'MESH_RELAY_PACKET' && msg.payload) {
      broadcast(
        {
          type: 'MESH_RELAY_PACKET',
          from: peerId,
          payload: msg.payload
        },
        peerId
      );
    }
  });

  ws.on('close', () => {
    peers.delete(peerId);
    broadcastMeshTopology();
  });
});

// Keep-alive automático para manter instâncias em nuvem (ex.: Render Free Tier) ativas 24/7
if (PUBLIC_KEEPALIVE_URL) {
  setInterval(() => {
    const target = `${PUBLIC_KEEPALIVE_URL.replace(/\/$/, '')}/api/health`;
    const client = target.startsWith('https') ? https : http;
    client.get(target, () => {}).on('error', () => {});
  }, 10 * 60 * 1000);
}

server.listen(PORT, () => {
  console.log('=======================================================');
  console.log(' SERVIDOR DE TELEMETRIA FOTOVOLTAICA AUTOMOTIVA ATIVO');
  console.log(` Porta: ${PORT}`);
  console.log(` Webhook de Telemetria: POST http://localhost:${PORT}/api/telemetry`);
  console.log(` Interface Web: http://localhost:${PORT}`);
  console.log('=======================================================');
});
