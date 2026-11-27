# Justificativa Técnica da Stack, Renderização 3D PBR e Cálculos de Engenharia

Este documento apresenta a fundamentação técnica de todas as escolhas de hardware, firmware, backend, visualização 3D, infraestrutura gratuita e cálculos aplicados no projeto.

---

## 1. Justificativa das Escolhas de Hardware

| Componente | Escolha Adotada | Justificativa Técnica |
| :--- | :--- | :--- |
| **Controladora MPPT** | **Epever XTRA 2210N** (`20 A`, `100 V` FV) | Tecnologia MPPT com eficiência de rastreamento superior a 99,5% (essencial para extrair máxima potência do módulo de `200 Wp` em condições variáveis de sombra/sol urbano), porta RS485 Modbus RTU aberta e documentada, além de perfil `User-Defined` totalmente programável para bateria automotiva `12 V / 80 Ah`. |
| **Microcontrolador** | **Waveshare ESP32-S3-RS485-CAN** | Integra na mesma placa industrial o microcontrolador dual-core **ESP32-S3** (Wi-Fi, 16 MB Flash, 8 MB PSRAM, USB-C), transceptor **RS485 isolado** com controle automático de direção (`GPIO 21`) e suporte nativo a CAN para futuras expansões automotivas (OBD-II). |
| **Regulação de Tensão** | **Conversor Buck LM2596** (saída `Load` → `5,0 V`) | Os pinos `+5V` da porta RJ45 da Epever fornecem no máximo `50 mA`, insuficientes para picos de transmissão Wi-Fi do ESP32-S3 (`~350–500 mA`). O buck LM2596 ligado à saída `Load` entrega corrente folgada com proteção automática de descarga profunda (`LVD = 11,10 V`) gerenciada pela própria controladora. |
| **Sensor Térmico** | **Sonda NTC externa da Epever (`0x3110`)** | Permite medição direta da temperatura no corpo da bateria (e não apenas do ar interno do painel), alimentando simultaneamente a compensação térmica do carregamento MPPT e o termômetro 3D do dashboard sem fiação duplicada até o ESP32-S3. |

---

## 2. Justificativa das Escolhas de Software e Infraestrutura

| Camada | Tecnologia | Justificativa de Engenharia |
| :--- | :--- | :--- |
| **Firmware Embarcado** | **ESPHome (ESP-IDF 5.5)** | Declarativo, auditável e robusto: oferece driver Modbus RTU nativo com `flow_control_pin`, validação/clamping na borda, suporte a múltiplas redes Wi-Fi priorizadas, cliente HTTPS para descoberta dinâmica do servidor, OTA nativo criptografado na porta `3232` e *Fallback AP* integrado. |
| **Backend & Tempo Real** | **Node.js + Express + `ws`** | Consumo enxuto de memória (~35–50 MB RAM), arquitetura orientada a eventos ideal para multiplexar ingestão HTTP, WebSockets em tempo real e sinalização WebRTC simultaneamente, com execução 100% portátil no Windows sem exigir Docker ou privilégios de Administrador. |
| **Persistência de Dados** | **Write-Ahead Log (`telemetry_history.jsonl`)** | Append atômico linha a linha imune a corrupção estrutural (ao contrário de bancos relacionais embarcados sem *journaling* rígido em quedas de energia), dispensando compilação nativa de binários C++ no PC da sala de aula. |
| **Publicação Gratuita 24/7** | **DuckDNS + GitHub Pages + Cloudflare Tunnel** | Elimina custos de hospedagem/domínio e dispensa liberação de portas no firewall do SENAI, mantendo uma URL fixa profissional (`https://telemetriafv.duckdns.org`) com HTTPS ponta a ponta e atualização automática do túnel em `gh-pages/runtime-config.json`. |
| **Rede Cooperativa P2P** | **WebRTC `RTCDataChannel` + Service Worker** | Transforma cada navegador conectado em nó repetidor multi-salto (até 3 saltos) e mantém ativos estáticos em cache local, garantindo abertura rápida e continuidade de leitura sob conexões móveis instáveis. |
| **Visualização 3D e Gráficos** | **WebGL PBR Customizado (Smith-GGX) + Canvas 2D + Chart.js** | Renderização 3D física sob medida sem o peso de engines genéricas (`Three.js` / `Babylon.js` exigiriam centenas de KB extras), garantindo carregamento quase instantâneo em smartphones e controle exato de cada efeito visual reativo aos sensores. |

---

## 3. Engenharia do Motor 3D WebGL PBR (`dashboard/frontend/js/models3d.js`)

O dashboard renderiza três instrumentos 3D interativos desenvolvidos em **WebGL puro** com sombreamento **Physically Based Rendering (PBR — microfacetas Smith-GGX)** e projeção de lente teleobjetiva de baixa distorção:

1. **Módulo Fotovoltaico + Sol 3D:** painel monocristalino texturizado com moldura metálica e células definidas, inclinado em perspectiva diagonal coerente com os demais instrumentos; o núcleo solar e a coroa luminosa variam dinamicamente de intensidade conforme a potência gerada (`pv_power`).
2. **Bateria Automotiva 3D:** carcaça automotiva com polos positivos/negativos e emblema de raio frontal cujo preenchimento luminoso acompanha proporcionalmente o estado de carga (`battery_soc` de `0%` a `100%`).
3. **Termômetro NTC 3D:** bulbo e coluna de fluido com altura e transição cromática reativas à temperatura real da bateria (`external_temp` em `°C`).
4. **Eficiência Energética e Fluidez no Navegador:**
   - Renderização sob demanda com temporizador de repouso (`activeUntil`), evitando uso desnecessário de GPU em 60 fps quando os valores estão estáveis.
   - Fundo sólido limpo de alto contraste (tema claro e escuro) sem animações supérfluas em segundo plano.
   - Barra de SOC com gradiente contínuo (vermelho → âmbar → verde esmeralda) e partículas em Canvas 2D otimizado sem causar *layout reflow*.

---

## 4. Limites de Sanitização e Clamping (Defesa em Profundidade)

Os limites físicos são aplicados em **duas camadas independentes** — primeiro no firmware ([`esphome/epever_solar_esp32s3.yaml`](../esphome/epever_solar_esp32s3.yaml)) e novamente no backend ([`dashboard/backend/validators.js`](../dashboard/backend/validators.js)):

| Grandeza | Faixa Aceita (Clamping) | Padrão Seguro | Regra de Proteção / Alarme |
| :--- | :---: | :---: | :--- |
| Tensão FV (`pv_voltage`) | `0,0 V` – `120,0 V` | `0,0 V` | Alerta `PV_OVERVOLT` em `>= 95,0 V` (limite da XTRA 2210N: `100 V`) |
| Corrente FV (`pv_current`) | `0,0 A` – `30,0 A` | `0,0 A` | Proteção contra picos espúrios de leitura |
| Potência FV (`pv_power`) | `0,0 W` – `1000,0 W` | `0,0 W` | Rastreamento automático de potência de pico diária |
| Tensão da Bateria (`battery_voltage`) | `0,0 V` – `36,0 V` | `0,0 V` | Supervisão `>= 15,5 V`, `<= 11,2 V` (aviso) e `<= 10,6 V` (crítico) em `12 V` |
| Corrente da Bateria (`battery_current`) | `0,0 A` – `30,0 A` | `0,0 A` | Alerta acima da corrente nominal (`> 20,0 A`) |
| Potência da Bateria (`battery_power`) | `0,0 W` – `1000,0 W` | `0,0 W` | Base para cálculo de eficiência MPPT e estimativa de recarga |
| Estado de Carga (`battery_soc`) | `0 %` – `100 %` | `0 %` | Inteiro limitado em `[0, 100]` |
| Temperatura NTC (`external_temp`) | `-40,0 °C` – `85,0 °C` | `25,0 °C` | Aviso em `>= 44,0 °C` e erro crítico em `>= 50,0 °C` |

---

## 5. Cálculos de Engenharia Aplicados na Interface (`app.js`)

1. **Capacidade Energética Total da Bateria:**
   $$E_{\text{total}} = C_{\text{Ah}} \times V_{\text{nom}} \quad (\text{ex.: } 80\text{ Ah} \times 12\text{ V} = 960\text{ Wh})$$
2. **Energia Restante para Carga Total (`100%`):**
   $$E_{\text{restante}} = E_{\text{total}} \times \left(1 - \frac{\text{SOC}}{100}\right)$$
3. **Tempo Estimado para Carga Completa (ETA):**
   $$t_{\text{horas}} = \frac{E_{\text{restante}}}{P_{\text{carga}}}$$
   onde $P_{\text{carga}}$ é a potência líquida atual entregue à bateria ($\text{W}$). Quando $P_{\text{carga}} \le 0$ ou `SOC = 100%`, a interface informa claramente o estado correspondente em vez de exibir valores infinitos.
4. **Eficiência Instantânea de Conversão MPPT:**
   $$\eta_{\text{MPPT}} = \frac{P_{\text{bateria}}}{P_{\text{FV}}} \times 100\%$$
   calculada apenas quando há geração ativa ($P_{\text{FV}} > 1\text{ W}$), evitando divisão por zero à noite ou em ambiente fechado.
