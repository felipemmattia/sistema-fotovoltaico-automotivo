/**
 * Telemetria FV — Renderizador 3D PBR (Metodologia vgpu) + Background Arquitetônico 3D.
 *
 * 1. SolarArchitecturalBackground (#graphite-bg-canvas):
 *    Campo topográfico 3D contínuo de irradiância solar com iluminação física PBR (GGX + Schlick),
 *    curvas de nível (isolinhas) anti-aliased por gradiente analítico e grade de precisão CAD
 *    com miras de calibração (+) que reagem suavemente ao fluxo energético e ao cursor.
 *
 * 2. StudioModels3D (#canvas-pv, #canvas-soc, #canvas-temp):
 *    Modelagem SDF com montagem estrutural contínua (shape-and-assembly),
 *    supersampling 2x nas bordas (RGSS AA) e sombreamento físico PBR
 *    (Smith-GGX Correlated + Fresnel Schlick + Clearcoat + IBL):
 *      - #canvas-pv:   Placa solar 3D sobre pedestal e Sol 3D virados na diagonal
 *                      olhando para a esquerda (alinhados à bateria e ao termômetro);
 *                      brilho do sol reage à potência solar gerada.
 *      - #canvas-soc:  Bateria automotiva 3D com alça, polos (+ / -) e raio 3D
 *                      frontal que se preenche conforme o estado de carga (SOC %).
 *      - #canvas-temp: Termômetro 3D em cápsula com escala °C cuja coluna líquida
 *                      e cor reagem à temperatura real do sensor NTC.
 */

class SolarArchitecturalBackground {
  constructor(canvasId = 'graphite-bg-canvas') {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;

    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.dark = document.documentElement.getAttribute('data-theme') === 'dark';
    this.smoothDark = this.dark ? 1.0 : 0.0;
    this.energy = 0.25;
    this.smoothEnergy = 0.25;
    this.mouseX = 0.0;
    this.mouseY = 0.0;
    this.targetMouseX = 0.0;
    this.targetMouseY = 0.0;

    this.gl =
      this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false }) ||
      this.canvas.getContext('webgl', { alpha: false, antialias: false, depth: false });

    if (!this.gl || !this.initShader()) return;

    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener(
      'pointermove',
      (e) => {
        this.targetMouseX = (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1;
        this.targetMouseY = -((e.clientY / Math.max(1, window.innerHeight)) * 2 - 1);
      },
      { passive: true }
    );
  }

  setTheme(isDark) {
    this.dark = Boolean(isDark);
  }

  setEnergyLevel(level) {
    this.energy = Math.max(0.15, Math.min(1.0, level));
  }

  resize() {
    if (!this.canvas || !this.gl) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    const w = Math.max(1, Math.round(window.innerWidth * dpr));
    const h = Math.max(1, Math.round(window.innerHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.gl.viewport(0, 0, w, h);
    }
  }

  initShader() {
    const gl = this.gl;
    const vsSource = `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main() {
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;

    const fsSource = `
      precision highp float;
      varying vec2 v_uv;

      uniform vec2 u_res;
      uniform float u_time;
      uniform float u_dark;
      uniform float u_energy;
      uniform vec2 u_mouse;

      // Campo de elevação 3D harmônico contínuo (ondas suaves de irradiância solar sem ruído granular)
      float elevationField(vec2 p, float t) {
        vec2 q = p * 1.35;
        q += 0.26 * vec2(
          sin(q.y * 1.55 + t * 0.28),
          cos(q.x * 1.40 - t * 0.23)
        );
        q += 0.13 * vec2(
          cos(q.y * 2.70 - t * 0.20 + q.x * 0.8),
          sin(q.x * 2.40 + t * 0.25 - q.y * 0.7)
        );
        float w1 = sin(q.x * 1.65 + q.y * 1.05 + t * 0.22);
        float w2 = cos(q.x * 1.05 - q.y * 1.75 - t * 0.17);
        float w3 = sin((q.x - q.y) * 1.25 + t * 0.14);
        return (w1 * 0.42 + w2 * 0.38 + w3 * 0.20);
      }

      float D_GGX_Bg(float NdotH, float roughness) {
        float a = roughness * roughness;
        float a2 = a * a;
        float d = (NdotH * NdotH) * (a2 - 1.0) + 1.0;
        return a2 / (3.14159265 * d * d + 1e-5);
      }

      void main() {
        vec2 uv = gl_FragCoord.xy / u_res;
        float aspect = u_res.x / max(u_res.y, 1.0);
        vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);

        float t = u_time * 0.85;
        vec2 parallax = u_mouse * 0.035;
        vec2 wp = p - parallax;

        // 1. Amostragem do relevo 3D e cálculo de normal analítica por diferenças centrais (vgpu PBR)
        const float eps = 0.0035;
        float hC = elevationField(wp, t);
        float hR = elevationField(wp + vec2(eps, 0.0), t);
        float hL = elevationField(wp - vec2(eps, 0.0), t);
        float hU = elevationField(wp + vec2(0.0, eps), t);
        float hD = elevationField(wp - vec2(0.0, eps), t);

        vec2 grad = vec2(hR - hL, hU - hD) / (2.0 * eps);
        float gradMag = length(grad);
        vec3 N = normalize(vec3(-grad * 0.14, 1.0));
        vec3 V = normalize(vec3(-p * 0.25, 1.0));

        // 2. Duas fontes de luz física PBR (Âmbar Solar à esquerda/topo e Verde-Teal Bateria à direita)
        vec3 sunLightPos = vec3(-0.48 + u_mouse.x * 0.22 + sin(t * 0.3) * 0.12, 0.38 + u_mouse.y * 0.16, 0.75);
        vec3 batLightPos = vec3( 0.52 - u_mouse.x * 0.18 + cos(t * 0.25) * 0.10, -0.18 - u_mouse.y * 0.12, 0.80);

        vec3 L1 = normalize(sunLightPos - vec3(p, 0.0));
        vec3 L2 = normalize(batLightPos - vec3(p, 0.0));
        vec3 H1 = normalize(L1 + V);
        vec3 H2 = normalize(L2 + V);

        float spec1 = min(D_GGX_Bg(max(dot(N, H1), 0.0), 0.52) * max(dot(N, L1), 0.0), 1.25);
        float spec2 = min(D_GGX_Bg(max(dot(N, H2), 0.0), 0.54) * max(dot(N, L2), 0.0), 1.25);

        float distSun = length(p - sunLightPos.xy);
        float distBat = length(p - batLightPos.xy);
        float atten1 = exp(-distSun * distSun * 1.35);
        float atten2 = exp(-distBat * distBat * 1.45);

        // 3. Curvas de nível topográficas (isolinhas de irradiância) com espessura constante anti-aliased
        float isoFreq = 3.8;
        float isoVal = hC * isoFreq;
        float isoFract = abs(fract(isoVal - 0.5) - 0.5);
        float pixelScale = 1.35 / min(u_res.x, u_res.y);
        float isoDistWorld = isoFract / max(gradMag * isoFreq, 0.65);
        float isoline = 1.0 - smoothstep(pixelScale * 0.4, pixelScale * 1.9, isoDistWorld);

        // Sub-isolinhas secundárias mais sutis
        float subIsoFract = abs(fract(isoVal * 2.0 - 0.5) - 0.5);
        float subIsoDist = subIsoFract / max(gradMag * isoFreq * 2.0, 1.1);
        float subIsoline = (1.0 - smoothstep(pixelScale * 0.3, pixelScale * 1.6, subIsoDist)) * 0.32;
        float contourMask = max(isoline, subIsoline);

        // 4. Grade arquitetônica de engenharia CAD com miras (+) nos vértices
        float gridSize = 0.115;
        vec2 gUv = (p - parallax * 0.4) / gridSize;
        vec2 gCell = abs(fract(gUv - 0.5) - 0.5) * gridSize;
        float lineX = 1.0 - smoothstep(pixelScale * 0.3, pixelScale * 1.4, gCell.x);
        float lineY = 1.0 - smoothstep(pixelScale * 0.3, pixelScale * 1.4, gCell.y);
        float baseGrid = max(lineX, lineY);

        // Miras (+) apenas nos cruzamentos da grade
        float crossArm = 1.0 - smoothstep(0.008, 0.011, min(max(gCell.x, gCell.y), 0.015));
        float crossMask = baseGrid * (1.0 - smoothstep(0.007, 0.010, max(gCell.x, gCell.y)));

        // Máscara de revelação espacial (grade e curvas brilham onde a luz ou o cursor incidem)
        float cursorGlow = exp(-dot(p - u_mouse * 0.45, p - u_mouse * 0.45) * 4.2);
        float waveCrest = smoothstep(0.15, 0.95, spec1 * 0.45 + spec2 * 0.40);
        float reveal = clamp(0.18 + atten1 * 0.55 + atten2 * 0.45 + cursorGlow * 0.45 + waveCrest * 0.35, 0.0, 1.0);

        // Cores semânticas do sistema (Âmbar Solar + Teal Bateria + Prata Arquitetônico)
        vec3 amberDark = vec3(0.94, 0.64, 0.24);
        vec3 tealDark  = vec3(0.24, 0.77, 0.71);
        vec3 slateSilver = vec3(0.56, 0.60, 0.68);

        vec3 accentBlend = mix(
          slateSilver,
          mix(amberDark, tealDark, smoothstep(-0.35, 0.45, p.x)),
          0.62
        );

        // ==================== Composição Dark Mode ====================
        vec3 darkBgBase = vec3(0.067, 0.071, 0.082);
        vec3 darkBgDeep = vec3(0.048, 0.050, 0.058);
        float vig = smoothstep(1.18, 0.20, length(p * vec2(0.85, 1.05)));
        vec3 darkCol = mix(darkBgDeep, darkBgBase, vig);

        // Iluminação volumétrica suave das ondas 3D
        darkCol += amberDark * (atten1 * 0.055 + spec1 * atten1 * 0.042) * (0.75 + 0.25 * u_energy);
        darkCol += tealDark  * (atten2 * 0.048 + spec2 * atten2 * 0.036);

        // Grade CAD sutil + miras (+) nos cruzamentos
        darkCol += mix(vec3(0.22, 0.24, 0.28), accentBlend, 0.35) * baseGrid * reveal * 0.14;
        darkCol += accentBlend * crossMask * reveal * 0.34;

        // Curvas de nível topográficas iluminadas pelas cristas PBR
        float isoHighlight = reveal * (0.32 + 0.68 * clamp(spec1 * 0.6 + spec2 * 0.5, 0.0, 1.0));
        darkCol += accentBlend * contourMask * isoHighlight * 0.32;

        // ==================== Composição Light Mode ====================
        vec3 lightBgBase = vec3(0.962, 0.965, 0.974);
        vec3 lightBgEdge = vec3(0.925, 0.930, 0.944);
        vec3 lightCol = mix(lightBgEdge, lightBgBase, vig);

        vec3 amberLight = vec3(0.76, 0.38, 0.04);
        vec3 tealLight  = vec3(0.06, 0.46, 0.43);
        vec3 lightAccent = mix(
          vec3(0.38, 0.42, 0.50),
          mix(amberLight, tealLight, smoothstep(-0.35, 0.45, p.x)),
          0.58
        );

        lightCol += amberLight * (atten1 * 0.032 + spec1 * atten1 * 0.025);
        lightCol += tealLight  * (atten2 * 0.028 + spec2 * atten2 * 0.022);
        lightCol -= vec3(0.18, 0.20, 0.25) * baseGrid * reveal * 0.09;
        lightCol -= lightAccent * crossMask * reveal * 0.22;
        lightCol = mix(lightCol, lightCol - lightAccent * 0.18, contourMask * isoHighlight * 0.65);

        vec3 finalCol = mix(lightCol, darkCol, u_dark);
        gl_FragColor = vec4(clamp(finalCol, 0.0, 1.0), 1.0);
      }
    `;

    const vs = this.compile(gl, gl.VERTEX_SHADER, vsSource);
    const fs = this.compile(gl, gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return false;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    this.program = prog;
    this.buffer = buf;
    this.aPos = aPos;
    this.uniforms = {
      res: gl.getUniformLocation(prog, 'u_res'),
      time: gl.getUniformLocation(prog, 'u_time'),
      dark: gl.getUniformLocation(prog, 'u_dark'),
      energy: gl.getUniformLocation(prog, 'u_energy'),
      mouse: gl.getUniformLocation(prog, 'u_mouse')
    };
    return true;
  }

  compile(gl, type, source) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('[SolarArchitecturalBg] Erro GLSL:', gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  render(timeSec) {
    if (!this.gl || !this.program) return;
    const gl = this.gl;

    const targetDark = this.dark ? 1.0 : 0.0;
    this.smoothDark += (targetDark - this.smoothDark) * 0.14;
    this.smoothEnergy += (this.energy - this.smoothEnergy) * 0.08;
    this.mouseX += (this.targetMouseX - this.mouseX) * 0.06;
    this.mouseY += (this.targetMouseY - this.mouseY) * 0.06;

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(this.uniforms.res, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uniforms.time, this.reducedMotion ? 0.0 : timeSec);
    gl.uniform1f(this.uniforms.dark, this.smoothDark);
    gl.uniform1f(this.uniforms.energy, this.smoothEnergy);
    gl.uniform2f(this.uniforms.mouse, this.mouseX, this.mouseY);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}

class StudioModels3D {
  constructor() {
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.scenes = [];
    this.rafId = 0;
    this.bg = new SolarArchitecturalBackground('graphite-bg-canvas');

    this.state = {
      pvPower: 0,
      pvUtilization: 0,
      generating: false,
      soc: 0,
      voltage: 0,
      temp: -10,
      online: false,
      dark: document.documentElement.getAttribute('data-theme') === 'dark'
    };

    this.init();
  }

  init() {
    const configs = [
      { id: 'canvas-pv', cardId: 'card-pv', kind: 0 },
      { id: 'canvas-soc', cardId: 'card-soc', kind: 1 },
      { id: 'canvas-temp', cardId: 'card-temp', kind: 2 }
    ];

    configs.forEach((cfg) => {
      const canvas = document.getElementById(cfg.id);
      const card = document.getElementById(cfg.cardId);
      if (!canvas) return;

      const scene = this.createScene(canvas, card, cfg.kind);
      if (scene) this.scenes.push(scene);
    });

    if ('IntersectionObserver' in window) {
      this.io = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            const sc = this.scenes.find((s) => s.canvas === entry.target);
            if (sc) sc.visible = entry.isIntersecting;
          });
        },
        { threshold: 0.05 }
      );
      this.scenes.forEach((s) => this.io.observe(s.canvas));
    }

    window.addEventListener('resize', () => {
      this.scenes.forEach((s) => this.resizeScene(s));
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !this.rafId) {
        this.rafId = requestAnimationFrame((t) => this.loop(t));
      }
    });

    this.wake();
  }

  wake() {
    if (!this.rafId) {
      this.rafId = requestAnimationFrame((t) => this.loop(t));
    }
  }

  setTheme(isDark) {
    this.state.dark = Boolean(isDark);
    if (this.bg) this.bg.setTheme(this.state.dark);
    this.wake();
  }

  updateTelemetry(data) {
    if (!data) return;
    if (typeof data.pvPower === 'number' && isFinite(data.pvPower)) {
      this.state.pvPower = Math.max(0, data.pvPower);
    }
    if (typeof data.pvUtilization === 'number' && isFinite(data.pvUtilization)) {
      this.state.pvUtilization = Math.max(0, Math.min(100, data.pvUtilization));
    }
    if (typeof data.generating === 'boolean') {
      this.state.generating = data.generating;
    }
    if (typeof data.soc === 'number' && isFinite(data.soc)) {
      this.state.soc = Math.max(0, Math.min(100, data.soc));
    }
    if (typeof data.voltage === 'number' && isFinite(data.voltage)) {
      this.state.voltage = data.voltage;
    }
    if (typeof data.temp === 'number' && isFinite(data.temp)) {
      this.state.temp = Math.max(-10, Math.min(70, data.temp));
    }
    if (typeof data.online === 'boolean') {
      this.state.online = data.online;
    }
    this.wake();
  }

  createScene(canvas, card, kind) {
    const gl =
      canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true }) ||
      canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true });

    const scene = {
      canvas,
      card,
      kind,
      gl,
      ctx2d: gl ? null : canvas.getContext('2d'),
      visible: true,
      hovered: false,
      mouseX: 0,
      mouseY: 0,
      targetMouseX: 0,
      targetMouseY: 0,
      smoothVal: 0.05,
      smoothAux: -10,
      smoothDark: this.state.dark ? 1 : 0
    };

    if (card) {
      card.addEventListener('pointerenter', () => {
        scene.hovered = true;
      });
      card.addEventListener('pointermove', (e) => {
        const r = card.getBoundingClientRect();
        scene.targetMouseX = ((e.clientX - r.left) / r.width) * 2 - 1;
        scene.targetMouseY = -(((e.clientY - r.top) / r.height) * 2 - 1);
        scene.hovered = true;
      });
      card.addEventListener('pointerleave', () => {
        scene.hovered = false;
        scene.targetMouseX = 0;
        scene.targetMouseY = 0;
      });
    }

    if (gl) {
      const ok = this.initWebGL(scene);
      if (!ok) {
        scene.gl = null;
        scene.ctx2d = canvas.getContext('2d');
      }
    }

    this.resizeScene(scene);
    return scene;
  }

  resizeScene(scene) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = scene.canvas.getBoundingClientRect();
    const cssW = rect.width > 10 ? rect.width : 128;
    const cssH = rect.height > 10 ? rect.height : 128;
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);

    if (scene.canvas.width !== w || scene.canvas.height !== h) {
      scene.canvas.width = w;
      scene.canvas.height = h;
    }
    if (scene.gl) {
      scene.gl.viewport(0, 0, w, h);
    }
  }

  initWebGL(scene) {
    const gl = scene.gl;

    const vsSource = `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main() {
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;

    const fsSource = `
      precision highp float;
      varying vec2 v_uv;

      uniform vec2 u_res;
      uniform float u_time;
      uniform int u_kind;
      uniform float u_val;
      uniform float u_aux;
      uniform float u_dark;
      uniform vec2 u_mouse;
      uniform float u_hover;

      mat2 rot(float a) {
        float s = sin(a), c = cos(a);
        return mat2(c, -s, s, c);
      }

      float smin(float a, float b, float k) {
        float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
        return mix(b, a, h) - k * h * (1.0 - h);
      }

      float sdBox(vec3 p, vec3 b) {
        vec3 q = abs(p) - b;
        return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
      }

      float sdRoundBox(vec3 p, vec3 b, float r) {
        vec3 q = abs(p) - b;
        return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
      }

      float sdRoundBox2D(vec2 p, vec2 b, float r) {
        vec2 d = abs(p) - b;
        return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
      }

      float sdCylinder(vec3 p, float h, float r) {
        vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
        return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
      }

      float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
        vec3 pa = p - a, ba = b - a;
        float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
        return length(pa - ba * h) - r;
      }

      float sdCapsuleY(vec3 p, float y0, float y1, float r) {
        p.y -= clamp(p.y, y0, y1);
        return length(p) - r;
      }

      void polyEdge(vec2 p, vec2 a, vec2 b, inout float d, inout float s) {
        vec2 e = b - a;
        vec2 w = p - a;
        vec2 bProj = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
        d = min(d, dot(bProj, bProj));
        bvec3 cond = bvec3(p.y >= a.y, p.y < b.y, e.x * w.y > e.y * w.x);
        if (all(cond) || all(not(cond))) s = -s;
      }

      float sdLightning2D(vec2 p) {
        vec2 v0 = vec2(-0.01,  0.23);
        vec2 v1 = vec2( 0.15,  0.17);
        vec2 v2 = vec2( 0.02,  0.01);
        vec2 v3 = vec2( 0.16, -0.03);
        vec2 v4 = vec2(-0.07, -0.27);
        vec2 v5 = vec2(-0.01, -0.04);
        vec2 v6 = vec2(-0.15,  0.00);

        float d = dot(p - v0, p - v0);
        float s = 1.0;
        polyEdge(p, v0, v1, d, s);
        polyEdge(p, v1, v2, d, s);
        polyEdge(p, v2, v3, d, s);
        polyEdge(p, v3, v4, d, s);
        polyEdge(p, v4, v5, d, s);
        polyEdge(p, v5, v6, d, s);
        polyEdge(p, v6, v0, d, s);
        return s * sqrt(d) - 0.008;
      }

      // ======================================================================
      // MODELO 0: Placa Solar 3D + Sol 3D (Virados na diagonal olhando para a esquerda)
      // ======================================================================
      vec3 toSolarLocal(vec3 p) {
        float breath = sin(u_time * 1.5) * 0.010;
        p.y -= breath;
        p *= 1.12;
        // Rotação 3/4 diagonal olhando para a esquerda (alinhada à bateria e ao termômetro)
        p.xz *= rot(-0.44 + u_mouse.x * 0.22);
        p.yz *= rot(-0.14 + u_mouse.y * 0.12);
        return p;
      }

      vec2 mapSolarScene(vec3 pWorld) {
        vec3 p = toSolarLocal(pWorld);

        // 1. Sol 3D atrás à esquerda no mesmo plano diagonal + 6 raios capsulares
        vec3 sunPos = p - vec3(-0.22, 0.23, -0.38);
        float dSun = length(sunPos) - 0.30;

        for (int i = 0; i < 6; i++) {
          float ang = 0.14 + float(i) * 0.70;
          vec3 dir = vec3(cos(ang), sin(ang), 0.0);
          float dRay = sdCapsule(sunPos, dir * 0.385, dir * 0.478, 0.045);
          dSun = min(dSun, dRay);
        }

        // 2. Base horizontal metálica chanfrada + 2 colunas + mancais de articulação (vgpu assembly)
        vec3 pBase = p - vec3(0.0, -0.43, 0.03);
        float basePlate = sdRoundBox(pBase, vec3(0.49, 0.032, 0.29), 0.022);
        float baseStep = sdRoundBox(pBase - vec3(0.0, 0.033, 0.0), vec3(0.43, 0.015, 0.23), 0.012);
        vec3 qStrut = vec3(abs(pBase.x) - 0.27, pBase.y - 0.155, pBase.z - 0.02);
        float standStruts = sdRoundBox(qStrut, vec3(0.048, 0.14, 0.064), 0.014);
        float pivotMount = sdCylinder((qStrut - vec3(0.0, 0.145, 0.02)).yxz, 0.054, 0.050) - 0.006;
        float dStand = smin(min(basePlate, baseStep), min(standStruts, pivotMount), 0.010);

        // 3. Placa solar inclinada em 3D (moldura branca/prata + 12 células azuis 4x3 almofadadas)
        vec3 pPanel = p - vec3(0.0, -0.05, 0.11);
        pPanel.yz *= rot(-0.82);

        float frameOuter = sdRoundBox(pPanel, vec3(0.51, 0.032, 0.35), 0.028);
        float trayCut = sdRoundBox(pPanel - vec3(0.0, 0.038, 0.0), vec3(0.462, 0.014, 0.302), 0.012);
        float dFrame = max(frameOuter, -trayCut);

        // 12 células azuis 3D arredondadas (4 colunas x 3 linhas)
        vec2 gridSpan = vec2(0.455, 0.295);
        vec2 cellPitch = (gridSpan * 2.0) / vec2(4.0, 3.0);
        vec2 cellIdx = clamp(floor((pPanel.xz + gridSpan) / cellPitch), vec2(0.0), vec2(3.0, 2.0));
        vec2 cellCenterXZ = -gridSpan + (cellIdx + 0.5) * cellPitch;
        vec3 pCell = pPanel - vec3(cellCenterXZ.x, 0.026, cellCenterXZ.y);
        float dCells = sdRoundBox(pCell, vec3(0.092, 0.015, 0.078), 0.017);

        vec2 res = vec2(dSun / 1.12, 10.0);
        if (dStand / 1.12 < res.x) res = vec2(dStand / 1.12, 3.0);
        if (dFrame / 1.12 < res.x) res = vec2(dFrame / 1.12, 1.0);
        if (dCells / 1.12 < res.x) res = vec2(dCells / 1.12, 2.0);
        return res;
      }

      // ======================================================================
      // MODELO 1: Bateria Automotiva 3D com Alça, Polos (+ / -) e Raio 3D
      // ======================================================================
      vec3 toBatteryLocal(vec3 p) {
        float breath = sin(u_time * 1.5 + 1.1) * 0.011;
        p.y -= breath - 0.03;
        p.xz *= rot(-0.46 + u_mouse.x * 0.24);
        p.yz *= rot(-0.34 + u_mouse.y * 0.14);
        return p;
      }

      vec2 mapBatteryScene(vec3 pWorld) {
        vec3 p = toBatteryLocal(pWorld);

        // Corpo principal escuro contínuo e liso da bateria
        float mainBox = sdRoundBox(p - vec3(0.0, -0.06, 0.0), vec3(0.45, 0.31, 0.31), 0.032);

        // Saia inferior alargada com os 2 entalhes frontais de fixação
        float bottomSkirt = sdRoundBox(p - vec3(0.0, -0.35, 0.0), vec3(0.48, 0.042, 0.34), 0.024);
        float notchCut = sdCylinder(
          vec3(abs(p.x) - 0.18, p.z - 0.355, p.y + 0.32).xzy,
          0.045,
          0.032
        );
        bottomSkirt = max(bottomSkirt, -notchCut);

        // Tampa superior saliente + bloco central + soquetes da alça (vgpu assembly)
        float topLid = sdRoundBox(p - vec3(0.0, 0.26, 0.0), vec3(0.48, 0.044, 0.34), 0.026);
        float centerPad = sdRoundBox(p - vec3(0.0, 0.315, -0.01), vec3(0.22, 0.024, 0.22), 0.016);
        float handleSockets = sdRoundBox(
          vec3(abs(p.x) - 0.175, p.y - 0.332, p.z + 0.05),
          vec3(0.034, 0.016, 0.032),
          0.008
        );

        // Símbolos + e - em relevo sobre o bloco central da tampa
        vec3 pPlus = p - vec3(-0.10, 0.346, 0.09);
        float symPlus = min(
          sdBox(pPlus, vec3(0.045, 0.008, 0.012)),
          sdBox(pPlus, vec3(0.012, 0.008, 0.045))
        );
        vec3 pMinus = p - vec3(0.10, 0.346, 0.09);
        float symMinus = sdBox(pMinus, vec3(0.045, 0.008, 0.012));

        // Alça superior preta em arco
        vec3 pHandle = p - vec3(0.0, 0.43, -0.05);
        float handleOuter = sdRoundBox(pHandle, vec3(0.20, 0.10, 0.020), 0.018);
        float handleHole = sdRoundBox(pHandle - vec3(0.0, -0.03, 0.0), vec3(0.15, 0.085, 0.06), 0.012);
        float handleArch = max(handleOuter, -handleHole);

        float dCasing = min(min(mainBox, bottomSkirt), min(topLid, centerPad));
        dCasing = min(dCasing, min(handleSockets, min(symPlus, symMinus)));

        // Terminal positivo esquerdo (vermelho com colarinho largo na base)
        vec3 pPos = p - vec3(-0.34, 0.33, 0.12);
        float termPos = min(
          sdCylinder(pPos, 0.019, 0.094),
          sdCylinder(pPos - vec3(0.0, 0.070, 0.0), 0.068, 0.058)
        ) - 0.008;

        // Terminal negativo direito (azul-aço com colarinho largo na base)
        vec3 pNeg = p - vec3(0.34, 0.33, 0.12);
        float termNeg = min(
          sdCylinder(pNeg, 0.019, 0.094),
          sdCylinder(pNeg - vec3(0.0, 0.070, 0.0), 0.068, 0.058)
        ) - 0.008;

        // Símbolo de raio 3D extrudado na face frontal
        float d2dBolt = sdLightning2D(p.xy - vec2(0.0, -0.05));
        vec2 wBolt = vec2(d2dBolt, abs(p.z - 0.343) - 0.019);
        float dBolt = min(max(wBolt.x, wBolt.y), 0.0) + length(max(wBolt, 0.0)) - 0.006;

        vec2 res = vec2(dCasing, 1.0);
        if (handleArch < res.x) res = vec2(handleArch, 11.0);
        if (termPos < res.x) res = vec2(termPos, 5.0);
        if (termNeg < res.x) res = vec2(termNeg, 4.0);
        if (dBolt < res.x) res = vec2(dBolt, 6.0);
        return res;
      }

      // ======================================================================
      // MODELO 2: Termômetro 3D em Cápsula com Escala °C e Bulbo Reativo
      // ======================================================================
      vec3 toThermoLocal(vec3 p) {
        float breath = sin(u_time * 1.5 + 2.2) * 0.011;
        p.y -= breath;
        p.xz *= rot(-0.25 + u_mouse.x * 0.24);
        p.yz *= rot(-0.10 + u_mouse.y * 0.14);
        p.xy *= rot(0.06);
        return p;
      }

      vec2 mapThermoScene(vec3 pWorld) {
        vec3 p = toThermoLocal(pWorld);

        float d2Outer = sdRoundBox2D(p.xy, vec2(0.20, 0.43), 0.14);
        vec2 wOuter = vec2(d2Outer, abs(p.z) - 0.068);
        float outerBody = min(max(wOuter.x, wOuter.y), 0.0) + length(max(wOuter, 0.0)) - 0.018;

        float d2Inner = sdRoundBox2D(p.xy, vec2(0.165, 0.395), 0.11);
        vec2 wInnerCut = vec2(d2Inner, abs(p.z - 0.078) - 0.036);
        float innerCut = min(max(wInnerCut.x, wInnerCut.y), 0.0) + length(max(wInnerCut, 0.0));

        float plaque = max(outerBody, -innerCut);

        vec2 wFace = vec2(d2Inner, abs(p.z - 0.044) - 0.012);
        float whiteFace = min(max(wFace.x, wFace.y), 0.0) + length(max(wFace, 0.0));

        vec3 pTube = p - vec3(-0.058, 0.0, 0.056);
        float cradleStem = sdCapsuleY(pTube, -0.32, 0.39, 0.092);
        float cradleBulb = length(pTube - vec3(0.0, -0.34, 0.0)) - 0.152;
        float dCradle = min(cradleStem, cradleBulb);
        dCradle = max(dCradle, abs(p.z - 0.056) - 0.034);

        float fillY = mix(-0.18, 0.35, clamp(u_val, 0.04, 0.98));
        vec3 pLiq = p - vec3(-0.058, 0.0, 0.074);
        float liqBulb = length(pLiq - vec3(0.0, -0.34, 0.0)) - 0.125;
        float liqCol = sdCapsuleY(pLiq, -0.34, fillY, 0.061);
        float dLiquid = smin(liqBulb, liqCol, 0.012);

        float glassUpper = sdCapsuleY(pLiq - vec3(0.0, 0.0, -0.008), fillY, 0.38, 0.057);

        vec2 res = vec2(plaque, 3.0);
        if (whiteFace < res.x) res = vec2(whiteFace, 7.0);
        if (dCradle < res.x) res = vec2(dCradle, 4.0);
        if (glassUpper < res.x) res = vec2(glassUpper, 12.0);
        if (dLiquid < res.x) res = vec2(dLiquid, 8.0);
        return res;
      }

      vec2 mapScene(vec3 p) {
        if (u_kind == 0) return mapSolarScene(p);
        if (u_kind == 1) return mapBatteryScene(p);
        return mapThermoScene(p);
      }

      vec3 calcNormal(vec3 p) {
        const float h = 0.0010;
        const vec2 k = vec2(1.0, -1.0);
        return normalize(
          k.xyy * mapScene(p + k.xyy * h).x +
          k.yyx * mapScene(p + k.yyx * h).x +
          k.yxy * mapScene(p + k.yxy * h).x +
          k.xxx * mapScene(p + k.xxx * h).x
        );
      }

      float calcAO(vec3 pos, vec3 nor) {
        float occ = 0.0;
        float sca = 1.0;
        for (int i = 0; i < 5; i++) {
          float h = 0.018 + 0.080 * float(i) / 4.0;
          float d = mapScene(pos + h * nor).x;
          occ += (h - d) * sca;
          sca *= 0.72;
        }
        return clamp(1.0 - 1.85 * occ, 0.0, 1.0);
      }

      float calcSoftShadow(vec3 ro, vec3 rd, float mint, float maxt, float k) {
        float res = 1.0;
        float t = mint;
        for (int i = 0; i < 20; i++) {
          float h = mapScene(ro + rd * t).x;
          res = min(res, k * h / t);
          t += clamp(h, 0.02, 0.10);
          if (res < 0.005 || t > maxt) break;
        }
        return clamp(res, 0.0, 1.0);
      }

      float D_GGX(float NdotH, float roughness) {
        float a = roughness * roughness;
        float a2 = a * a;
        float d = (NdotH * NdotH) * (a2 - 1.0) + 1.0;
        return a2 / (3.14159265 * d * d + 1e-5);
      }

      float V_SmithGGXCorrelated(float NdotV, float NdotL, float roughness) {
        float a2 = roughness * roughness;
        a2 = a2 * a2;
        float ggxV = NdotL * sqrt(NdotV * NdotV * (1.0 - a2) + a2);
        float ggxL = NdotV * sqrt(NdotL * NdotL * (1.0 - a2) + a2);
        return 0.5 / max(ggxV + ggxL, 1e-4);
      }

      vec3 F_Schlick(float cosTheta, vec3 F0) {
        return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
      }

      vec3 F_SchlickRoughness(float cosTheta, vec3 F0, float roughness) {
        return F0 + (max(vec3(1.0 - roughness), F0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
      }

      vec3 envStudioIBL(vec3 R, float roughness) {
        float sky = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 dome = mix(vec3(0.20, 0.22, 0.26), vec3(0.86, 0.91, 0.98), pow(sky, 0.75));
        float softboxKey = smoothstep(0.55, 0.92, dot(R, normalize(vec3(-0.45, 0.72, 0.52))));
        float softboxRim = smoothstep(0.62, 0.95, dot(R, normalize(vec3(0.65, 0.45, -0.60))));
        float blurAtten = 1.0 - roughness * 0.65;
        return dome + (vec3(1.0, 0.98, 0.94) * softboxKey * 0.60 + vec3(0.76, 0.88, 1.0) * softboxRim * 0.40) * blurAtten;
      }

      float thermoScaleMask(vec2 p) {
        float m = 0.0;

        float degRing = abs(length(p - vec2(0.068, 0.432)) - 0.013) - 0.005;
        m = max(m, 1.0 - smoothstep(-0.002, 0.003, degRing));

        vec2 pc = p - vec2(0.122, 0.378);
        float cRing = abs(length(pc) - 0.032) - 0.010;
        float cOpen = step(0.005, pc.x) * (1.0 - smoothstep(0.018, 0.024, abs(pc.y)));
        float cMask = (1.0 - smoothstep(-0.002, 0.003, cRing)) * (1.0 - cOpen);
        m = max(m, cMask);

        if (p.y > -0.24 && p.y < 0.30 && p.x > 0.052 && p.x < 0.20) {
          float idxF = (p.y - (-0.22)) / 0.04167;
          float idx = floor(idxF + 0.5);
          if (idx >= 0.0 && idx <= 12.0) {
            float yCenter = -0.22 + idx * 0.04167;
            float isMajor = step(0.8, cos(idx * 3.14159265 * 2.0 / 3.0));
            float halfLen = mix(0.022, 0.038, isMajor);
            float halfThick = mix(0.005, 0.0085, isMajor);
            float xCenter = 0.068 + halfLen;
            float dTick = sdRoundBox2D(p - vec2(xCenter, yCenter), vec2(halfLen, halfThick), 0.0035);
            m = max(m, 1.0 - smoothstep(-0.002, 0.003, dTick));
          }
        }
        return clamp(m, 0.0, 1.0);
      }

      vec4 renderSample(vec2 fragCoord) {
        vec2 uv = (fragCoord - 0.5 * u_res) / min(u_res.x, u_res.y);
        float canvasMask = smoothstep(0.49, 0.34, length(uv));

        // Lente teleobjetiva de estúdio (elimina distorção trapezoidal de perspectiva nas bordas)
        vec3 ro = vec3(0.0, 0.05, 5.40);
        vec3 ta = vec3(0.0, -0.03, 0.0);
        vec3 ww = normalize(ta - ro);
        vec3 uu = normalize(cross(ww, vec3(0.0, 1.0, 0.0)));
        vec3 vv = normalize(cross(uu, ww));
        vec3 rd = normalize(uv.x * uu + uv.y * vv + 3.78 * ww);

        vec3 keyDir = normalize(vec3(0.48 + u_mouse.x * 0.25, 0.74 + u_mouse.y * 0.20, 0.68));
        vec3 fillDir = normalize(vec3(-0.68, 0.34, 0.58));
        vec3 rimDir = normalize(vec3(0.14, 0.62, -0.78));

        float t = 3.8;
        float mat = -1.0;
        for (int i = 0; i < 72; i++) {
          vec3 pos = ro + rd * t;
          vec2 h = mapScene(pos);
          if (h.x < 0.0010) {
            mat = h.y;
            break;
          }
          t += h.x;
          if (t > 7.2) break;
        }

        vec3 col = vec3(0.0);
        float alpha = 0.0;

        // Halo volumétrico reativo atrás do Sol 3D (posicionado na diagonal superior esquerda)
        if (u_kind == 0) {
          vec2 sunScreen = vec2(-0.07, 0.14);
          float dSun2D = length(uv - sunScreen);
          float glowStrength = (0.14 + 0.62 * u_val) * canvasMask;
          float sunHalo = exp(-dSun2D * mix(5.6, 3.2, u_val)) * glowStrength;
          col = vec3(1.0, 0.82, 0.20);
          alpha = clamp(sunHalo, 0.0, 0.88);
        }

        // Sombra de contato penumbra sob o modelo
        float floorY = u_kind == 2 ? -0.68 : -0.52;
        if (rd.y < -0.001 && mat < 0.0) {
          float tf = (floorY - ro.y) / rd.y;
          if (tf > 0.0 && tf < 7.0) {
            vec3 pf = ro + rd * tf;
            float distCenter = length(pf.xz * vec2(0.95, 1.25));
            float sh = 1.0 - calcSoftShadow(pf + vec3(0.0, 0.02, 0.0), normalize(vec3(0.15, 0.95, 0.2)), 0.02, 1.4, 7.6);
            float radialFade = smoothstep(0.60, 0.10, distCenter);
            float shadowAlpha = sh * radialFade * canvasMask * mix(0.13, 0.34, u_dark);
            col = mix(col, vec3(0.02, 0.02, 0.03), shadowAlpha / max(alpha + shadowAlpha, 1e-4));
            alpha = max(alpha, shadowAlpha);
          }
        }

        if (mat > 0.0) {
          vec3 pos = ro + rd * t;
          vec3 N = calcNormal(pos);
          vec3 V = -rd;
          vec3 R = reflect(-V, N);
          float ao = calcAO(pos, N);

          vec3 albedo = vec3(0.5);
          float metalness = 0.08;
          float roughness = 0.28;
          float clearcoat = 0.20;
          float sss = 0.0;
          vec3 emissive = vec3(0.0);

          if (u_kind == 0) {
            vec3 pSol = toSolarLocal(pos);
            if (mat > 9.5) {
              // Mat 10: Sol 3D + 6 raios capsulares
              albedo = mix(vec3(0.96, 0.79, 0.15), vec3(1.0, 0.92, 0.28), u_val);
              metalness = 0.04;
              roughness = 0.24;
              clearcoat = 0.30;
              sss = 0.45;
              float rimSun = pow(1.0 - max(dot(N, V), 0.0), 2.1);
              emissive = vec3(1.0, 0.82, 0.16) * (0.24 + 0.90 * u_val + rimSun * 0.50 * u_val);
            } else if (mat < 1.5) {
              // Mat 1: Moldura branca/prata arredondada da placa solar
              albedo = vec3(0.93, 0.95, 0.98);
              metalness = 0.20;
              roughness = 0.18;
              clearcoat = 0.60;
              // Mantém os sulcos internos entre as células claros e limpos como na referência
              ao = mix(0.82, 1.0, ao);
            } else if (mat < 2.5) {
              // Mat 2: 12 Células solares azuis 3D almofadadas (idênticas à referência 1)
              albedo = mix(vec3(0.11, 0.48, 0.90), vec3(0.20, 0.59, 0.97), clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
              metalness = 0.06;
              roughness = 0.20;
              clearcoat = 0.55;
              sss = 0.30;
              ao = mix(0.78, 1.0, ao);
              emissive = vec3(0.06, 0.26, 0.58) * 0.20 + vec3(0.90, 0.68, 0.18) * u_val * 0.08;
            } else {
              // Mat 3: Pedestal, colunas e mancais metálicos prateados
              albedo = vec3(0.82, 0.85, 0.88);
              metalness = 0.65;
              roughness = 0.22;
              clearcoat = 0.40;
              float cornerTint = smoothstep(0.10, 0.42, pSol.x) * smoothstep(-0.34, -0.50, pSol.y);
              albedo = mix(albedo, vec3(0.50, 0.58, 0.44), cornerTint * 0.42);
            }
          } else if (u_kind == 1) {
            vec3 pBat = toBatteryLocal(pos);
            if (mat < 1.5) {
              albedo = vec3(0.22, 0.23, 0.255);
              metalness = 0.14;
              roughness = 0.36;
              clearcoat = 0.20;
            } else if (mat > 10.5) {
              albedo = vec3(0.13, 0.14, 0.16);
              metalness = 0.12;
              roughness = 0.42;
              clearcoat = 0.12;
            } else if (mat > 4.5 && mat < 5.5) {
              albedo = vec3(0.91, 0.26, 0.19);
              metalness = 0.10;
              roughness = 0.22;
              clearcoat = 0.55;
              sss = 0.20;
            } else if (mat > 3.5 && mat < 4.5) {
              albedo = vec3(0.33, 0.50, 0.68);
              metalness = 0.16;
              roughness = 0.22;
              clearcoat = 0.55;
              sss = 0.15;
            } else {
              float hBolt = clamp((pBat.y - (-0.32)) / 0.50, 0.0, 1.0);
              float fillLvl = clamp(u_val, 0.0, 1.0);
              float isFilled = 1.0 - smoothstep(fillLvl - 0.018, fillLvl + 0.018, hBolt);
              float meniscus = exp(-pow((hBolt - fillLvl) * 34.0, 2.0)) * step(0.02, fillLvl) * step(fillLvl, 0.99);

              vec3 boltFullCol = u_val < 0.20 ? vec3(0.96, 0.32, 0.20) : vec3(1.0, 0.79, 0.14);
              vec3 boltEmptyCol = vec3(0.66, 0.50, 0.18);

              albedo = mix(boltEmptyCol, boltFullCol, isFilled);
              metalness = mix(0.18, 0.10, isFilled);
              roughness = mix(0.26, 0.14, isFilled);
              clearcoat = 0.75;
              sss = 0.25 * isFilled;
              emissive = boltFullCol * (isFilled * 0.44 + 0.08) + vec3(1.0, 0.95, 0.68) * meniscus * 0.80;
            }
          } else {
            vec3 pTh = toThermoLocal(pos);
            if (mat < 3.5) {
              float isFrontBezel = smoothstep(0.035, 0.055, pTh.z);
              vec3 sideSilver = vec3(0.78, 0.82, 0.88);
              vec3 bezelNavy = vec3(0.24, 0.31, 0.44);
              albedo = mix(sideSilver, bezelNavy, isFrontBezel);
              metalness = mix(0.38, 0.20, isFrontBezel);
              roughness = 0.21;
              clearcoat = 0.55;
            } else if (mat < 4.5) {
              albedo = vec3(0.36, 0.49, 0.67);
              metalness = 0.20;
              roughness = 0.20;
              clearcoat = 0.60;
            } else if (mat < 7.5) {
              float marks = thermoScaleMask(pTh.xy);
              albedo = mix(vec3(0.96, 0.97, 0.99), vec3(0.07, 0.09, 0.12), marks);
              metalness = 0.02;
              roughness = mix(0.18, 0.34, marks);
              clearcoat = 0.30;
              emissive = vec3(0.18, 0.19, 0.20) * (1.0 - marks);
            } else if (mat > 11.5) {
              albedo = vec3(0.38, 0.53, 0.72);
              metalness = 0.15;
              roughness = 0.06;
              clearcoat = 1.0;
              float glassStrip = smoothstep(0.022, 0.004, abs(pTh.x - (-0.032)));
              emissive = vec3(0.78, 0.88, 0.98) * glassStrip * 0.46;
            } else {
              float tempC = u_aux;
              vec3 cCold   = vec3(0.12, 0.48, 0.96);
              vec3 cMild   = vec3(0.08, 0.72, 0.54);
              vec3 cNormal = vec3(0.94, 0.22, 0.16);
              vec3 cHot    = vec3(0.82, 0.04, 0.12);

              vec3 liqColor;
              if (tempC < 19.0) {
                liqColor = mix(cCold, cMild, smoothstep(12.0, 19.0, tempC));
              } else if (tempC < 25.0) {
                liqColor = mix(cMild, cNormal, smoothstep(19.0, 25.0, tempC));
              } else {
                liqColor = mix(cNormal, cHot, smoothstep(25.0, 42.0, tempC));
              }

              albedo = liqColor;
              metalness = 0.10;
              roughness = 0.06;
              clearcoat = 1.0;
              sss = 0.35;

              float tubeHighlight = smoothstep(0.018, 0.003, abs(pTh.x - (-0.032))) * step(-0.22, pTh.y);
              float bulbDot1 = smoothstep(0.038, 0.012, length(pTh.xy - vec2(-0.015, -0.35)));
              float bulbDot2 = smoothstep(0.042, 0.010, length(pTh.xy - vec2(-0.105, -0.33))) * 0.55;
              emissive = liqColor * 0.28 + vec3(0.96, 0.98, 1.0) * (tubeHighlight * 0.48 + bulbDot1 * 0.78 + bulbDot2);
            }
          }

          float NdotL = max(dot(N, keyDir), 0.0);
          float NdotV = max(dot(N, V), 0.001);
          vec3 H = normalize(keyDir + V);
          float NdotH = max(dot(N, H), 0.0);
          float VdotH = max(dot(V, H), 0.0);

          float shadow = calcSoftShadow(pos + N * 0.006, keyDir, 0.02, 1.4, 8.0);
          // Na placa solar, mantém sombra suave de estúdio para não escurecer os vãos das células
          shadow = mix(u_kind == 0 ? 0.72 : 0.48, 1.0, shadow);

          vec3 F0 = mix(vec3(0.04), albedo, metalness);
          vec3 F = F_Schlick(VdotH, F0);
          float D = D_GGX(NdotH, roughness);
          float Vis = V_SmithGGXCorrelated(NdotV, max(NdotL, 0.001), roughness);
          vec3 spec = D * Vis * F;

          vec3 kD = (1.0 - F) * (1.0 - metalness);
          float wrapDiff = max(0.0, (dot(N, keyDir) + sss) / (1.0 + sss));
          vec3 direct = (kD * albedo * wrapDiff + spec * 0.50 * NdotL) * shadow * 1.14;

          float fillDiff = max(dot(N, fillDir), 0.0);
          vec3 fill = albedo * vec3(0.88, 0.93, 1.0) * fillDiff * 0.42 * ao;

          float rim = pow(1.0 - NdotV, 3.0) * max(dot(N, rimDir), 0.0);
          vec3 rimLight = vec3(0.95, 0.97, 1.0) * rim * 0.30;

          vec3 kS_ibl = F_SchlickRoughness(NdotV, F0, roughness);
          vec3 envSpec = envStudioIBL(R, roughness) * kS_ibl * ao * mix(0.18, 0.48, metalness);

          float ccSpec = 0.0;
          if (clearcoat > 0.01) {
            float Fc = 0.04 + 0.96 * pow(1.0 - VdotH, 5.0);
            ccSpec = D_GGX(NdotH, 0.08) * Fc * shadow * NdotL * clearcoat * 0.24;
          }

          vec3 amb = albedo * (0.52 + 0.18 * N.y) * ao;
          vec3 objCol = amb + direct + fill + rimLight + envSpec + vec3(ccSpec) + emissive;
          objCol = clamp(objCol, 0.0, 1.0);

          col = objCol;
          alpha = 1.0;
        }

        return vec4(col * alpha, alpha);
      }

      void main() {
        // Supersampling Rotated Grid 2x (RGSS Anti-Aliasing) para silhuetas e chanfros ultra-nítidos
        vec4 s0 = renderSample(gl_FragCoord.xy + vec2(-0.18, -0.32));
        vec4 s1 = renderSample(gl_FragCoord.xy + vec2( 0.18,  0.32));
        gl_FragColor = 0.5 * (s0 + s1);
      }
    `;

    const vs = this.compileShader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return false;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[Models3D] Falha ao linkar shader:', gl.getProgramInfoLog(prog));
      return false;
    }

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    scene.program = prog;
    scene.buffer = buf;
    scene.aPos = aPos;
    scene.uniforms = {
      res: gl.getUniformLocation(prog, 'u_res'),
      time: gl.getUniformLocation(prog, 'u_time'),
      kind: gl.getUniformLocation(prog, 'u_kind'),
      val: gl.getUniformLocation(prog, 'u_val'),
      aux: gl.getUniformLocation(prog, 'u_aux'),
      dark: gl.getUniformLocation(prog, 'u_dark'),
      mouse: gl.getUniformLocation(prog, 'u_mouse'),
      hover: gl.getUniformLocation(prog, 'u_hover')
    };

    return true;
  }

  compileShader(gl, type, source) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('[Models3D] Erro de compilação GLSL:', gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  loop(now) {
    this.rafId = 0;
    const timeSec = now * 0.001;

    const pvRatio =
      this.state.pvUtilization > 0
        ? this.state.pvUtilization / 50
        : this.state.pvPower / 200;
    const pvTarget =
      this.state.online && (this.state.generating || this.state.pvPower > 0.5)
        ? Math.max(0.22, Math.min(1.0, pvRatio))
        : 0.05;

    if (this.bg) {
      this.bg.setEnergyLevel(pvTarget);
      this.bg.render(timeSec);
    }

    const socTarget = Math.max(0.0, Math.min(1.0, this.state.soc / 100));
    const tempTarget = Math.max(0.08, Math.min(0.96, this.state.temp / 48));
    const darkTarget = this.state.dark ? 1.0 : 0.0;

    this.scenes.forEach((sc) => {
      if (!sc.visible) return;

      const targetVal = sc.kind === 0 ? pvTarget : sc.kind === 1 ? socTarget : tempTarget;
      const targetAux = sc.kind === 2 ? this.state.temp : this.state.online ? 1.0 : 0.0;

      sc.smoothVal += (targetVal - sc.smoothVal) * 0.14;
      sc.smoothAux += (targetAux - sc.smoothAux) * 0.14;
      sc.smoothDark += (darkTarget - sc.smoothDark) * 0.18;
      sc.mouseX += (sc.targetMouseX - sc.mouseX) * 0.14;
      sc.mouseY += (sc.targetMouseY - sc.mouseY) * 0.14;
      sc.hoverVal = (sc.hoverVal || 0) + ((sc.hovered ? 1 : 0) - (sc.hoverVal || 0)) * 0.14;

      if (sc.gl && sc.program) {
        this.renderWebGLScene(sc, timeSec);
      } else if (sc.ctx2d) {
        this.renderFallback2D(sc);
      }
    });

    this.frameCount = (this.frameCount || 0) + 1;
    const isAutomatedCapture = Boolean(navigator.webdriver) && this.frameCount > 4;

    if (!this.reducedMotion && !document.hidden && !isAutomatedCapture) {
      this.rafId = requestAnimationFrame((t) => this.loop(t));
    }
  }

  renderWebGLScene(sc, timeSec) {
    const gl = sc.gl;
    gl.useProgram(sc.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, sc.buffer);
    gl.vertexAttribPointer(sc.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.uniform2f(sc.uniforms.res, sc.canvas.width, sc.canvas.height);
    gl.uniform1f(sc.uniforms.time, this.reducedMotion ? 0.0 : timeSec);
    gl.uniform1i(sc.uniforms.kind, sc.kind);
    gl.uniform1f(sc.uniforms.val, sc.smoothVal);
    gl.uniform1f(sc.uniforms.aux, sc.smoothAux);
    gl.uniform1f(sc.uniforms.dark, sc.smoothDark);
    gl.uniform2f(sc.uniforms.mouse, sc.mouseX, sc.mouseY);
    gl.uniform1f(sc.uniforms.hover, sc.hoverVal || 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  renderFallback2D(sc) {
    const ctx = sc.ctx2d;
    const w = sc.canvas.width;
    const h = sc.canvas.height;
    ctx.clearRect(0, 0, w, h);
  }
}

window.StudioModels3D = StudioModels3D;
