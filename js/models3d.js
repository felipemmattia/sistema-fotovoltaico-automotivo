/**
 * Telemetria FV — Renderizador 3D PBR em WebGL.
 *
 * Renderiza três modelos 3D com iluminação física (GGX + Fresnel Schlick)
 * que reagem em tempo real aos dados de telemetria:
 *   1. #canvas-pv   — Módulo fotovoltaico inclinado sobre pedestal metálico e Sol 3D
 *                     cujo brilho aumenta proporcionalmente à potência solar gerada.
 *   2. #canvas-soc  — Bateria automotiva 3D com símbolo de raio frontal que se
 *                     preenche conforme o estado de carga (SOC %).
 *   3. #canvas-temp — Termômetro 3D com escala graduada em °C cuja coluna e cor
 *                     variam conforme a temperatura medida pelo sensor NTC.
 */

class StudioModels3D {
  constructor() {
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.scenes = [];
    this.rafId = 0;
    this.activeUntil = performance.now() + 2600;

    this.state = {
      pvPower: 0,
      pvUtilization: 0,
      generating: false,
      soc: 59,
      voltage: 12.69,
      temp: 26.5,
      online: true,
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

    if (!this.scenes.length) return;

    if ('IntersectionObserver' in window) {
      this.io = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            const sc = this.scenes.find((s) => s.canvas === entry.target);
            if (sc) sc.visible = entry.isIntersecting;
          });
          this.wake(600);
        },
        { threshold: 0.05 }
      );
      this.scenes.forEach((s) => this.io.observe(s.canvas));
    }

    window.addEventListener('resize', () => {
      this.scenes.forEach((s) => this.resizeScene(s));
      this.wake(400);
    });

    this.wake(2800);
  }

  wake(durationMs = 1200) {
    const target = performance.now() + durationMs;
    if (target > this.activeUntil) this.activeUntil = target;
    if (!this.rafId) {
      this.rafId = requestAnimationFrame((t) => this.loop(t));
    }
  }

  setTheme(isDark) {
    this.state.dark = Boolean(isDark);
    this.wake(1000);
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
    this.wake(1400);
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
      smoothVal: kind === 0 ? 0.45 : kind === 1 ? 0.59 : 0.55,
      smoothAux: 26.5,
      smoothDark: this.state.dark ? 1 : 0
    };

    if (card) {
      card.addEventListener('pointerenter', () => {
        scene.hovered = true;
        this.wake(2000);
      });
      card.addEventListener('pointermove', (e) => {
        const r = card.getBoundingClientRect();
        scene.targetMouseX = ((e.clientX - r.left) / r.width) * 2 - 1;
        scene.targetMouseY = -(((e.clientY - r.top) / r.height) * 2 - 1);
        scene.hovered = true;
        this.wake(800);
      });
      card.addEventListener('pointerleave', () => {
        scene.hovered = false;
        scene.targetMouseX = 0;
        scene.targetMouseY = 0;
        this.wake(1200);
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

      float sdBox(vec3 p, vec3 b) {
        vec3 q = abs(p) - b;
        return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
      }

      float sdRoundBox(vec3 p, vec3 b, float r) {
        vec3 q = abs(p) - b;
        return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
      }

      float sdBox2D(vec2 p, vec2 b) {
        vec2 d = abs(p) - b;
        return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
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

      // Aresta de polígono 2D (distância exata + regra de cruzamento par-ímpar)
      void polyEdge(vec2 p, vec2 a, vec2 b, inout float d, inout float s) {
        vec2 e = b - a;
        vec2 w = p - a;
        vec2 bProj = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
        d = min(d, dot(bProj, bProj));
        bvec3 cond = bvec3(p.y >= a.y, p.y < b.y, e.x * w.y > e.y * w.x);
        if (all(cond) || all(not(cond))) s = -s;
      }

      // Polígono 2D exato de 7 vértices do raio da bateria (sem costuras internas)
      float sdLightning2D(vec2 p) {
        vec2 v0 = vec2(-0.01,  0.23); // Topo esquerdo da barra superior
        vec2 v1 = vec2( 0.15,  0.17); // Topo direito da barra superior
        vec2 v2 = vec2( 0.02,  0.01); // Cintura interna direita
        vec2 v3 = vec2( 0.16, -0.03); // Ponta externa direita
        vec2 v4 = vec2(-0.07, -0.27); // Ponta inferior aguda
        vec2 v5 = vec2(-0.01, -0.04); // Cintura interna esquerda
        vec2 v6 = vec2(-0.15,  0.00); // Ponta externa esquerda

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
      // MODELO 0: Placa Solar 3D sobre Pedestal + Sol 3D com 6 raios capsulares
      // ======================================================================
      vec2 mapSolarScene(vec3 pWorld) {
        float breath = sin(u_time * 1.5) * 0.012;
        vec3 p = pWorld;
        p.y -= breath;

        // Rotação 3/4 idêntica à imagem de referência 1 (mostrando lateral direita da placa e base)
        p.xz *= rot(0.22 - u_mouse.x * 0.22);
        p.yz *= rot(-0.04 + u_mouse.y * 0.12);

        // 1. Sol 3D atrás à esquerda (posicionado em z = -0.44 para não interceptar a placa inclinada)
        vec3 sunPos = p - vec3(-0.25, 0.21, -0.44);
        float dSun = length(sunPos) - 0.31;

        for (int i = 0; i < 6; i++) {
          float ang = 0.12 + float(i) * 0.70;
          vec3 dir = vec3(cos(ang), sin(ang), 0.0);
          float dRay = sdCapsule(sunPos, dir * 0.40, dir * 0.49, 0.046);
          dSun = min(dSun, dRay);
        }

        // 2. Base horizontal metálica do pedestal + 2 colunas de suporte
        vec3 pBase = p - vec3(0.06, -0.43, 0.04);
        float basePlate = sdRoundBox(pBase, vec3(0.50, 0.032, 0.30), 0.022);
        float baseStep = sdRoundBox(pBase - vec3(0.0, 0.032, 0.0), vec3(0.44, 0.014, 0.24), 0.012);
        float standStruts = sdRoundBox(
          vec3(abs(pBase.x) - 0.28, pBase.y - 0.15, pBase.z - 0.02),
          vec3(0.048, 0.14, 0.065),
          0.014
        );
        float dStand = min(min(basePlate, baseStep), standStruts);

        // 3. Placa solar inclinada em 3D (moldura branca/prata + 12 células azuis 4x3 contínuas)
        vec3 pPanel = p - vec3(0.06, -0.05, 0.12);
        pPanel.yz *= rot(-0.86);

        float frameOuter = sdRoundBox(pPanel, vec3(0.52, 0.028, 0.36), 0.026);
        float trayCut = sdRoundBox(pPanel - vec3(0.0, 0.032, 0.0), vec3(0.47, 0.020, 0.31), 0.012);
        float dFrame = max(frameOuter, -trayCut);

        // 12 células azuis 3D (4 colunas x 3 linhas) usando repetição finita exata (SDF 100% contínuo)
        vec2 gridSpan = vec2(0.46, 0.30);
        vec2 cellPitch = (gridSpan * 2.0) / vec2(4.0, 3.0);
        vec2 cellIdx = clamp(floor((pPanel.xz + gridSpan) / cellPitch), vec2(0.0), vec2(3.0, 2.0));
        vec2 cellCenterXZ = -gridSpan + (cellIdx + 0.5) * cellPitch;
        vec3 pCell = pPanel - vec3(cellCenterXZ.x, 0.020, cellCenterXZ.y);
        float dCells = sdRoundBox(pCell, vec3(0.092, 0.014, 0.078), 0.014);

        vec2 res = vec2(dSun, 10.0);
        if (dStand < res.x) res = vec2(dStand, 3.0);
        if (dFrame < res.x) res = vec2(dFrame, 1.0);
        if (dCells < res.x) res = vec2(dCells, 2.0);
        return res;
      }

      // ======================================================================
      // MODELO 1: Bateria Automotiva 3D com Alça, Polos (+ / -) e Raio 3D
      // ======================================================================
      vec3 toBatteryLocal(vec3 p) {
        float breath = sin(u_time * 1.5) * 0.012;
        p.y -= breath - 0.03;
        // Rotação idêntica à imagem de referência 2 (face frontal à esquerda, lateral à direita)
        p.xz *= rot(-0.46 + u_mouse.x * 0.24);
        p.yz *= rot(-0.34 + u_mouse.y * 0.14);
        return p;
      }

      vec2 mapBatteryScene(vec3 pWorld) {
        vec3 p = toBatteryLocal(pWorld);

        // Corpo principal escuro da bateria
        float mainBox = sdRoundBox(p - vec3(0.0, -0.06, 0.0), vec3(0.45, 0.31, 0.31), 0.032);

        // Saia inferior alargada com os 2 entalhes de fixação frontais (idêntico à imagem 2)
        float bottomSkirt = sdRoundBox(p - vec3(0.0, -0.35, 0.0), vec3(0.48, 0.042, 0.34), 0.024);
        float notchCut = sdCylinder(
          vec3(abs(p.x) - 0.18, p.z - 0.355, p.y + 0.32).xzy,
          0.045,
          0.032
        );
        bottomSkirt = max(bottomSkirt, -notchCut);

        // Tampa superior saliente
        float topLid = sdRoundBox(p - vec3(0.0, 0.26, 0.0), vec3(0.48, 0.044, 0.34), 0.026);

        // Bloco central elevado na tampa
        float centerPad = sdRoundBox(p - vec3(0.0, 0.315, -0.01), vec3(0.22, 0.024, 0.22), 0.016);

        // Símbolos + e - em relevo sobre o bloco central da tampa
        vec3 pPlus = p - vec3(-0.10, 0.346, 0.09);
        float symPlus = min(
          sdBox(pPlus, vec3(0.045, 0.008, 0.012)),
          sdBox(pPlus, vec3(0.012, 0.008, 0.045))
        );
        vec3 pMinus = p - vec3(0.10, 0.346, 0.09);
        float symMinus = sdBox(pMinus, vec3(0.045, 0.008, 0.012));

        // Alça superior preta em arco (invertido U)
        vec3 pHandle = p - vec3(0.0, 0.43, -0.05);
        float handleOuter = sdRoundBox(pHandle, vec3(0.20, 0.10, 0.020), 0.018);
        float handleHole = sdRoundBox(pHandle - vec3(0.0, -0.03, 0.0), vec3(0.15, 0.085, 0.06), 0.012);
        float handleArch = max(handleOuter, -handleHole);

        float dCasing = min(min(mainBox, bottomSkirt), min(topLid, centerPad));
        dCasing = min(dCasing, min(symPlus, symMinus));

        // Terminal positivo esquerdo (vermelho com colarinho largo na base)
        vec3 pPos = p - vec3(-0.34, 0.33, 0.12);
        float termPos = min(
          sdCylinder(pPos, 0.018, 0.092),
          sdCylinder(pPos - vec3(0.0, 0.068, 0.0), 0.068, 0.058)
        ) - 0.008;

        // Terminal negativo direito (azul-aço com colarinho largo na base)
        vec3 pNeg = p - vec3(0.34, 0.33, 0.12);
        float termNeg = min(
          sdCylinder(pNeg, 0.018, 0.092),
          sdCylinder(pNeg - vec3(0.0, 0.068, 0.0), 0.068, 0.058)
        ) - 0.008;

        // Símbolo de raio 3D extrudado na face frontal da bateria
        float d2dBolt = sdLightning2D(p.xy - vec2(0.0, -0.05));
        vec2 wBolt = vec2(d2dBolt, abs(p.z - 0.342) - 0.018);
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
        float breath = sin(u_time * 1.5) * 0.012;
        p.y -= breath;
        // Inclinação idêntica à imagem de referência 3 (topo levemente à direita + lateral 3D prateada visível)
        p.xz *= rot(-0.25 + u_mouse.x * 0.24);
        p.yz *= rot(-0.10 + u_mouse.y * 0.14);
        p.xy *= rot(0.06);
        return p;
      }

      vec2 mapThermoScene(vec3 pWorld) {
        vec3 p = toThermoLocal(pWorld);

        // Placa retangular arredondada com folga superior e lateral para o símbolo °C
        float d2Outer = sdRoundBox2D(p.xy, vec2(0.20, 0.43), 0.14);
        vec2 wOuter = vec2(d2Outer, abs(p.z) - 0.068);
        float outerBody = min(max(wOuter.x, wOuter.y), 0.0) + length(max(wOuter, 0.0)) - 0.018;

        // Cavidade frontal que forma o aro azul-ardósia e o mostrador branco
        float d2Inner = sdRoundBox2D(p.xy, vec2(0.165, 0.395), 0.11);
        vec2 wInnerCut = vec2(d2Inner, abs(p.z - 0.078) - 0.036);
        float innerCut = min(max(wInnerCut.x, wInnerCut.y), 0.0) + length(max(wInnerCut, 0.0));

        float plaque = max(outerBody, -innerCut);

        // Mostrador branco interno
        vec2 wFace = vec2(d2Inner, abs(p.z - 0.044) - 0.012);
        float whiteFace = min(max(wFace.x, wFace.y), 0.0) + length(max(wFace, 0.0));

        // Berço azul-aço do tubo e do bulbo (canaleta central-esquerda em x = -0.058)
        vec3 pTube = p - vec3(-0.058, 0.0, 0.056);
        float cradleStem = sdCapsuleY(pTube, -0.32, 0.39, 0.092);
        float cradleBulb = length(pTube - vec3(0.0, -0.34, 0.0)) - 0.152;
        float dCradle = min(cradleStem, cradleBulb);
        dCradle = max(dCradle, abs(p.z - 0.056) - 0.034);

        // Coluna líquida interna + bulbo esférico reativo (sobe conforme u_val)
        float fillY = mix(-0.18, 0.35, clamp(u_val, 0.04, 0.98));
        vec3 pLiq = p - vec3(-0.058, 0.0, 0.074);
        float liqBulb = length(pLiq - vec3(0.0, -0.34, 0.0)) - 0.124;
        float liqCol = sdCapsuleY(pLiq, -0.34, fillY, 0.060);
        float dLiquid = min(liqBulb, liqCol);

        // Tubo capilar superior de vidro azulado acima da coluna líquida
        float glassUpper = sdCapsuleY(pLiq - vec3(0.0, 0.0, -0.008), fillY, 0.38, 0.056);

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
        const float h = 0.0012;
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
          float h = 0.02 + 0.08 * float(i) / 4.0;
          float d = mapScene(pos + h * nor).x;
          occ += (h - d) * sca;
          sca *= 0.72;
        }
        return clamp(1.0 - 2.1 * occ, 0.0, 1.0);
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

      vec3 F_Schlick(float cosTheta, vec3 F0) {
        return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
      }

      // Escala graduada preta + símbolo °C gravados no mostrador branco do termômetro
      float thermoScaleMask(vec2 p) {
        float m = 0.0;

        // Símbolo ° (anel no topo esquerdo da dupla °C, separado com nitidez da letra C)
        float degRing = abs(length(p - vec2(0.068, 0.432)) - 0.013) - 0.005;
        m = max(m, 1.0 - smoothstep(-0.002, 0.003, degRing));

        // Letra C nítida e encorpada com abertura limpa para a direita
        vec2 pc = p - vec2(0.122, 0.378);
        float cRing = abs(length(pc) - 0.032) - 0.010;
        float cOpen = step(0.005, pc.x) * (1.0 - smoothstep(0.018, 0.024, abs(pc.y)));
        float cMask = (1.0 - smoothstep(-0.002, 0.003, cRing)) * (1.0 - cOpen);
        m = max(m, cMask);

        // 13 traços horizontais de graduação abaixo do °C (y de -0.22 a +0.28)
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

      void main() {
        vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
        float canvasMask = smoothstep(0.49, 0.34, length(uv));

        // Câmera de estúdio
        vec3 ro = vec3(0.0, 0.04, 2.52);
        vec3 ta = vec3(0.0, -0.03, 0.0);
        vec3 ww = normalize(ta - ro);
        vec3 uu = normalize(cross(ww, vec3(0.0, 1.0, 0.0)));
        vec3 vv = normalize(cross(uu, ww));
        vec3 rd = normalize(uv.x * uu + uv.y * vv + 1.72 * ww);

        vec3 keyDir = normalize(vec3(0.52 + u_mouse.x * 0.25, 0.72 + u_mouse.y * 0.20, 0.65));
        vec3 fillDir = normalize(vec3(-0.65, 0.30, 0.58));
        vec3 rimDir = normalize(vec3(0.10, 0.60, -0.80));

        float t = 0.0;
        float mat = -1.0;
        for (int i = 0; i < 70; i++) {
          vec3 pos = ro + rd * t;
          vec2 h = mapScene(pos);
          if (h.x < 0.0012) {
            mat = h.y;
            break;
          }
          t += h.x;
          if (t > 4.2) break;
        }

        vec3 col = vec3(0.0);
        float alpha = 0.0;

        // Halo volumétrico reativo atrás do Sol 3D (u_kind == 0): cresce conforme a geração solar (u_val)
        if (u_kind == 0) {
          vec2 sunScreen = vec2(-0.14, 0.12);
          float dSun2D = length(uv - sunScreen);
          float glowStrength = (0.12 + 0.58 * u_val) * canvasMask;
          float sunHalo = exp(-dSun2D * mix(5.8, 3.4, u_val)) * glowStrength;
          col = vec3(1.0, 0.80, 0.18);
          alpha = clamp(sunHalo, 0.0, 0.85);
        }

        // Sombra de contato suave sob o modelo
        float floorY = u_kind == 2 ? -0.68 : -0.52;
        if (rd.y < -0.001 && mat < 0.0) {
          float tf = (floorY - ro.y) / rd.y;
          if (tf > 0.0 && tf < 3.6) {
            vec3 pf = ro + rd * tf;
            float distCenter = length(pf.xz * vec2(0.95, 1.25));
            float sh = 1.0 - calcSoftShadow(pf + vec3(0.0, 0.02, 0.0), normalize(vec3(0.15, 0.95, 0.2)), 0.02, 1.4, 7.5);
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
          float ao = calcAO(pos, N);

          vec3 albedo = vec3(0.5);
          float metalness = 0.08;
          float roughness = 0.32;
          float clearcoat = 0.15;
          vec3 emissive = vec3(0.0);

          if (u_kind == 0) {
            if (mat > 9.5) {
              // Mat 10: Sol 3D + 6 raios capsulares (brilho aumenta com a geração solar u_val)
              albedo = mix(vec3(0.95, 0.78, 0.14), vec3(1.0, 0.90, 0.26), u_val);
              metalness = 0.05;
              roughness = 0.28;
              clearcoat = 0.20;
              float rimSun = pow(1.0 - max(dot(N, V), 0.0), 2.2);
              emissive = vec3(1.0, 0.80, 0.15) * (0.22 + 0.85 * u_val + rimSun * 0.45 * u_val);
            } else if (mat < 1.5) {
              // Mat 1: Moldura branca/prata arredondada da placa solar
              albedo = vec3(0.91, 0.94, 0.97);
              metalness = 0.22;
              roughness = 0.20;
              clearcoat = 0.55;
            } else if (mat < 2.5) {
              // Mat 2: 12 Células solares azuis 3D arredondadas (idênticas à imagem 1, sem saturar para ciano)
              albedo = mix(vec3(0.06, 0.30, 0.68), vec3(0.10, 0.40, 0.78), clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
              metalness = 0.08;
              roughness = 0.24;
              clearcoat = 0.25;
              emissive = vec3(0.04, 0.16, 0.42) * 0.14 + vec3(0.85, 0.62, 0.14) * u_val * 0.06;
            } else {
              // Mat 3: Base e colunas metálicas prateadas do pedestal
              albedo = vec3(0.80, 0.83, 0.86);
              metalness = 0.65;
              roughness = 0.24;
              clearcoat = 0.35;
              // Reflexo sutil verde-oliva na quina direita da base como na referência
              float cornerTint = smoothstep(0.15, 0.45, pos.x) * smoothstep(-0.35, -0.50, pos.y);
              albedo = mix(albedo, vec3(0.48, 0.56, 0.42), cornerTint * 0.45);
            }
          } else if (u_kind == 1) {
            vec3 pBat = toBatteryLocal(pos);
            if (mat < 1.5) {
              // Mat 1: Corpo grafite fosco da bateria automotiva
              albedo = vec3(0.22, 0.23, 0.25);
              metalness = 0.12;
              roughness = 0.38;
              clearcoat = 0.15;
            } else if (mat > 10.5) {
              // Mat 11: Alça superior preta fosca
              albedo = vec3(0.13, 0.14, 0.16);
              metalness = 0.10;
              roughness = 0.44;
            } else if (mat > 4.5 && mat < 5.5) {
              // Mat 5: Polo positivo vermelho vivo (+)
              albedo = vec3(0.90, 0.26, 0.19);
              metalness = 0.08;
              roughness = 0.24;
              clearcoat = 0.45;
            } else if (mat > 3.5 && mat < 4.5) {
              // Mat 4: Polo negativo azul-aço (-)
              albedo = vec3(0.32, 0.49, 0.66);
              metalness = 0.12;
              roughness = 0.24;
              clearcoat = 0.45;
            } else {
              // Mat 6: Símbolo do raio 3D frontal — vai enchendo e se completando conforme u_val (SOC)
              // O raio vai de pBat.y = -0.32 (ponta inferior, 0%) até pBat.y = +0.18 (topo, 100%)
              float hBolt = clamp((pBat.y - (-0.32)) / 0.50, 0.0, 1.0);
              float fillLvl = clamp(u_val, 0.0, 1.0);
              float isFilled = 1.0 - smoothstep(fillLvl - 0.018, fillLvl + 0.018, hBolt);
              float meniscus = exp(-pow((hBolt - fillLvl) * 34.0, 2.0)) * step(0.02, fillLvl) * step(fillLvl, 0.99);

              // Parte preenchida: amarelo-ouro luminoso; parte a preencher: relevo 3D dourado-âmbar sólido
              vec3 boltFullCol = u_val < 0.20 ? vec3(0.96, 0.32, 0.20) : vec3(1.0, 0.78, 0.14);
              vec3 boltEmptyCol = vec3(0.66, 0.50, 0.18);

              albedo = mix(boltEmptyCol, boltFullCol, isFilled);
              metalness = mix(0.16, 0.08, isFilled);
              roughness = mix(0.28, 0.16, isFilled);
              clearcoat = 0.65;
              emissive = boltFullCol * (isFilled * 0.42 + 0.08) + vec3(1.0, 0.94, 0.65) * meniscus * 0.75;
            }
          } else {
            // u_kind == 2: Termômetro 3D em cápsula com escala °C e bulbo reativo
            vec3 pTh = toThermoLocal(pos);
            if (mat < 3.5) {
              // Mat 3: Corpo lateral prateado + Aro frontal azul-ardósia escuro (idêntico à imagem 3)
              float isFrontBezel = smoothstep(0.035, 0.055, pTh.z);
              vec3 sideSilver = vec3(0.76, 0.80, 0.86);
              vec3 bezelNavy = vec3(0.25, 0.32, 0.45);
              albedo = mix(sideSilver, bezelNavy, isFrontBezel);
              metalness = mix(0.30, 0.18, isFrontBezel);
              roughness = 0.24;
              clearcoat = 0.45;
            } else if (mat < 4.5) {
              // Mat 4: Berço azul-aço ao redor do tubo e do bulbo
              albedo = vec3(0.36, 0.49, 0.66);
              metalness = 0.18;
              roughness = 0.22;
              clearcoat = 0.55;
            } else if (mat < 7.5) {
              // Mat 7: Mostrador branco interno com símbolo °C e traços de escala pretos
              float marks = thermoScaleMask(pTh.xy);
              albedo = mix(vec3(0.96, 0.97, 0.99), vec3(0.08, 0.10, 0.13), marks);
              metalness = 0.02;
              roughness = mix(0.20, 0.35, marks);
              clearcoat = 0.25;
              emissive = vec3(0.18, 0.19, 0.20) * (1.0 - marks);
            } else if (mat > 11.5) {
              // Mat 12: Parte superior do tubo capilar de vidro azulado (acima do líquido)
              albedo = vec3(0.38, 0.52, 0.70);
              metalness = 0.15;
              roughness = 0.08;
              clearcoat = 1.0;
              // Reflexo vertical branco de tubo de vidro
              float glassStrip = smoothstep(0.022, 0.004, abs(pTh.x - (-0.032)));
              emissive = vec3(0.75, 0.85, 0.96) * glassStrip * 0.42;
            } else {
              // Mat 8: Bulbo e coluna líquida — nível e cor reagem à temperatura real (u_aux em °C)
              float tempC = u_aux;
              vec3 cCold   = vec3(0.12, 0.48, 0.96); // <= 16°C: Azul frio
              vec3 cMild   = vec3(0.08, 0.72, 0.54); // ~20°C: Verde-esmeralda
              vec3 cNormal = vec3(0.94, 0.22, 0.16); // ~26.5°C+: Vermelho termômetro clássico
              vec3 cHot    = vec3(0.82, 0.04, 0.12); // >= 40°C: Carmesim crítico

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
              roughness = 0.07;
              clearcoat = 1.0;

              // Reflexos vítreos brancos no bulbo e na haste (idênticos à imagem 3)
              float tubeHighlight = smoothstep(0.018, 0.003, abs(pTh.x - (-0.032))) * step(-0.22, pTh.y);
              float bulbDot1 = smoothstep(0.038, 0.012, length(pTh.xy - vec2(-0.015, -0.35)));
              float bulbDot2 = smoothstep(0.042, 0.010, length(pTh.xy - vec2(-0.105, -0.33))) * 0.55;
              emissive = liqColor * 0.28 + vec3(0.95, 0.97, 1.0) * (tubeHighlight * 0.45 + bulbDot1 * 0.75 + bulbDot2);
            }
          }

          // Iluminação de estúdio PBR (suave e limpa como render 3D de produto)
          float NdotL = max(dot(N, keyDir), 0.0);
          float NdotV = max(dot(N, V), 0.001);
          vec3 H = normalize(keyDir + V);
          float NdotH = max(dot(N, H), 0.0);
          float VdotH = max(dot(V, H), 0.0);

          float shadow = calcSoftShadow(pos + N * 0.006, keyDir, 0.02, 1.4, 8.0);
          shadow = mix(0.45, 1.0, shadow);

          vec3 F0 = mix(vec3(0.04), albedo, metalness);
          vec3 F = F_Schlick(VdotH, F0);
          float D = D_GGX(NdotH, roughness);
          vec3 spec = (D * F) / (4.0 * max(NdotL * NdotV, 0.08));

          vec3 kD = (1.0 - F) * (1.0 - metalness);
          vec3 direct = (kD * albedo + spec * 0.45) * NdotL * shadow * 1.15;

          float fillDiff = max(dot(N, fillDir), 0.0);
          vec3 fill = albedo * vec3(0.88, 0.92, 1.0) * fillDiff * 0.42 * ao;

          float rim = pow(1.0 - NdotV, 3.0) * max(dot(N, rimDir), 0.0);
          vec3 rimLight = vec3(0.95, 0.97, 1.0) * rim * 0.30;

          float ccSpec = 0.0;
          if (clearcoat > 0.01) {
            ccSpec = D_GGX(NdotH, 0.09) * shadow * NdotL * clearcoat * 0.22;
          }

          vec3 amb = albedo * (0.52 + 0.18 * N.y) * ao;
          vec3 objCol = amb + direct + fill + rimLight + vec3(ccSpec) + emissive;

          // Mapeamento suave de tom mantendo cores vibrantes e fiéis às referências
          objCol = clamp(objCol, 0.0, 1.0);

          col = objCol;
          alpha = 1.0;
        }

        gl_FragColor = vec4(col * alpha, alpha);
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

    // 1. Brilho do Sol proporcional à geração da placa solar (0..1)
    const pvRatio =
      this.state.pvUtilization > 0
        ? this.state.pvUtilization / 50
        : this.state.pvPower / 200;
    const pvTarget = this.state.online && (this.state.generating || this.state.pvPower > 0.5)
      ? Math.max(0.22, Math.min(1.0, pvRatio))
      : 0.05;

    // 2. Nível de preenchimento do raio da bateria (0..1 conforme SOC)
    const socTarget = Math.max(0.0, Math.min(1.0, this.state.soc / 100));

    // 3. Nível da coluna do termômetro (0..1 mapeado de 0°C a 50°C)
    const tempTarget = Math.max(0.08, Math.min(0.96, this.state.temp / 48));
    const darkTarget = this.state.dark ? 1.0 : 0.0;

    let anyMoving = false;

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

      if (
        Math.abs(targetVal - sc.smoothVal) > 0.002 ||
        Math.abs(targetAux - sc.smoothAux) > 0.01 ||
        Math.abs(darkTarget - sc.smoothDark) > 0.005 ||
        Math.abs(sc.targetMouseX - sc.mouseX) > 0.003 ||
        Math.abs(sc.targetMouseY - sc.mouseY) > 0.003 ||
        sc.hovered
      ) {
        anyMoving = true;
      }

      if (sc.gl && sc.program) {
        this.renderWebGLScene(sc, now * 0.001);
      } else if (sc.ctx2d) {
        this.renderFallback2D(sc);
      }
    });

    if (!this.reducedMotion && (anyMoving || now < this.activeUntil)) {
      this.rafId = requestAnimationFrame((t) => this.loop(t));
    }
  }

  renderWebGLScene(sc, timeSec) {
    const gl = sc.gl;
    gl.useProgram(sc.program);
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
