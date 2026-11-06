# Automotive Photovoltaic Telemetry System

> **Real-time telemetry, fault diagnostics, interactive 3D WebGL instrumentation, and peer-to-peer (WebRTC) mesh relay for an automotive solar power system built around the Epever XTRA 2210N MPPT charge controller and the Waveshare ESP32-S3-RS485-CAN microcontroller.**

*[🇬🇧 English](#english-version) | [🇧🇷 Português Brasileiro](#versão-em-português-brasileiro)*

---

<a id="english-version"></a>

## 🇬🇧 English Version

### Overview

This project is a Capstone Thesis (*Trabalho de Conclusão de Curso — TCC*) developed at **SENAI**, implementing an end-to-end hardware and software telemetry platform for an automotive photovoltaic system. It reads electrical, thermal, statistical, and fault-diagnostic registers from an **Epever XTRA 2210N MPPT** solar charge controller over an industrial **RS485 Modbus RTU** bus (`115200 bps, 8N1`) using a **Waveshare ESP32-S3-RS485-CAN** board and streams live updates to a web dashboard.

### Key Features

- **Industrial RS485 Modbus RTU Acquisition**:
  - Reads solar array voltage (`0x3100`), current (`0x3101`), and power (`0x3102`); battery charging voltage (`0x3104`), current (`0x3105`), power (`0x3106`), state of charge (`0x311A`), and external NTC battery temperature (`0x3110`); daily (`0x330C`) and cumulative (`0x3312`) energy generation.
- **Real-Time Controller Fault & Alarm Diagnostics (`0x3200` / `0x3201` / `0x3202`)**:
  - Decodes hardware status bitmasks in real time (battery overvoltage, undervoltage, deep-discharge LVD, battery overheating, MOSFET short/open faults, PV input overvoltage/short-circuit, load short/overcurrent, and active charging stage: *Boost*, *Float*, or *Equalization*) and displays alerts directly in the dashboard header.
- **Proximity-Adaptive Telemetry Rate (Wi-Fi RSSI + Active Viewers)**:
  - Automatically adjusts the ESP32-S3 reporting cadence between **1 s** (strong Wi-Fi signal, `>= -55 dBm`), **2 s** (`-70` to `-55 dBm`), **5 s** (`< -70 dBm`), and **10 s** when no users are viewing the dashboard.
- **Cooperative P2P Mesh Repeater (`WebRTC DataChannel` + Offline-First Service Worker)**:
  - Every connected browser acts as a **P2P telemetry repeater node**. Users closer to the vehicle automatically relay real-time telemetry packets across up to 3 hops over WebRTC `RTCDataChannel`s to users farther away, while a Service Worker caches static assets and 3D models locally so the interface loads instantaneously even under weak signal conditions.
- **Interactive 3D WebGL PBR Models & Reactive UI**:
  - Custom WebGL Physically Based Rendering (PBR) models that react to live telemetry:
    1. **Solar Module & 3D Sun**: Sun core and corona brightness scale with generated solar power.
    2. **Automotive Battery**: Front 3D lightning emblem fills progressively according to battery SOC (`%`).
    3. **NTC Thermometer**: Liquid column height and color shift dynamically with real battery temperature (`°C`).
  - **Animated SOC Progress Bar**: Smooth color gradient transitioning from red (discharged) through amber to emerald green (full), with left-to-right glowing particles whose speed and density scale with generated solar power.
  - **Estimated Time to Full Charge**: Computes remaining time to `100%` charge based on configured battery capacity ($\text{Ah} \times \text{V}$) and current charging power ($\text{W}$).
  - **Minute-by-Minute Historical Chart**: Downsamples time-series data into 1-minute buckets (`24 h`), 10-minute buckets (`7 d`), and 30-minute buckets (`30 d`), supporting Light and Dark themes.

### Project Structure

```text
├── esphome/
│   ├── epever_solar_esp32s3.yaml     # ESPHome firmware for Waveshare ESP32-S3-RS485-CAN
│   └── secrets.yaml.example          # Template for Wi-Fi credentials and webhook URL
├── dashboard/
│   ├── backend/
│   │   ├── server.js                 # Express HTTP API, WebSocket server & WebRTC signaling
│   │   ├── database.js               # Atomic append-only Write-Ahead Log (JSONL) persistence
│   │   ├── validators.js             # Input sanitization & Modbus 0x3200-0x3202 fault decoder
│   │   └── offlineDetector.js        # 3-minute communication timeout detector
│   ├── frontend/
│   │   ├── index.html                # Responsive dashboard interface (Light & Dark modes)
│   │   ├── sw.js                     # Offline-first Service Worker cache
│   │   ├── css/style.css             # Styling, tokens, schematic animations & responsive layout
│   │   └── js/
│   │       ├── app.js                # Main telemetry controller, SOC particle engine & ETA
│   │       ├── mesh.js               # WebRTC P2P DataChannel mesh repeater
│   │       ├── models3d.js           # Custom WebGL 3D PBR renderer (PV, Battery, Thermometer)
│   │       └── charts.js             # Historical time-series chart controller (Chart.js)
│   ├── Dockerfile                    # Production container image definition
│   └── docker-compose.yml            # Docker Compose service configuration
├── scripts/
│   ├── epever_modbus_bridge.ps1      # Direct USB-RS485 serial bridge for bench testing
│   └── start_public_tunnel.ps1       # Zero-cost public HTTPS tunnel (Cloudflare Quick Tunnel)
└── docs/
    ├── ARCHITECTURE.md               # System architecture, register table & data flow
    ├── HARDWARE_WIRING.md            # RJ45 pinout & Waveshare ESP32-S3 GPIO mapping
    ├── DEPLOYMENT_GUIDE.md           # Firmware flashing, Docker setup & free public hosting
    ├── ERROR_HANDLING_RECOVERY.md    # Fault matrix & Modbus 0x3200-0x3202 alarm decoding
    └── STACK_JUSTIFICATION.md        # Engineering decisions & clamping boundaries
```

### Quick Start

#### 1. Flash the ESP32-S3 Firmware
```bash
cd esphome
cp secrets.yaml.example secrets.yaml
# Edit secrets.yaml with your Wi-Fi SSID, password, and dashboard webhook URL
esphome run epever_solar_esp32s3.yaml
```

#### 2. Run the Dashboard Server (Docker)
```bash
cd dashboard
docker compose up -d --build
```
Open **`http://localhost:3000`** in your browser.

#### 3. Expose Publicly for Free (No Domain or Paid Server Required)
To share the live dashboard with evaluators and students at **SENAI** over a free public `https://` URL:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start_public_tunnel.ps1
```

---

<a id="versão-em-português-brasileiro"></a>

## 🇧🇷 Versão em Português Brasileiro

# Sistema de Telemetria Fotovoltaica Automotiva

> **Plataforma completa de telemetria em tempo real, diagnóstico de falhas, modelos 3D interativos em WebGL e retransmissão cooperativa em rede Mesh P2P (WebRTC) para sistema fotovoltaico automotivo, utilizando a controladora MPPT Epever XTRA 2210N e o microcontrolador Waveshare ESP32-S3-RS485-CAN.**

### Visão Geral

Este projeto integra o **Trabalho de Conclusão de Curso (TCC)** desenvolvido no **SENAI**, implementando uma solução ponta a ponta de hardware embarcado e software web para monitoramento de geração solar veicular. O sistema realiza a leitura contínua dos registradores elétricos, térmicos, estatísticos e de diagnóstico da controladora **Epever XTRA 2210N MPPT** via barramento industrial **RS485 Modbus RTU** (`115200 bps, 8N1`) com uma placa **Waveshare ESP32-S3-RS485-CAN** e transmite os dados em tempo real para o dashboard online.

### Principais Funcionalidades

- **Leitura Industrial RS485 Modbus RTU**:
  - Aquisição de tensão (`0x3100`), corrente (`0x3101`) e potência (`0x3102`) do arranjo solar; tensão (`0x3104`), corrente (`0x3105`), potência (`0x3106`), estado de carga (`0x311A`) e temperatura externa da bateria via sensor NTC (`0x3110`); energia gerada no dia (`0x330C`) e acumulada total (`0x3312`).
- **Diagnóstico de Erros e Alarmes da Controladora no Cabeçalho (`0x3200` / `0x3201` / `0x3202`)**:
  - Decodifica em tempo real os registradores de status e falhas da Epever (sobretensão, subtensão, desconexão por descarga profunda `LVD`, superaquecimento da bateria, curto-circuito ou abertura de MOSFETs, sobretensão/curto nos painéis FV, sobrecorrente na carga e estágio atual de carregamento: *Boost/Absorção*, *Flutuação* ou *Equalização*), exibindo alertas imediatamente no cabeçalho da página.
- **Cadência Adaptativa por Proximidade Wi-Fi (RSSI + Presença de Usuários)**:
  - Ajusta dinamicamente o intervalo de envio do ESP32-S3 entre **1 s** (sinal Wi-Fi forte, `>= -55 dBm`), **2 s** (`-70` a `-55 dBm`), **5 s** (`< -70 dBm`) e **10 s** quando não há espectadores conectados ao site.
- **Modo Repetidor Cooperativo em Rede Mesh P2P (`WebRTC DataChannel` + Service Worker Offline-First)**:
  - Cada pessoa com o site aberto atua automaticamente como um **nó repetidor P2P**. Usuários mais próximos do veículo retransmitem os pacotes de telemetria em tempo real (em até 3 saltos via WebRTC `RTCDataChannel`) para usuários mais afastados, enquanto o Service Worker mantém a interface e os modelos 3D em cache local para abertura instantânea mesmo sob sinal fraco. Quanto mais usuários conectados, maior o alcance e a resiliência para todos.
- **Modelos 3D PBR em WebGL e Interface Reativa**:
  - Modelos 3D físicos renderizados em tempo real via WebGL:
    1. **Placa Solar + Sol 3D**: O brilho e a coroa solar aumentam proporcionalmente à potência gerada.
    2. **Bateria Automotiva 3D**: O símbolo do raio frontal vai se preenchendo e completando conforme o nível de carga (`SOC %`).
    3. **Termômetro NTC 3D**: O nível e a cor da coluna líquida reagem à temperatura real medida na bateria (`°C`).
  - **Barra de Estado de Carga com Gradiente e Partículas**: Muda gradualmente de cor conforme o nível da bateria (vermelho quando muito descarregada até verde quando cheia) e emite partículas luminosas da esquerda para a direita cuja velocidade e quantidade aumentam conforme a potência gerada.
  - **Estimativa de Tempo para Carga Total**: Calcula na parte inferior da seção *"Circuito de conversão fotovoltaica"* quanto tempo a bateria levará para atingir `100%` com base na capacidade total configurada ($\text{Ah} \times \text{V}$) e na potência atual de geração ($\text{W}$).
  - **Gráfico Histórico Minuto a Minuto**: Exibe a curva histórica com amostragem de 1 minuto (`24 h`), 10 minutos (`7 dias`) ou 30 minutos (`30 dias`), com suporte completo a modo claro e escuro.

### Como Executar

#### 1. Gravar o Firmware no ESP32-S3
```bash
cd esphome
cp secrets.yaml.example secrets.yaml
# Preencha o arquivo secrets.yaml com o SSID/senha do Wi-Fi e a URL do servidor
esphome run epever_solar_esp32s3.yaml
```

#### 2. Iniciar o Servidor do Dashboard via Docker
```bash
cd dashboard
docker compose up -d --build
```
Acesse **`http://localhost:3000`** no navegador.

#### 3. Colocar o Site no Ar Gratuitamente para Apresentação no SENAI
Execute o script de túnel público gratuito (Cloudflare Quick Tunnel — sem custo de domínio nem de servidor):
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start_public_tunnel.ps1
```
O terminal fornecerá um endereço público `https://....trycloudflare.com` (com suporte a HTTPS, WebSockets `wss://` e Mesh P2P) que pode ser acessado de qualquer celular (4G/5G ou Wi-Fi) ou computador.

### Documentação Completa

- [Arquitetura do Sistema e Mapa de Registradores Modbus](docs/ARCHITECTURE.md)
- [Esquema Elétrico, Conector RJ45 e Pinagem do ESP32-S3](docs/HARDWARE_WIRING.md)
- [Guia de Implantação, Acesso Público Gratuito e Rede Mesh P2P](docs/DEPLOYMENT_GUIDE.md)
- [Tratamento de Erros, Diagnóstico Modbus e Recuperação](docs/ERROR_HANDLING_RECOVERY.md)
- [Justificativa Técnica da Stack e Limites de Sanitização](docs/STACK_JUSTIFICATION.md)
