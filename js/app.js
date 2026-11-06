/**
 * Telemetria FV — Controlador principal da interface web.
 * Gerencia comunicação via WebSocket e Rede Mesh P2P (WebRTC), interpolação de valores,
 * barra de estado de carga animada com partículas, diagnóstico de erros Modbus (0x3200–0x3202),
 * estimativa de tempo de recarga e sincronização dos modelos 3D e gráficos históricos.
 */

document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Registro do Service Worker para cache estático da interface
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  const urlTheme = new URLSearchParams(location.search).get('theme');
  if (urlTheme === 'light' || urlTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', urlTheme);
  }

  const nfCache = new Map();
  const nf = (decimals) => {
    if (!nfCache.has(decimals)) {
      nfCache.set(
        decimals,
        new Intl.NumberFormat('pt-BR', {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals
        })
      );
    }
    return nfCache.get(decimals);
  };

  const fmt = (value, decimals = 1) =>
    typeof value === 'number' && isFinite(value) ? nf(decimals).format(value) : '—';

  const setText = (id, text) => {
    const el = $(id);
    if (el && el.textContent !== text) el.textContent = text;
  };

  // Interpolação suave de números em atualizações ao vivo
  const tweenState = new Map();
  function setNumber(id, nextValue, decimals = 1, animate = true) {
    const el = $(id);
    if (!el) return;
    if (typeof nextValue !== 'number' || !isFinite(nextValue)) {
      const prev = tweenState.get(id);
      if (prev && prev.raf) cancelAnimationFrame(prev.raf);
      el.textContent = '—';
      tweenState.delete(id);
      return;
    }

    const prev = tweenState.get(id);
    if (!animate || reducedMotion || prev === undefined || Math.abs(prev.val - nextValue) < 1e-4) {
      if (prev && prev.raf) cancelAnimationFrame(prev.raf);
      el.textContent = nf(decimals).format(nextValue);
      tweenState.set(id, { val: nextValue, raf: 0 });
      return;
    }

    if (prev.raf) cancelAnimationFrame(prev.raf);
    const startVal = prev.val;
    const delta = nextValue - startVal;
    const duration = 360;
    const t0 = performance.now();

    const step = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const current = startVal + delta * eased;
      el.textContent = nf(decimals).format(current);
      if (p < 1) {
        const raf = requestAnimationFrame(step);
        tweenState.set(id, { val: current, raf });
      } else {
        el.textContent = nf(decimals).format(nextValue);
        tweenState.set(id, { val: nextValue, raf: 0 });
      }
    };

    const raf = requestAnimationFrame(step);
    tweenState.set(id, { val: startVal, raf });
  }

  const nowDate = new Date();
  setText(
    'today-label',
    nowDate.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' })
  );

  const state = {
    settings: {
      vehicle_name: '',
      battery_capacity_ah: 200,
      system_voltage: 12,
      solar_kwp: 0.45
    },
    latest: null,
    lastPacketAt: null,
    lastIntervals: [],
    period: 'hours',
    online: false,
    wsConnected: false
  };

  const chart = new SolarChartManager('solarGenerationChart');
  const models3d = window.StudioModels3D ? new window.StudioModels3D() : null;

  // ==========================================================================
  // Barra de Estado de Carga (Gradiente Dinâmico + Partículas E -> D)
  // ==========================================================================
  class SocBarAnimator {
    constructor(fillEl, canvasEl) {
      this.fillEl = fillEl;
      this.canvas = canvasEl;
      this.ctx = canvasEl ? canvasEl.getContext('2d') : null;
      this.soc = 0;
      this.powerW = 0;
      this.nominalWp = 450;
      this.online = false;
      this.particles = [];
      this.sheenX = -0.3;
      this.lastTime = performance.now();

      this.colorStops = [
        {
          at: 0,
          left: [255, 148, 148],
          mid: [239, 68, 68],
          right: [185, 28, 28],
          glow: [239, 68, 68]
        },
        {
          at: 22,
          left: [253, 164, 126],
          mid: [234, 88, 12],
          right: [194, 65, 12],
          glow: [234, 88, 12]
        },
        {
          at: 48,
          left: [253, 214, 118],
          mid: [234, 179, 8],
          right: [180, 118, 9],
          glow: [234, 179, 8]
        },
        {
          at: 74,
          left: [167, 243, 168],
          mid: [52, 211, 115],
          right: [22, 163, 74],
          glow: [34, 197, 94]
        },
        {
          at: 100,
          left: [134, 239, 172],
          mid: [34, 197, 94],
          right: [21, 128, 61],
          glow: [34, 197, 94]
        }
      ];

      if (this.canvas && this.ctx) {
        this.resize();
        window.addEventListener('resize', () => this.resize());
        if ('ResizeObserver' in window && this.fillEl) {
          const ro = new ResizeObserver(() => this.resize());
          ro.observe(this.fillEl);
        }
        requestAnimationFrame((t) => this.tick(t));
      }
    }

    lerpRgb(a, b, t) {
      return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t)
      ];
    }

    computeGradientColors(soc) {
      const clamped = Math.max(0, Math.min(100, soc));
      let s0 = this.colorStops[0];
      let s1 = this.colorStops[this.colorStops.length - 1];
      for (let i = 0; i < this.colorStops.length - 1; i++) {
        if (clamped >= this.colorStops[i].at && clamped <= this.colorStops[i + 1].at) {
          s0 = this.colorStops[i];
          s1 = this.colorStops[i + 1];
          break;
        }
      }
      const span = Math.max(1, s1.at - s0.at);
      const t = (clamped - s0.at) / span;
      return {
        left: this.lerpRgb(s0.left, s1.left, t),
        mid: this.lerpRgb(s0.mid, s1.mid, t),
        right: this.lerpRgb(s0.right, s1.right, t),
        glow: this.lerpRgb(s0.glow, s1.glow, t)
      };
    }

    updateState({ soc, powerW, nominalWp, online }) {
      if (typeof online === 'boolean') {
        this.online = online;
      }
      if (!this.online) {
        this.soc = 0;
        this.powerW = 0;
        this.particles = [];
      } else {
        this.soc = typeof soc === 'number' && isFinite(soc) ? Math.max(0, Math.min(100, soc)) : 0;
        this.powerW = typeof powerW === 'number' && isFinite(powerW) ? Math.max(0, powerW) : 0;
      }
      if (typeof nominalWp === 'number' && nominalWp > 0) {
        this.nominalWp = nominalWp;
      }

      if (!this.fillEl) return;
      this.fillEl.style.width = `${this.soc}%`;
      this.fillEl.classList.toggle('is-has-charge', this.online && this.soc > 0);

      if (this.soc > 0) {
        const c = this.computeGradientColors(this.soc);
        this.fillEl.style.background = `linear-gradient(90deg, rgb(${c.left.join(',')}) 0%, rgb(${c.mid.join(',')}) 52%, rgb(${c.right.join(',')}) 100%)`;
        this.fillEl.style.boxShadow = `inset 0 1px 0 rgba(255, 255, 255, 0.45), 0 0 10px rgba(${c.glow.join(',')}, 0.28)`;
      } else {
        this.fillEl.style.boxShadow = 'none';
      }
      this.resize();
    }

    resize() {
      if (!this.canvas || !this.fillEl) return;
      const rect = this.fillEl.getBoundingClientRect();
      const parentRect = this.fillEl.parentElement
        ? this.fillEl.parentElement.getBoundingClientRect()
        : rect;
      const targetCssW = Math.max(rect.width, (parentRect.width * this.soc) / 100);
      const targetCssH = Math.max(rect.height, parentRect.height || 16);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(targetCssW * dpr));
      const h = Math.max(1, Math.round(targetCssH * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      this.width = targetCssW;
      this.height = targetCssH;
      this.dpr = dpr;
    }

    spawnParticle(randomX = false) {
      const w = Math.max(32, this.width || 140);
      const h = Math.max(12, this.height || 16);
      const radius = 0.85 + Math.random() * 1.15;
      const yPos = h * (0.18 + Math.random() * 0.64);
      return {
        x: randomX ? Math.random() * w : -radius * 3 - Math.random() * 14,
        y: yPos,
        baseY: yPos,
        r: radius,
        speedMul: 0.72 + Math.random() * 0.68,
        alpha: 0.45 + Math.random() * 0.5,
        phase: Math.random() * Math.PI * 2,
        wobbleAmp: 0.35 + Math.random() * 0.85
      };
    }

    tick(now) {
      const dt = Math.min(0.05, Math.max(0.001, (now - this.lastTime) / 1000));
      this.lastTime = now;

      this.resize();

      if (this.ctx && this.width > 4 && this.height > 2 && this.online && this.soc > 0) {
        const ctx = this.ctx;
        ctx.save();
        ctx.scale(this.dpr, this.dpr);
        ctx.clearRect(0, 0, this.width, this.height);

        const isCharging = this.online && this.powerW > 0.25;
        const refWatts = Math.max(120, this.nominalWp * 0.65);
        const powerNorm = isCharging
          ? Math.min(1, Math.max(0.16, Math.pow(this.powerW / refWatts, 0.55)))
          : 0;

        const targetCount = isCharging ? Math.round(8 + powerNorm * 20) : 0;
        const baseSpeed = isCharging ? 24 + powerNorm * 120 : 6;

        while (this.particles.length < targetCount) {
          this.particles.push(this.spawnParticle(true));
        }

        if (isCharging && !reducedMotion) {
          this.sheenX += dt * (0.45 + powerNorm * 1.25);
          if (this.sheenX > 1.35) this.sheenX = -0.35;
          const sheenPx = this.sheenX * this.width;
          const sheenW = Math.max(28, this.width * 0.35);
          const sheenGrad = ctx.createLinearGradient(sheenPx - sheenW, 0, sheenPx + sheenW, 0);
          sheenGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
          sheenGrad.addColorStop(0.5, `rgba(255, 255, 255, ${(0.08 + powerNorm * 0.1).toFixed(3)})`);
          sheenGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
          ctx.fillStyle = sheenGrad;
          ctx.fillRect(0, 0, this.width, this.height);
        }

        for (let i = this.particles.length - 1; i >= 0; i--) {
          const p = this.particles[i];
          const stepSpeed = reducedMotion ? 0 : baseSpeed * p.speedMul;
          p.x += stepSpeed * dt;
          p.phase += dt * (2.2 + powerNorm * 3.0);
          p.y = p.baseY + Math.sin(p.phase) * p.wobbleAmp;

          if (!isCharging) {
            p.alpha -= dt * 0.8;
            if (p.alpha <= 0.02) {
              this.particles.splice(i, 1);
              continue;
            }
          } else if (p.x - p.r * 3 > this.width) {
            if (this.particles.length > targetCount) {
              this.particles.splice(i, 1);
              continue;
            } else {
              p.x = -p.r * 2.5 - Math.random() * 10;
              p.baseY = this.height * (0.18 + Math.random() * 0.64);
              p.alpha = 0.45 + Math.random() * 0.5;
            }
          }

          const glowR = p.r * 2.15;
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowR);
          g.addColorStop(0, `rgba(255, 255, 255, ${Math.min(1, p.alpha).toFixed(3)})`);
          g.addColorStop(0.35, `rgba(255, 255, 255, ${(p.alpha * 0.6).toFixed(3)})`);
          g.addColorStop(0.7, `rgba(255, 255, 255, ${(p.alpha * 0.18).toFixed(3)})`);
          g.addColorStop(1, 'rgba(255, 255, 255, 0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(p.x, p.y, glowR, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.restore();
      } else if (this.ctx && this.width > 0 && this.height > 0) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }

      requestAnimationFrame((t) => this.tick(t));
    }
  }

  const socAnimator = new SocBarAnimator($('soc-meter'), $('soc-particles'));

  // ==========================================================================
  // Diagnóstico de Erros / Alarmes da Controladora Epever (0x3200 / 0x3201 / 0x3202)
  // ==========================================================================
  function extractControllerAlerts(d, systemVoltage = 12) {
    if (!d) return [];
    const alerts = [];
    const seen = new Set();
    const pushAlert = (code, label, severity = 'error', register = '0x3200') => {
      if (!code || seen.has(code)) return;
      seen.add(code);
      alerts.push({ code, label, severity, register });
    };

    if (Array.isArray(d.controller_errors)) {
      for (const err of d.controller_errors) {
        if (typeof err === 'string' && err.trim()) {
          pushAlert(err.trim().toUpperCase(), err.trim(), 'error', '0x3200');
        } else if (err && typeof err === 'object' && err.label) {
          pushAlert(
            err.code || err.label.toUpperCase(),
            err.label,
            err.severity === 'warn' ? 'warn' : 'error',
            err.register || '0x3200'
          );
        }
      }
    }

    const batReg = typeof d.battery_status === 'number' ? d.battery_status & 0xffff : 0;
    const chgReg = typeof d.charging_status === 'number' ? d.charging_status & 0xffff : 0;
    const disReg = typeof d.discharging_status === 'number' ? d.discharging_status & 0xffff : 0;

    const voltBits = batReg & 0x000f;
    if (voltBits === 1) pushAlert('BAT_OVERVOLT', 'Sobretensão na bateria', 'error', '0x3200');
    else if (voltBits === 2) pushAlert('BAT_UNDERVOLT', 'Subtensão na bateria', 'warn', '0x3200');
    else if (voltBits === 3) pushAlert('BAT_LVD', 'Desconexão por descarga profunda (LVD)', 'error', '0x3200');
    else if (voltBits === 4) pushAlert('BAT_FAULT', 'Falha interna na bateria', 'error', '0x3200');

    const tempBits = (batReg >> 4) & 0x000f;
    if (tempBits === 1) pushAlert('BAT_OVERTEMP', 'Superaquecimento na bateria', 'error', '0x3200');
    else if (tempBits === 2) pushAlert('BAT_LOWTEMP', 'Temperatura baixa crítica na bateria', 'warn', '0x3200');

    if (batReg & 0x0100) pushAlert('BAT_INT_RES', 'Resistência interna anormal', 'warn', '0x3200');
    if (batReg & 0x8000) pushAlert('SYS_VOLT_ERR', 'Tensão nominal incorreta', 'error', '0x3200');

    const pvVoltBits = (chgReg >> 14) & 0x0003;
    if (pvVoltBits === 2) pushAlert('PV_OVERVOLT', 'Sobretensão na entrada FV', 'error', '0x3201');
    else if (pvVoltBits === 3) pushAlert('PV_VOLT_ERR', 'Erro de tensão nos painéis FV', 'error', '0x3201');

    if (chgReg & 0x2000) pushAlert('CHG_MOSFET_SHORT', 'MOSFET de carga em curto', 'error', '0x3201');
    if (chgReg & 0x1000) pushAlert('CHG_MOSFET_OPEN', 'MOSFET de carga aberto', 'error', '0x3201');
    if (chgReg & 0x0800) pushAlert('ANTIREV_MOSFET_SHORT', 'MOSFET anti-reverso em curto', 'error', '0x3201');
    if (chgReg & 0x0400) pushAlert('PV_OVERCURRENT', 'Sobrecorrente na entrada FV', 'error', '0x3201');
    if (chgReg & 0x0200) pushAlert('LOAD_OVERCURRENT', 'Sobrecorrente na saída de carga', 'error', '0x3201');
    if (chgReg & 0x0100) pushAlert('LOAD_SHORT', 'Curto-circuito na saída de carga', 'error', '0x3201');
    if (chgReg & 0x0080) pushAlert('LOAD_MOSFET_SHORT', 'MOSFET da saída em curto', 'error', '0x3201');
    if (chgReg & 0x0040) pushAlert('CIRCUIT_DISEQ', 'Desequilíbrio nos circuitos internos', 'warn', '0x3201');
    if (chgReg & 0x0010) pushAlert('PV_SHORT', 'Entrada FV em curto-circuito', 'error', '0x3201');
    if (chgReg & 0x0002) pushAlert('CTRL_FAULT', 'Falha na controladora MPPT', 'error', '0x3201');

    if (disReg & 0x0800) pushAlert('DIS_OUT_SHORT', 'Curto-circuito na descarga', 'error', '0x3202');
    if (disReg & 0x0020) pushAlert('BOOST_OVERVOLT', 'Sobretensão no estágio Boost', 'error', '0x3202');

    const scale = systemVoltage === 24 ? 2 : 1;
    if (typeof d.battery_voltage === 'number' && d.battery_voltage > 0.5) {
      if (d.battery_voltage >= 15.5 * scale) {
        pushAlert('BAT_OVERVOLT', 'Sobretensão na bateria', 'error', '0x3200');
      } else if (d.battery_voltage <= 10.6 * scale) {
        pushAlert('BAT_LVD', 'Subtensão crítica na bateria', 'error', '0x3200');
      } else if (d.battery_voltage <= 11.2 * scale) {
        pushAlert('BAT_UNDERVOLT', 'Subtensão na bateria', 'warn', '0x3200');
      }
    }
    if (typeof d.external_temp === 'number') {
      if (d.external_temp >= 50) {
        pushAlert('BAT_OVERTEMP', 'Superaquecimento na bateria', 'error', '0x3200');
      } else if (d.external_temp >= 44) {
        pushAlert('BAT_HIGHTEMP', 'Temperatura elevada na bateria', 'warn', '0x3200');
      } else if (d.external_temp <= -10) {
        pushAlert('BAT_LOWTEMP', 'Temperatura baixa crítica na bateria', 'warn', '0x3200');
      }
    }
    if (typeof d.pv_voltage === 'number' && d.pv_voltage >= 95) {
      pushAlert('PV_OVERVOLT', 'Sobretensão na entrada FV', 'error', '0x3201');
    }

    return alerts;
  }

  function renderControllerDiagnostics(d) {
    const pill = $('controller-diag-pill');
    const pillText = $('controller-diag-text');
    const banner = $('controller-alert-banner');
    const listEl = $('ctrl-alert-list');
    const titleEl = $('ctrl-alert-title');

    if (!state.online || !d) {
      if (pill) {
        pill.dataset.state = 'offline';
        pill.title = 'Controladora offline — sem comunicação Modbus ativa';
      }
      if (pillText) pillText.textContent = 'Controladora offline';
      if (banner) banner.hidden = true;
      return;
    }

    const alerts = extractControllerAlerts(d, state.settings.system_voltage || 12);

    if (!alerts.length) {
      if (pill) {
        pill.dataset.state = 'ok';
        pill.title = 'Registradores de alarme Epever (0x3200 · 0x3201 · 0x3202) sem falhas ativas';
      }
      if (pillText) pillText.textContent = 'Sem falhas na controladora';
      if (banner) banner.hidden = true;
      return;
    }

    const hasError = alerts.some((a) => a.severity === 'error');
    const topSeverity = hasError ? 'error' : 'warn';

    if (pill) {
      pill.dataset.state = topSeverity;
      pill.title = alerts.map((a) => `${a.register}: ${a.label}`).join(' | ');
    }
    if (pillText) {
      pillText.textContent =
        alerts.length === 1
          ? `Alerta: ${alerts[0].label}`
          : `${alerts.length} alertas: ${alerts[0].label}`;
    }

    if (banner && listEl) {
      banner.hidden = false;
      banner.dataset.severity = topSeverity;
      if (titleEl) {
        titleEl.textContent =
          alerts.length === 1
            ? 'Problema reportado pela controladora Epever XTRA 2210N'
            : `${alerts.length} problemas reportados pela controladora Epever XTRA 2210N`;
      }
      listEl.innerHTML = '';
      alerts.forEach((a) => {
        const chip = document.createElement('span');
        chip.className = 'ctrl-alert__chip';
        chip.dataset.severity = a.severity;
        const regSpan = document.createElement('span');
        regSpan.className = 'ctrl-alert__reg';
        regSpan.textContent = a.register || '0x3200';
        const lblSpan = document.createElement('span');
        lblSpan.textContent = a.label;
        chip.appendChild(regSpan);
        chip.appendChild(lblSpan);
        listEl.appendChild(chip);
      });
    }
  }

  // ==========================================================================
  // Limpeza completa quando Offline (nunca exibe valores falsos/antigos como ao vivo)
  // ==========================================================================
  function clearLiveReadings() {
    state.latest = null;
    try {
      localStorage.removeItem('solar_last_telemetry');
    } catch {}

    const numericIds = [
      'pv-power-val',
      'peak-power-val',
      'energy-today-val',
      'energy-total-val',
      'kpi-battery-voltage',
      'soc-val',
      'ext-temp-val',
      'pv-voltage-val',
      'pv-current-val',
      'pv-power-flow',
      'battery-voltage-val',
      'battery-current-val',
      'battery-power-val',
      'conduit-pv-a',
      'conduit-bat-a',
      'controller-load-val',
      'utilization-val',
      'stored-energy'
    ];
    numericIds.forEach((id) => setNumber(id, NaN, 1, false));

    setText('device-id', '—');
    setText('rssi-val', '—');
    setText('rssi-quality', '');
    setText('interval-val', '—');
    setText('charge-eta-val', '—');
    setText('charge-eta-sub', 'Controladora offline — aguardando conexão');

    setStateIndicator($('temp-status'), 'Offline', '');
    setStateIndicator($('charge-state'), 'Sem comunicação', 'bad');

    const wire1 = $('flow-link-1');
    const wire2 = $('flow-link-2');
    if (wire1) wire1.classList.remove('is-active');
    if (wire2) wire2.classList.remove('is-active');
    document.querySelectorAll('.node').forEach((node) => node.classList.remove('is-live'));

    socAnimator.updateState({
      soc: 0,
      powerW: 0,
      nominalWp: (state.settings.solar_kwp || 0.45) * 1000,
      online: false
    });

    if (models3d) {
      models3d.updateTelemetry({
        pvPower: 0,
        pvUtilization: 0,
        generating: false,
        soc: 0,
        voltage: 0,
        temp: -10,
        online: false
      });
    }

    renderControllerDiagnostics(null);
  }

  // ==========================================================================
  // Rede Mesh P2P de Retransmissão entre Navegadores
  // ==========================================================================
  const meshRepeater = window.TelemetryMeshRepeater
    ? new window.TelemetryMeshRepeater({
        onTelemetryRelay: (payload) => {
          if (!payload || payload.online === false) return;
          setOnline(true);
          if (!state.wsConnected) {
            setText('ws-state', 'Recebendo via Mesh P2P');
          }
          renderTelemetry(payload, true);
        },
        onSettingsRelay: (settings) => {
          applySettings(settings);
        },
        onTopologyChange: ({ totalNodes, directPeers }) => {
          if (totalNodes <= 1) {
            setText('mesh-state', 'Ativa · 1 nó repetidor');
          } else if (directPeers > 0) {
            setText('mesh-state', `Retransmitindo · ${totalNodes} nós (${directPeers} P2P)`);
          } else {
            setText('mesh-state', `Ativa · ${totalNodes} nós repetidores`);
          }
        }
      })
    : null;

  // ==========================================================================
  // Tema claro / escuro
  // ==========================================================================
  $('theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    chart.applyTheme();
    if (models3d) models3d.setTheme(next === 'dark');
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (localStorage.getItem('theme')) return;
    document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    chart.applyTheme();
    if (models3d) models3d.setTheme(e.matches);
  });

  // ==========================================================================
  // Conexão WebSocket e Sinalização P2P
  // ==========================================================================
  function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}`);

    if (meshRepeater) meshRepeater.attachSignalingSocket(ws);

    ws.onopen = () => {
      state.wsConnected = true;
      setText('ws-state', 'WebSocket ativo');
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'INIT_STATE':
          if (meshRepeater && msg.peer_id) {
            meshRepeater.setIdentity(msg.peer_id, msg.mesh_peers || []);
          }
          if (msg.payload.settings) applySettings(msg.payload.settings);
          setOnline(msg.payload.status ? msg.payload.status.online : false);
          if (state.online && msg.payload.latest) {
            renderTelemetry(msg.payload.latest, false);
            if (meshRepeater) meshRepeater.relayPacket('TELEMETRY', msg.payload.latest);
          } else {
            clearLiveReadings();
          }
          break;
        case 'TELEMETRY_LIVE':
          setOnline(msg.payload.online !== false);
          if (state.online) {
            renderTelemetry(msg.payload, true);
            if (meshRepeater) meshRepeater.relayPacket('TELEMETRY', msg.payload);
          } else {
            clearLiveReadings();
          }
          break;
        case 'STATUS_UPDATE':
          setOnline(msg.online);
          break;
        case 'SETTINGS_UPDATE':
          applySettings(msg.payload);
          if (meshRepeater) meshRepeater.relayPacket('SETTINGS', msg.payload);
          break;
        case 'MESH_TOPOLOGY':
          if (meshRepeater) meshRepeater.updateTopology(msg.peers || []);
          break;
        case 'SIGNAL_RELAY':
          if (meshRepeater) meshRepeater.handleSignal(msg.from, msg.signal);
          break;
        case 'MESH_RELAY_PACKET':
          if (msg.payload && msg.payload.online !== false) {
            setOnline(true);
            renderTelemetry(msg.payload, true);
          }
          break;
      }
    };

    ws.onclose = () => {
      state.wsConnected = false;
      const p2pCount = meshRepeater ? meshRepeater.getOpenPeerChannelsCount() : 0;
      setText('ws-state', p2pCount > 0 ? `Mesh P2P (${p2pCount} par)` : 'Reconectando');
      setTimeout(connectWebSocket, 3000);
    };
  }

  // ==========================================================================
  // Renderização das leituras e do esquemático
  // ==========================================================================
  function setStateIndicator(el, text, tone) {
    if (!el) return;
    el.textContent = text;
    if (tone) el.dataset.tone = tone;
    else delete el.dataset.tone;
  }

  function updateChargeState() {
    const chargeEl = $('charge-state');
    const d = state.latest;
    if (!state.online) {
      setStateIndicator(chargeEl, 'Sem comunicação', 'bad');
      return;
    }
    if (!d) {
      setStateIndicator(chargeEl, 'Aguardando leitura', '');
      return;
    }
    const generating = (d.pv_power || 0) > 0.5;
    const soc = typeof d.battery_soc === 'number' ? d.battery_soc : null;
    if (generating && d.charging_stage) {
      setStateIndicator(chargeEl, d.charging_stage, 'ok');
    } else if (generating && soc !== null && soc >= 100) {
      setStateIndicator(chargeEl, 'Flutuação', 'ok');
    } else if (generating) {
      setStateIndicator(chargeEl, 'Carregando', 'ok');
    } else {
      setStateIndicator(chargeEl, 'Em espera', '');
    }
  }

  function renderTelemetry(d, isLive) {
    if (!d || !state.online || d.online === false) {
      clearLiveReadings();
      return;
    }
    state.latest = d;

    const ts = new Date(d.timestamp || Date.now());
    if (isLive && state.lastPacketAt) {
      const delta = (ts - state.lastPacketAt) / 1000;
      if (delta > 0.2 && delta < 120) {
        state.lastIntervals.push(delta);
        if (state.lastIntervals.length > 5) state.lastIntervals.shift();
      }
    }
    state.lastPacketAt = ts;

    // 1. Cartões de leituras principais
    setNumber('pv-power-val', d.pv_power, 1, isLive);
    setNumber('peak-power-val', d.peak_pv_power, 1, isLive);
    setNumber('energy-today-val', d.energy_today, 2, isLive);
    setNumber('energy-total-val', d.energy_total, 2, isLive);
    setNumber('kpi-battery-voltage', d.battery_voltage, 2, isLive);

    const soc =
      typeof d.battery_soc === 'number' ? Math.max(0, Math.min(100, d.battery_soc)) : null;
    setNumber('soc-val', soc === null ? NaN : Math.round(soc), 0, isLive);

    const activePower = Math.max(d.pv_power || 0, d.battery_power || 0);
    socAnimator.updateState({
      soc: soc === null ? 0 : soc,
      powerW: activePower,
      nominalWp: (state.settings.solar_kwp || 0.45) * 1000,
      online: true
    });

    // Temperatura da bateria (sensor NTC externo)
    setNumber('ext-temp-val', d.external_temp, 1, isLive);
    const t = d.external_temp;
    const tempEl = $('temp-status');
    if (typeof t !== 'number') {
      setStateIndicator(tempEl, 'Sem leitura', '');
    } else if (t >= 50 || t <= -10) {
      setStateIndicator(tempEl, 'Crítica', 'bad');
    } else if (t >= 40 || t <= 0) {
      setStateIndicator(tempEl, 'Atenção', 'warn');
    } else {
      setStateIndicator(tempEl, 'Normal', 'ok');
    }

    renderControllerDiagnostics(d);

    // 2. Esquemático de conversão fotovoltaica
    setNumber('pv-voltage-val', d.pv_voltage, 2, isLive);
    setNumber('pv-current-val', d.pv_current, 2, isLive);
    setNumber('pv-power-flow', d.pv_power, 1, isLive);
    setNumber('battery-voltage-val', d.battery_voltage, 2, isLive);
    setNumber('battery-current-val', d.battery_current, 2, isLive);
    setNumber('battery-power-val', d.battery_power, 1, isLive);
    setNumber('conduit-pv-a', d.pv_current || 0, 2, isLive);
    setNumber('conduit-bat-a', d.battery_current || 0, 2, isLive);

    const controllerLoad =
      typeof d.battery_current === 'number' ? Math.min(100, (d.battery_current / 20) * 100) : null;
    setNumber('controller-load-val', controllerLoad, 1, isLive);

    const generating = state.online && (d.pv_power || 0) > 0.5;
    const charging = generating && (d.battery_current || 0) > 0.02;

    const wire1 = $('flow-link-1');
    const wire2 = $('flow-link-2');
    const pvSpeed = Math.max(0.45, Math.min(1.5, 1.35 - (d.pv_current || 0) * 0.12));
    const batSpeed = Math.max(0.45, Math.min(1.5, 1.35 - (d.battery_current || 0) * 0.08));

    if (wire1) {
      wire1.style.setProperty('--flow-duration', `${pvSpeed.toFixed(2)}s`);
      wire1.classList.toggle('is-active', generating);
    }
    if (wire2) {
      wire2.style.setProperty('--flow-duration', `${batSpeed.toFixed(2)}s`);
      wire2.classList.toggle('is-active', charging);
    }

    document.querySelectorAll('.node').forEach((node) => {
      const kind = node.dataset.kind;
      if (kind === 'pv') node.classList.toggle('is-live', generating);
      else if (kind === 'mppt') node.classList.toggle('is-live', generating);
      else if (kind === 'battery') node.classList.toggle('is-live', state.online && soc !== null);
    });

    updateChargeState();

    // 3. Especificações e telemetria do sistema
    setText('device-id', d.device_id || '—');
    if (typeof d.wifi_rssi === 'number') {
      setText('rssi-val', `${d.wifi_rssi} dBm`);
      const q = d.wifi_rssi >= -55 ? 'forte' : d.wifi_rssi >= -70 ? 'bom' : 'fraco';
      setText('rssi-quality', `· ${q}`);
    }
    if (state.lastIntervals.length) {
      const avg =
        state.lastIntervals.reduce((a, b) => a + b, 0) / state.lastIntervals.length;
      setText('interval-val', `${nf(1).format(avg)} s`);
    } else if (typeof d.wifi_rssi === 'number') {
      const targetSec = d.wifi_rssi >= -55 ? 1 : d.wifi_rssi >= -70 ? 2 : 5;
      setText('interval-val', `${targetSec},0 s`);
    }

    renderDerived(isLive);
    updateRelativeTime();
  }

  function formatChargeDuration(hours) {
    if (!isFinite(hours) || hours <= 0) return '< 1 min';
    const totalMinutes = Math.round(hours * 60);
    if (totalMinutes < 1) return '< 1 min';
    if (totalMinutes < 60) return `${totalMinutes} min`;
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    if (h >= 100) return `~${h} h`;
    return m > 0 ? `${h} h ${m} min` : `${h} h`;
  }

  function renderDerived(isLive = false) {
    const s = state.settings;
    const d = state.latest;
    const wp = (s.solar_kwp || 0) * 1000;

    setText('nominal-wp', wp ? fmt(wp, 0) : '—');
    setText('header-wp-label', wp ? `${fmt(wp, 0)} Wp` : '—');
    setText('capacity-val', s.battery_capacity_ah ? fmt(s.battery_capacity_ah, 0) : '—');
    setText('system-voltage-val', s.system_voltage ? String(s.system_voltage) : '—');

    if (!state.online || !d) return;

    const utilization =
      wp && typeof d.pv_power === 'number' ? Math.min(100, (d.pv_power / wp) * 100) : null;
    setNumber('utilization-val', utilization, 1, isLive);

    if (models3d) {
      models3d.updateTelemetry({
        pvPower: typeof d.pv_power === 'number' ? d.pv_power : 0,
        pvUtilization: utilization || 0,
        generating: state.online && (d.pv_power || 0) > 0.5,
        soc: typeof d.battery_soc === 'number' ? d.battery_soc : 0,
        voltage: typeof d.battery_voltage === 'number' ? d.battery_voltage : 12,
        temp: typeof d.external_temp === 'number' ? d.external_temp : 25,
        online: true
      });
    }

    const totalCapacityWh =
      s.battery_capacity_ah && s.system_voltage
        ? s.battery_capacity_ah * s.system_voltage
        : null;
    const soc =
      typeof d.battery_soc === 'number' ? Math.max(0, Math.min(100, d.battery_soc)) : null;

    const stored =
      totalCapacityWh !== null && soc !== null ? totalCapacityWh * (soc / 100) : null;
    setNumber('stored-energy', stored, 0, isLive);

    const genPowerW = Math.max(d.pv_power || 0, d.battery_power || 0);
    if (totalCapacityWh === null || soc === null) {
      setText('charge-eta-val', '—');
      setText('charge-eta-sub', 'Aguardando leitura da bateria');
    } else if (soc >= 100) {
      setText('charge-eta-val', 'Carga completa');
      setText('charge-eta-sub', `Banco em 100% (${fmt(totalCapacityWh, 0)} Wh)`);
    } else {
      const remainingWh = Math.max(0, totalCapacityWh - (stored || 0));
      if (genPowerW <= 0.5) {
        setText('charge-eta-val', 'Aguardando geração');
        setText('charge-eta-sub', `Faltam ${fmt(remainingWh, 0)} Wh para 100%`);
      } else {
        const hoursToFull = remainingWh / genPowerW;
        setText('charge-eta-val', formatChargeDuration(hoursToFull));
        setText(
          'charge-eta-sub',
          `Faltam ${fmt(remainingWh, 0)} Wh · gerando ${fmt(genPowerW, 1)} W`
        );
      }
    }

    socAnimator.updateState({
      soc: soc === null ? 0 : soc,
      powerW: genPowerW,
      nominalWp: wp || 450,
      online: true
    });
    renderControllerDiagnostics(d);
  }

  function setOnline(isOnline) {
    const nextOnline = Boolean(isOnline);
    const wasOnline = state.online;
    state.online = nextOnline;

    const badge = $('status-badge');
    if (badge) badge.dataset.state = state.online ? 'online' : 'offline';
    setText('status-text', state.online ? 'Online' : 'Offline');

    if (!state.online) {
      clearLiveReadings();
    } else if (!wasOnline && state.latest) {
      renderTelemetry(state.latest, false);
    }
    updateRelativeTime();
  }

  function updateRelativeTime() {
    if (!state.online && !state.lastPacketAt) {
      setText('last-update-text', 'Sem comunicação');
      return;
    }
    if (!state.lastPacketAt) {
      setText('last-update-text', 'Sem dados');
      return;
    }
    const s = Math.max(0, Math.round((Date.now() - state.lastPacketAt.getTime()) / 1000));
    let text;
    if (s < 3) text = 'Atualizado agora';
    else if (s < 60) text = `Atualizado há ${s} s`;
    else if (s < 3600) text = `Atualizado há ${Math.floor(s / 60)} min`;
    else {
      const hm = state.lastPacketAt.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit'
      });
      text = `Último pacote às ${hm}`;
    }
    setText('last-update-text', text);
  }
  setInterval(updateRelativeTime, 1000);

  // ==========================================================================
  // Diálogo de configuração do sistema
  // ==========================================================================
  function applySettings(settings) {
    if (!settings) return;
    state.settings = { ...state.settings, ...settings };
    try {
      localStorage.setItem('solar_last_settings', JSON.stringify(state.settings));
    } catch {}
    setText('vehicle-name-display', state.settings.vehicle_name || 'Veículo monitorado');
    document.title = state.settings.vehicle_name
      ? `${state.settings.vehicle_name} — Telemetria FV`
      : 'Telemetria FV';
    renderDerived(false);
  }

  const dialog = $('vehicle-modal');

  function closeModalAnimated() {
    if (!dialog || !dialog.open) return;
    if (reducedMotion) {
      dialog.close();
      return;
    }
    dialog.classList.add('is-closing');
    setTimeout(() => {
      dialog.classList.remove('is-closing');
      dialog.close();
    }, 165);
  }

  $('btn-edit-vehicle').addEventListener('click', () => {
    const s = state.settings;
    $('input-vehicle-name').value = s.vehicle_name || '';
    $('input-capacity').value = s.battery_capacity_ah || '';
    $('input-system-voltage').value = String(s.system_voltage || 12);
    $('input-wp').value = s.solar_kwp ? Math.round(s.solar_kwp * 1000) : '';
    dialog.classList.remove('is-closing');
    dialog.showModal();
  });

  $('btn-close-modal').addEventListener('click', closeModalAnimated);
  $('btn-cancel-vehicle').addEventListener('click', closeModalAnimated);

  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) closeModalAnimated();
  });

  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('input-vehicle-name').value.trim();
    if (!name) return;

    const body = {
      vehicle_name: name,
      system_voltage: Number($('input-system-voltage').value)
    };
    const cap = Number($('input-capacity').value);
    const wp = Number($('input-wp').value);
    if (cap > 0) body.battery_capacity_ah = cap;
    if (wp > 0) body.solar_kwp = wp / 1000;

    const saveBtn = $('btn-save-vehicle');
    saveBtn.disabled = true;
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.success) {
        applySettings(data.data);
        closeModalAnimated();
      } else {
        alert('Não foi possível salvar: ' + (data.error || 'erro desconhecido'));
      }
    } catch (err) {
      alert('Erro ao salvar configurações: ' + err.message);
    } finally {
      saveBtn.disabled = false;
    }
  });

  // ==========================================================================
  // Histórico (amostragem minuto a minuto, atualizado a cada 60 s)
  // ==========================================================================
  const CHART_SUBTITLES = {
    hours: 'Últimas 24 h · pontos de 1 min · linha tracejada indica a média do período',
    days: 'Últimos 7 dias · pontos de 10 min · linha tracejada indica a média do período',
    weeks: 'Últimos 30 dias · pontos de 30 min · linha tracejada indica a média do período'
  };

  function pulseChartTransition() {
    if (reducedMotion) return;
    const box = $('chart-box');
    const sum = $('chart-summary');
    if (box) box.classList.add('is-switching');
    if (sum) sum.classList.add('is-switching');
    setTimeout(() => {
      if (box) box.classList.remove('is-switching');
      if (sum) sum.classList.remove('is-switching');
    }, 180);
  }

  async function fetchHistory(period) {
    state.period = period;
    setText('chart-sub', CHART_SUBTITLES[period] || '');
    try {
      const res = await fetch(`/api/telemetry/history?period=${period}`);
      const result = await res.json();
      if (result.success) chart.updateData(result.data, period);
    } catch (err) {
      console.error('[HISTÓRICO]', err);
    }
  }

  function updateSegmentedGlider(segmentedEl) {
    if (!segmentedEl) return;
    const glider = segmentedEl.querySelector('.segmented__glider');
    const active = segmentedEl.querySelector('.segmented__btn.is-active');
    if (!glider || !active) return;
    glider.style.width = `${active.offsetWidth}px`;
    glider.style.transform = `translateX(${active.offsetLeft}px)`;
    segmentedEl.classList.add('has-glider');
  }

  function syncAllGliders() {
    document.querySelectorAll('.segmented').forEach(updateSegmentedGlider);
  }

  function bindSegmented(attr, onSelect) {
    const buttons = document.querySelectorAll(`.segmented__btn[data-${attr}]`);
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('is-active')) return;
        buttons.forEach((b) => {
          b.classList.remove('is-active');
          b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('is-active');
        btn.setAttribute('aria-pressed', 'true');
        updateSegmentedGlider(btn.closest('.segmented'));
        pulseChartTransition();
        onSelect(btn.dataset[attr]);
      });
    });
  }

  bindSegmented('period', fetchHistory);
  bindSegmented('metric', (m) => chart.setMetric(m));
  syncAllGliders();
  requestAnimationFrame(() => setTimeout(syncAllGliders, 80));
  window.addEventListener('resize', syncAllGliders);
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(syncAllGliders);
    document.querySelectorAll('.segmented, .segmented__btn').forEach((el) => ro.observe(el));
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(syncAllGliders).catch(() => {});
  }

  // Inicializa em estado Offline limpo (sem exibir valores antigos/falsos como atuais)
  clearLiveReadings();

  fetch('/api/telemetry/latest')
    .then((r) => r.json())
    .then((r) => {
      if (!r.success) return;
      if (r.vehicle_name && !state.settings.vehicle_name) {
        applySettings({ vehicle_name: r.vehicle_name });
      }
      const isOnline = r.status ? Boolean(r.status.online) : false;
      setOnline(isOnline);
      if (isOnline && r.data && !state.latest) {
        renderTelemetry(r.data, false);
      }
    })
    .catch(() => {});

  fetch('/api/settings')
    .then((r) => r.json())
    .then((r) => r.success && applySettings(r.data))
    .catch(() => {});

  connectWebSocket();
  fetchHistory('hours');
  setInterval(() => fetchHistory(state.period), 60000);
});
