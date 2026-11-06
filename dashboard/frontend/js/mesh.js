/**
 * Rede Mesh P2P de Retransmissão de Telemetria (WebRTC DataChannel + BroadcastChannel).
 * Permite que cada navegador aberto funcione como um nó repetidor de pacotes de telemetria,
 * retransmitindo leituras em tempo real para usuários mais distantes do veículo.
 */

class TelemetryMeshRepeater {
  constructor({ onTelemetryRelay, onSettingsRelay, onTopologyChange }) {
    this.peerId = null;
    this.ws = null;
    this.connections = new Map(); // peerId -> { pc, dc }
    this.seenPackets = new Set();
    this.totalClusterNodes = 1;
    this.relayedCount = 0;

    this.onTelemetryRelay = onTelemetryRelay || (() => {});
    this.onSettingsRelay = onSettingsRelay || (() => {});
    this.onTopologyChange = onTopologyChange || (() => {});

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
      // Remove conexões com nós que saíram
      for (const [remoteId, conn] of this.connections.entries()) {
        if (!peerList.includes(remoteId)) {
          try {
            if (conn.dc) conn.dc.close();
            if (conn.pc) conn.pc.close();
          } catch {}
          this.connections.delete(remoteId);
        }
      }

      // Inicia conexão WebRTC com até 6 vizinhos (regra determinística de ID para evitar colisão)
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
        maxRetransmits: 1
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

  /**
   * Retransmite um pacote de telemetria ou configuração para todos os pares WebRTC conectados.
   */
  relayPacket(kind, payload, hop = 0) {
    if (!payload || hop >= 3) return;
    const packetId = `${kind}_${payload.id || payload.timestamp || payload.updated_at || Date.now()}`;
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

    if (envelope.kind === 'TELEMETRY') {
      this.onTelemetryRelay(envelope.payload, envelope.from);
    } else if (envelope.kind === 'SETTINGS') {
      this.onSettingsRelay(envelope.payload);
    }

    // Retransmissão multi-salto (até 3 saltos) para alcançar dispositivos ainda mais distantes
    if ((envelope.hop || 1) < 3) {
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
      relayedCount: this.relayedCount
    });
  }
}

window.TelemetryMeshRepeater = TelemetryMeshRepeater;
