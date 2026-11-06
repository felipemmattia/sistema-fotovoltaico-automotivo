/**
 * Rede Mesh P2P de Uplink e Retransmissão de Telemetria (WebRTC DataChannel + BroadcastChannel).
 *
 * Arquitetura Uplink Bridge (Carro -> Malha P2P -> Computador Principal -> Web Mundial):
 * 1. Dispositivos próximos ao veículo (conectados ao hotspot/mDNS local do ESP32-S3) coletam
 *    os pacotes de telemetria diretamente da controladora Epever XTRA 2210N.
 * 2. Esses pacotes saltam de navegador em navegador via WebRTC P2P (até 5 saltos) até alcançarem
 *    qualquer nó que possua conexão com o Computador Principal (onde o servidor está rodando).
 * 3. O Computador Principal ingere o pacote, salva no histórico e publica em tempo real na web
 *    (https://telemetriafv.duckdns.org) para qualquer pessoa em qualquer lugar do mundo.
 */

class TelemetryMeshRepeater {
  constructor({ onTelemetryRelay, onSettingsRelay, onTopologyChange, getApiUrl }) {
    this.peerId = null;
    this.ws = null;
    this.connections = new Map(); // peerId -> { pc, dc }
    this.seenPackets = new Set();
    this.totalClusterNodes = 1;
    this.relayedCount = 0;
    this.uplinkForwardedCount = 0;
    this.vehicleEdgeConnected = false;

    this.onTelemetryRelay = onTelemetryRelay || (() => {});
    this.onSettingsRelay = onSettingsRelay || (() => {});
    this.onTopologyChange = onTopologyChange || (() => {});
    this.getApiUrl = getApiUrl || ((path) => path);

    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

    if ('BroadcastChannel' in window) {
      this.localChannel = new BroadcastChannel('solar_telemetry_p2p_mesh');
      this.localChannel.onmessage = (e) => {
        if (e.data) this.handleIncomingMeshEnvelope(e.data);
      };
    }

    this.startVehicleEdgeCollector();
  }

  attachSignalingSocket(ws) {
    this.ws = ws;
  }

  setIdentity(peerId, allPeers = []) {
    this.peerId = peerId;
    this.updateTopology(allPeers);
  }

  updateTopology(peerList = []) {
    this.totalClusterNodes = Math.max(1, peerList.length);

    if (this.peerId && typeof RTCPeerConnection !== 'undefined') {
      for (const [remoteId, conn] of this.connections.entries()) {
        if (!peerList.includes(remoteId)) {
          try {
            if (conn.dc) conn.dc.close();
            if (conn.pc) conn.pc.close();
          } catch {}
          this.connections.delete(remoteId);
        }
      }

      const candidates = peerList.filter((id) => id !== this.peerId).slice(0, 6);
      candidates.forEach((remoteId) => {
        if (!this.connections.has(remoteId) && this.peerId < remoteId) {
          this.createPeerConnection(remoteId, true);
        }
      });
    }

    this.notifyState();
  }

  createPeerConnection(remoteId, isInitiator) {
    if (typeof RTCPeerConnection === 'undefined') return null;

    const pc = new RTCPeerConnection(this.rtcConfig);
    const entry = { pc, dc: null };
    this.connections.set(remoteId, entry);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(remoteId, { type: 'ice', candidate: event.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.connections.delete(remoteId);
      }
      this.notifyState();
    };

    if (isInitiator) {
      const dc = pc.createDataChannel('telemetry_mesh', {
        ordered: false,
        maxRetransmits: 2
      });
      this.setupDataChannel(remoteId, dc);

      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          this.sendSignal(remoteId, { type: 'sdp', sdp: pc.localDescription });
        })
        .catch(() => {});
    } else {
      pc.ondatachannel = (event) => {
        this.setupDataChannel(remoteId, event.channel);
      };
    }

    return entry;
  }

  setupDataChannel(remoteId, dc) {
    const entry = this.connections.get(remoteId);
    if (entry) entry.dc = dc;

    dc.onopen = () => this.notifyState();
    dc.onclose = () => this.notifyState();
    dc.onmessage = (event) => {
      try {
        const envelope = JSON.parse(event.data);
        this.handleIncomingMeshEnvelope(envelope);
      } catch {}
    };
  }

  async handleSignal(fromPeerId, signal) {
    if (!fromPeerId || !signal || typeof RTCPeerConnection === 'undefined') return;
    let entry = this.connections.get(fromPeerId);
    if (!entry) {
      entry = this.createPeerConnection(fromPeerId, false);
    }
    if (!entry || !entry.pc) return;
    const pc = entry.pc;

    try {
      if (signal.type === 'sdp' && signal.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        if (signal.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.sendSignal(fromPeerId, { type: 'sdp', sdp: pc.localDescription });
        }
      } else if (signal.type === 'ice' && signal.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    } catch {}
  }

  sendSignal(targetPeerId, signal) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(
        JSON.stringify({
          type: 'SIGNAL_RELAY',
          target: targetPeerId,
          signal
        })
      );
    }
  }

  // ==========================================================================
  // Coletor de Borda do Veículo (Ponte Carro -> P2P -> Computador Principal)
  // ==========================================================================
  startVehicleEdgeCollector() {
    // Endereços locais padrão do ESP32-S3 no veículo (mDNS ou SoftAP de campo)
    const getCandidateEndpoints = () => {
      const customHost = localStorage.getItem('esp32_local_host');
      const hosts = [];
      if (customHost) hosts.push(customHost.replace(/\/+$/, ''));
      if (location.protocol === 'http:') {
        hosts.push('http://epever-solar-esp32s3.local', 'http://192.168.4.1');
      }
      return hosts;
    };

    const pollVehicleEdge = async () => {
      const endpoints = getCandidateEndpoints();
      if (!endpoints.length) return;

      for (const base of endpoints) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 1400);
          const res = await fetch(`${base}/text_sensor/mesh_telemetry_json`, {
            signal: controller.signal,
            cache: 'no-store'
          });
          clearTimeout(timer);

          if (res.ok) {
            const data = await res.json();
            const rawJson = data && data.state ? data.state : null;
            if (rawJson && rawJson.startsWith('{')) {
              const telemetry = JSON.parse(rawJson);
              this.vehicleEdgeConnected = true;
              this.ingestFromVehicleEdge(telemetry);
              return;
            }
          }
        } catch {}
      }
      this.vehicleEdgeConnected = false;
    };

    setInterval(pollVehicleEdge, 2000);
  }

  /**
   * Chamado quando este dispositivo capta dados diretamente do carro (ESP32-S3)
   * e precisa fazê-los chegar até o Computador Principal via malha P2P.
   */
  ingestFromVehicleEdge(telemetryPayload) {
    if (!telemetryPayload) return;
    const packetId = `UPLINK_${telemetryPayload.device_id || 'ESP32'}_${Date.now()}`;
    const enriched = {
      ...telemetryPayload,
      packet_id: packetId,
      timestamp: new Date().toISOString()
    };

    // Renderiza localmente no dispositivo coletor
    this.onTelemetryRelay(enriched, 'vehicle_edge');

    // 1. Se este nó já alcança o Computador Principal, entrega imediatamente ao servidor
    this.deliverUplinkToMainServer(enriched, 1);

    // 2. Simultaneamente propaga na malha P2P para que outros nós vizinhos também garantam a entrega ao servidor
    this.relayPacket('UPLINK_TO_SERVER', enriched, 0);
  }

  /**
   * Entrega o pacote capturado na malha P2P para o Computador Principal (onde o site roda),
   * que então distribui para toda a internet mundial.
   */
  deliverUplinkToMainServer(payload, hop = 1) {
    if (!payload) return;

    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(
          JSON.stringify({
            type: 'MESH_UPLINK_INGEST',
            hop,
            from: this.peerId || 'edge_node',
            payload
          })
        );
        this.uplinkForwardedCount += 1;
        this.notifyState();
        return;
      } catch {}
    }

    // Fallback via HTTP POST para o Computador Principal
    fetch(this.getApiUrl('/api/telemetry/uplink'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hop,
        from: this.peerId || 'edge_node',
        payload
      })
    })
      .then((r) => {
        if (r.ok) {
          this.uplinkForwardedCount += 1;
          this.notifyState();
        }
      })
      .catch(() => {});
  }

  /**
   * Retransmite um pacote para todos os pares WebRTC conectados (até 5 saltos para alcançar o PC da sala).
   */
  relayPacket(kind, payload, hop = 0) {
    if (!payload || hop >= 5) return;
    const packetId =
      payload.packet_id ||
      `${kind}_${payload.id || payload.timestamp || payload.updated_at || Date.now()}`;
    if (this.seenPackets.has(packetId)) return;
    this.rememberPacket(packetId);

    const envelope = {
      packet_id: packetId,
      kind,
      hop: hop + 1,
      from: this.peerId || 'local',
      payload
    };

    const serialized = JSON.stringify(envelope);
    let sentToPeer = false;

    for (const [, conn] of this.connections.entries()) {
      if (conn.dc && conn.dc.readyState === 'open') {
        try {
          conn.dc.send(serialized);
          sentToPeer = true;
        } catch {}
      }
    }

    if (this.localChannel) {
      try {
        this.localChannel.postMessage(envelope);
      } catch {}
    }

    if (sentToPeer) {
      this.relayedCount += 1;
      this.notifyState();
    }
  }

  handleIncomingMeshEnvelope(envelope) {
    if (!envelope || !envelope.packet_id || !envelope.payload) return;
    if (this.seenPackets.has(envelope.packet_id)) return;
    this.rememberPacket(envelope.packet_id);

    if (envelope.kind === 'UPLINK_TO_SERVER') {
      // Este nó recebeu um pacote vindo do carro através de um vizinho P2P:
      // 1. Entrega imediatamente ao Computador Principal (caso este nó tenha alcance ao servidor)
      this.deliverUplinkToMainServer(envelope.payload, envelope.hop || 1);
      // 2. Atualiza a tela local
      this.onTelemetryRelay(envelope.payload, envelope.from);
    } else if (envelope.kind === 'TELEMETRY') {
      this.onTelemetryRelay(envelope.payload, envelope.from);
    } else if (envelope.kind === 'SETTINGS') {
      this.onSettingsRelay(envelope.payload);
    }

    // Continua propagando (até 5 saltos) para garantir que chegue até o Computador Principal
    if ((envelope.hop || 1) < 5) {
      this.relayPacket(envelope.kind, envelope.payload, envelope.hop || 1);
    }
  }

  rememberPacket(packetId) {
    this.seenPackets.add(packetId);
    if (this.seenPackets.size > 300) {
      const first = this.seenPackets.values().next().value;
      this.seenPackets.delete(first);
    }
  }

  getOpenPeerChannelsCount() {
    let open = 0;
    for (const [, conn] of this.connections.entries()) {
      if (conn.dc && conn.dc.readyState === 'open') open += 1;
    }
    return open;
  }

  notifyState() {
    this.onTopologyChange({
      totalNodes: this.totalClusterNodes,
      directPeers: this.getOpenPeerChannelsCount(),
      relayedCount: this.relayedCount,
      uplinkForwardedCount: this.uplinkForwardedCount,
      vehicleEdgeConnected: this.vehicleEdgeConnected
    });
  }
}

window.TelemetryMeshRepeater = TelemetryMeshRepeater;
