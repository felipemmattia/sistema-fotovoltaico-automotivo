/**
 * Gráfico histórico (Chart.js) com suporte a tema claro e escuro,
 * linha de referência de média em degrau neutro e destaque do pico e do ponto atual.
 */

const CHART_FONT_SANS = "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const CHART_FONT_MONO = "'IBM Plex Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace";

const CHART_METRICS = {
  pv_power: {
    label: 'Potência solar',
    unit: 'W',
    decimals: 1,
    colorVar: '--accent-chart',
    fill: true,
    min: 0
  },
  battery_voltage: {
    label: 'Tensão da bateria',
    unit: 'V',
    decimals: 2,
    colorVar: '--battery',
    fill: true,
    min: null
  },
  battery_soc: {
    label: 'Estado de carga',
    unit: '%',
    decimals: 0,
    colorVar: '--battery',
    fill: true,
    min: 0,
    max: 100
  }
};

class SolarChartManager {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.metric = 'pv_power';
    this.period = 'hours';
    this.history = [];
    this.peakIndex = -1;
    this.lastIndex = -1;
    this.chart = null;
    this.init();
  }

  css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  withAlpha(hex, alpha) {
    const h = hex.replace('#', '').trim();
    if (h.length !== 6) return hex;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  formatNum(val, decimals) {
    return Number(val).toLocaleString('pt-BR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  init() {
    const self = this;
    const ctx = this.canvas.getContext('2d');

    this.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Série principal',
            data: [],
            borderWidth: 2,
            tension: 0.3,
            spanGaps: true,
            pointRadius(context) {
              if (context.dataIndex === self.peakIndex) return 4.5;
              if (context.dataIndex === self.lastIndex) return 3.5;
              return 0;
            },
            pointHoverRadius: 5,
            pointBorderWidth: 1.75
          },
          {
            label: 'Média do período',
            data: [],
            borderWidth: 1,
            borderDash: [4, 4],
            pointRadius: 0,
            pointHoverRadius: 0,
            fill: false,
            tension: 0
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: {
          duration: 360,
          easing: 'easeOutQuart'
        },
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            displayColors: false,
            padding: 10,
            cornerRadius: 8,
            titleFont: { family: CHART_FONT_SANS, size: 12, weight: '500' },
            bodyFont: { family: CHART_FONT_MONO, size: 12, weight: '400' },
            filter(item) {
              return item.datasetIndex === 0;
            },
            callbacks: {
              label(context) {
                const m = CHART_METRICS[self.metric];
                const y = context.parsed.y;
                if (typeof y !== 'number') return '';
                const tag = context.dataIndex === self.peakIndex ? ' (pico)' : '';
                return `${m.label}: ${self.formatNum(y, m.decimals)} ${m.unit}${tag}`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: {
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 8,
              padding: 8,
              font: { family: CHART_FONT_MONO, size: 12 }
            }
          },
          y: {
            border: { display: false },
            ticks: {
              maxTicksLimit: 5,
              padding: 10,
              font: { family: CHART_FONT_MONO, size: 12 }
            }
          }
        }
      }
    });

    this.applyTheme();

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (this.chart) this.chart.update('none');
      });
    }
  }

  applyTheme() {
    const m = CHART_METRICS[this.metric];
    const line = this.css(m.colorVar) || '#f0a33c';
    const text3 = this.css('--text-3') || '#85858b';
    const hairline = this.css('--hairline') || 'rgba(128,128,128,0.12)';
    const hairlineStrong = this.css('--hairline-strong') || 'rgba(128,128,128,0.2)';
    const surface = this.css('--surface') || '#18181b';
    const text1 = this.css('--text-1') || '#ededed';

    const ctx = this.canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 300);
    grad.addColorStop(0, this.withAlpha(line, 0.22));
    grad.addColorStop(0.65, this.withAlpha(line, 0.05));
    grad.addColorStop(1, this.withAlpha(line, 0.0));

    const ds = this.chart.data.datasets[0];
    ds.borderColor = line;
    ds.pointBackgroundColor = (context) =>
      context.dataIndex === this.lastIndex ? line : surface;
    ds.pointBorderColor = line;
    ds.pointHoverBackgroundColor = line;
    ds.pointHoverBorderColor = surface;
    ds.fill = m.fill;
    ds.backgroundColor = m.fill ? grad : 'transparent';

    const avgDs = this.chart.data.datasets[1];
    avgDs.borderColor = hairlineStrong;

    const s = this.chart.options.scales;
    s.x.ticks.color = text3;
    s.y.ticks.color = text3;
    s.y.grid = { color: hairline, drawTicks: false };
    s.y.min = m.min === null ? undefined : m.min;
    s.y.max = m.max;
    s.y.ticks.callback = (v) => `${Number(v).toLocaleString('pt-BR')} ${m.unit}`;

    const tt = this.chart.options.plugins.tooltip;
    tt.backgroundColor = surface;
    tt.titleColor = text1;
    tt.bodyColor = text1;
    tt.borderColor = hairlineStrong;
    tt.borderWidth = 1;

    this.chart.update('none');
  }

  setMetric(metric) {
    if (!CHART_METRICS[metric]) return;
    this.metric = metric;
    this.render();
  }

  updateData(historyArray, period = 'hours') {
    this.period = period;
    this.history = Array.isArray(historyArray) ? historyArray : [];
    this.render();
  }

  formatLabel(date) {
    if (this.period === 'hours') {
      return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }
    if (this.period === 'days') {
      const day = date.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
      const hm = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      return `${day} ${hm}`;
    }
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }

  updateSummary(values) {
    const el = document.getElementById('chart-summary');
    if (!el) return;

    const valid = values.filter((v) => typeof v === 'number' && isFinite(v));
    if (valid.length === 0) {
      el.textContent = 'Sem leituras no período';
      return { avg: null };
    }

    const m = CHART_METRICS[this.metric];
    const last = valid[valid.length - 1];
    const max = Math.max(...valid);
    const min = Math.min(...valid);
    const avg = valid.reduce((a, b) => a + b, 0) / valid.length;

    if (this.metric === 'pv_power') {
      el.textContent = `${this.formatNum(last, m.decimals)} ${m.unit} agora · pico ${this.formatNum(max, m.decimals)} ${m.unit} · média ${this.formatNum(avg, m.decimals)} ${m.unit}`;
    } else {
      el.textContent = `${this.formatNum(last, m.decimals)} ${m.unit} agora · faixa ${this.formatNum(min, m.decimals)} a ${this.formatNum(max, m.decimals)} ${m.unit}`;
    }
    return { avg };
  }

  render() {
    const labels = [];
    const values = [];
    let maxVal = -Infinity;
    let maxIdx = -1;
    let lastValidIdx = -1;

    this.history.forEach((item, idx) => {
      const v = item[this.metric];
      const num = typeof v === 'number' && isFinite(v) ? v : null;
      labels.push(this.formatLabel(new Date(item.timestamp)));
      values.push(num);
      if (num !== null) {
        lastValidIdx = idx;
        if (num > maxVal) {
          maxVal = num;
          maxIdx = idx;
        }
      }
    });

    this.peakIndex = maxIdx;
    this.lastIndex = lastValidIdx;

    const { avg } = this.updateSummary(values);

    this.chart.data.labels = labels;
    this.chart.data.datasets[0].data = values;
    this.chart.data.datasets[1].data = avg !== null ? values.map(() => avg) : [];

    const empty = document.getElementById('chart-empty');
    if (empty) empty.hidden = values.length > 0;

    this.applyTheme();
  }
}
