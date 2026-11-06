/**
 * Detector de Timeout de Comunicação.
 * Monitora o recebimento de pacotes do ESP32-S3 e sinaliza estado offline
 * caso nenhuma leitura seja recebida por mais de 3 minutos (180.000 ms).
 */

class OfflineDetector {
  constructor(timeoutMs = 180000) {
    this.timeoutMs = timeoutMs;
    this.lastHeartbeat = Date.now();
    this.isOnline = false;
    this.onStatusChangeCallbacks = [];

    this.intervalId = setInterval(() => this.checkHealth(), 10000);
  }

  recordPacket() {
    this.lastHeartbeat = Date.now();
    if (!this.isOnline) {
      this.isOnline = true;
      this.notifyStatusChange(true);
    }
  }

  checkHealth() {
    const elapsed = Date.now() - this.lastHeartbeat;
    if (elapsed > this.timeoutMs && this.isOnline) {
      this.isOnline = false;
      console.warn(
        `[OFFLINE DETECTOR] Sem telemetria há ${Math.round(elapsed / 1000)} segundos.`
      );
      this.notifyStatusChange(false);
    }
  }

  onStatusChange(callback) {
    this.onStatusChangeCallbacks.push(callback);
  }

  notifyStatusChange(onlineState) {
    this.onStatusChangeCallbacks.forEach((cb) => cb(onlineState, this.lastHeartbeat));
  }

  getStatus() {
    return {
      online: this.isOnline,
      last_heartbeat: new Date(this.lastHeartbeat).toISOString(),
      seconds_since_last_packet: Math.round((Date.now() - this.lastHeartbeat) / 1000),
      timeout_threshold_seconds: this.timeoutMs / 1000
    };
  }
}

module.exports = new OfflineDetector();
