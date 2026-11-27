# Tratamento de Erros, Diagnóstico Modbus, Resiliência e Soluções de Campo

Este documento consolida todos os mecanismos de tolerância a falhas do sistema, a tabela completa de decodificação dos alarmes da **Epever XTRA 2210N** e o registro técnico dos problemas reais encontrados durante a implantação no veículo e na infraestrutura do SENAI — junto com a solução definitiva adotada para cada um.

---

## 1. Matriz de Resiliência por Camada

| Camada | Falha / Evento | Mecanismo de Proteção e Recuperação Automática |
| :--- | :--- | :--- |
| **Barramento RS485** | Ruído eletromagnético automotivo ou quadro corrompido | Verificação CRC16 Modbus RTU, filtro `filter_out: nan` e *clamping* físico no ESP32-S3 e no backend |
| **Controladora MPPT** | Sobretensão, subtensão, LVD, superaquecimento ou curto de MOSFET | Leitura contínua de `0x3200`, `0x3201` e `0x3202` + alerta visual imediato no cabeçalho do dashboard |
| **Comunicação Serial / Veículo Desligado** | Cabo RS485 solto, perda de Wi-Fi ou bateria desconectada | Timeout de **180 segundos (3 min)** (`offlineDetector.js`) com transição imediata para `Offline` e limpeza de valores para `—` |
| **Rede Wi-Fi do Veículo** | Saída de alcance ou indisponibilidade de uma rede | Lista Multi-Wi-Fi com prioridades (hotspot de contingência em prioridade 100 + redes institucionais) + *Fallback AP* |
| **Túnel HTTPS / Queda de Internet na Sala** | Oscilação da rede ou reinício do PC da sala | Supervisor [`start_public_tunnel.ps1`](../scripts/start_public_tunnel.ps1) testa `/api/health` a cada 45 s (tolerância de 5 falhas), recria o túnel e atualiza `gh-pages/runtime-config.json`; ESP32-S3 descobre a nova URL em ~15 s via `raw.githubusercontent.com` |
| **Persistência em Disco** | Queda repentina de energia no servidor | Escrita sequencial atômica (*Write-Ahead Log* em `telemetry_history.jsonl`); linhas corrompidas são descartadas com segurança na leitura |
| **Interface Web (Offline / Sinal Fraco)** | Perda temporária de conexão do celular/notebook | Service Worker (`sw.js`) mantém UI em cache; configurações salvam localmente e sincronizam ao reconectar; WebRTC Mesh P2P retransmite pacotes entre espectadores |

---

## 2. Política Estrita de Estado Offline (Zero Dados Falsos ou Obsoletos)

Uma regra crítica de engenharia adotada neste projeto é **jamais apresentar medições antigas como se fossem ao vivo**:
- Se o servidor não receber pacotes do ESP32-S3 por mais de **180 segundos** (ou logo após iniciar antes do primeiro pacote), `GET /api/telemetry/latest` retorna `status.online = false` e `data = null`.
- O frontend ([`dashboard/frontend/js/app.js`](../dashboard/frontend/js/app.js)) limpa imediatamente todas as leituras em tempo real para **`—`**, apaga a coroa solar/partículas da barra de carga e exibe o selo **`Offline`** no cabeçalho, evitando interpretações enganosas durante avaliações técnicas.

---

## 3. Decodificação Completa dos Alarmes Modbus (`validators.js`)

O módulo [`dashboard/backend/validators.js`](../dashboard/backend/validators.js) decodifica em tempo real os três registradores diagnósticos da controladora **Epever XTRA 2210N** (tanto via envio direto HTTPS quanto pelo coletor fallback local `ESP_SENSOR_MAP`):

### 3.1 Registrador `0x3200` — Status da Bateria
- **Bits `D3..D0` (Tensão da Bateria):**
  - `0x00`: Normal
  - `0x01`: **Sobretensão na bateria** (`BAT_OVERVOLT` — erro)
  - `0x02`: **Subtensão na bateria** (`BAT_UNDERVOLT` — aviso)
  - `0x03`: **Desconexão por descarga profunda — LVD** (`BAT_LVD` — erro)
  - `0x04`: **Falha na bateria** (`BAT_FAULT` — erro)
- **Bits `D7..D4` (Temperatura da Bateria — Sensor NTC):**
  - `0x00`: Normal
  - `0x01`: **Superaquecimento na bateria** (`BAT_OVERTEMP` — erro)
  - `0x02`: **Temperatura baixa crítica na bateria** (`BAT_LOWTEMP` — aviso)
- **Bit `D8` (`0x0100`):** **Resistência interna anormal da bateria** (`BAT_INT_RES` — aviso)
- **Bit `D15` (`0x8000`):** **Identificação incorreta da tensão nominal** (`SYS_VOLT_ERR` — erro)

### 3.2 Registrador `0x3201` — Status do Equipamento de Carregamento
- **Bits `D15..D14` (Tensão de Entrada FV):**
  - `0x02`: **Sobretensão na entrada FV (painéis)** (`PV_OVERVOLT` — erro)
  - `0x03`: **Erro de tensão na entrada FV** (`PV_VOLT_ERR` — erro)
- **Bit `D13` (`0x2000`):** **MOSFET de carregamento em curto-circuito** (`CHG_MOSFET_SHORT`)
- **Bit `D12` (`0x1000`):** **MOSFET de carregamento ou anti-reverso aberto** (`CHG_MOSFET_OPEN`)
- **Bit `D11` (`0x0800`):** **MOSFET anti-reverso em curto-circuito** (`ANTIREV_MOSFET_SHORT`)
- **Bit `D10` (`0x0400`):** **Sobrecorrente na entrada FV** (`PV_OVERCURRENT`)
- **Bit `D9` (`0x0200`):** **Sobrecorrente na saída de carga** (`LOAD_OVERCURRENT`)
- **Bit `D8` (`0x0100`):** **Curto-circuito na saída de carga** (`LOAD_SHORT`)
- **Bit `D7` (`0x0080`):** **MOSFET de carga em curto-circuito** (`LOAD_MOSFET_SHORT`)
- **Bit `D6` (`0x0040`):** **Desequilíbrio nos circuitos internos** (`CIRCUIT_DISEQ` — aviso)
- **Bit `D4` (`0x0010`):** **Entrada FV em curto-circuito** (`PV_SHORT`)
- **Bits `D3..D2` (Estágio de Carregamento Ativo):**
  - `00`: Em espera / Sem carregamento (`null`)
  - `01`: **`Flutuação`** (*Float*)
  - `02`: **`Boost (Absorção)`**
  - `03`: **`Equalização`**
- **Bit `D1` (`0x0002`):** **Falha interna na controladora MPPT** (`CTRL_FAULT`)

### 3.3 Registrador `0x3202` — Status do Equipamento de Descarga
- **Bit `D11` (`0x0800`):** **Curto-circuito na saída de descarga** (`DIS_OUT_SHORT`)
- **Bit `D10` (`0x0400`):** **Falha ao interromper descarga** (`DIS_STOP_ERR`)
- **Bit `D8` (`0x0100`):** **Tensão de saída anormal** (`DIS_VOLT_ABNORMAL` — aviso)
- **Bit `D6` (`0x0040`):** **Curto-circuito no barramento de alta tensão** (`HV_SIDE_SHORT`)
- **Bit `D5` (`0x0020`):** **Sobretensão no estágio Boost** (`BOOST_OVERVOLT`)
- **Bit `D4` (`0x0010`):** **Sobrecorrente na saída** (`DIS_OVERCURRENT`)

### 3.4 Verificações Complementares por Limites Físicos
Mesmo se um registrador de status estiver zerado, `validators.js` aplica redundância por limites físicos proporcionais à tensão nominal (`scale = 1` para `12 V`, `scale = 2` para `24 V`):
- Tensão da bateria: `>= 15,5 V` (`BAT_OVERVOLT`), `<= 11,2 V` (`BAT_UNDERVOLT`), `<= 10,6 V` (`BAT_LVD`).
- Tensão FV: `>= 95,0 V` (`PV_OVERVOLT`, próximo ao limite de `100 V` da XTRA 2210N).
- Temperatura NTC: `>= 50,0 °C` (erro crítico) / `>= 44,0 °C` (aviso).
- Corrente de carga: `> 20,0 A` (acima da corrente nominal da XTRA 2210N).

---

## 4. Registro de Engenharia: Problemas Reais Encontrados e Soluções Definitivas

Durante os testes em bancada, instalação na Amarok e migração para o servidor da sala de aula, foram diagnosticados e solucionados os seguintes problemas reais:

1. **Travamento do navegador ao abrir o dashboard:**
   - *Causa raiz:* shader WebGL com função RGSS duplicada em `models3d.js`, loop `requestAnimationFrame` contínuo em 60 fps sem repouso e chamadas `getBoundingClientRect()` em 60 fps dentro de `SocBarAnimator` causando *layout reflow thrashing*.
   - *Solução:* limpeza do shader, restauração do modo de repouso (`activeUntil`) quando os modelos 3D estão estáticos e cache de dimensões fora do loop de animação.
2. **Falha de atualização OTA via interface Web HTTP (porta 80) em ~58%:**
   - *Causa raiz:* o antigo loop síncrono de `http_request.post` com timeout de `10 s` travava a fila TCP do ESP-IDF durante o recebimento do binário OTA pela porta 80.
   - *Solução:* redução do timeout HTTP para `3 s`, ativação do **OTA nativo criptografado do ESPHome na porta `3232`** (via uma única gravação USB-C) — atualizações subsequentes passaram a concluir 100% sem fio em 12–27 segundos.
3. **Atraso de 60–90 s e limite da API do GitHub (60 req/h) na descoberta do túnel:**
   - *Causa raiz:* o frontend consultava `api.github.com` antes de `raw.githubusercontent.com` (sujeito a *rate-limit* sem token) e o ESP32-S3 consultava apenas o GitHub Pages (`telemetriafv.duckdns.org/runtime-config.json`), que leva até 90 s para propagar o CDN após cada reinício do servidor.
   - *Solução:* tanto `app.js` quanto `epever_solar_esp32s3.yaml` passaram a priorizar `raw.githubusercontent.com/.../runtime-config.json?_=<timestamp>` (com fallback no DuckDNS), reduzindo a reconexão pós-reinício para **~15 segundos**.
4. **Bloqueio de `winget` e falta de permissão de Administrador no PC da sala do SENAI:**
   - *Causa raiz:* políticas corporativas do Windows impedem execução do `winget` e instaladores administrativos.
   - *Solução:* atualização do [`scripts/start_public_tunnel.ps1`](../scripts/start_public_tunnel.ps1) para baixar automaticamente versões portáteis oficiais do **Node.js**, **GitHub CLI (`gh`)** e **`cloudflared`** dentro da pasta do usuário (`scripts/bin/`), rodando 100% sem privilégios administrativos.
5. **Redes Wi-Fi WPA3/isoladas ou com *Captive Portal*:**
   - *Causa raiz:* testes práticos no pátio mostraram que a rede WPA2 da sala/oficina fornece internet direta e libera túneis Cloudflare, enquanto outra rede institucional WPA3 conectava sem acesso à internet.
   - *Solução:* remoção das redes sem internet da lista do ESP32-S3 e definição de prioridade `100` para o hotspot pessoal de resgate e `60` para a rede WPA2 institucional validada.
6. **Rompimento mecânico do condutor negativo comum e bloqueador de ignição:**
   - *Causa raiz:* interrupção física do fio negativo em comum derrubou a comunicação e alimentação do módulo; posteriormente, o bloqueador da chave impediu a partida durante os testes na oficina.
   - *Solução:* refeita a conexão firme do negativo comum, validado o barramento com o veículo no pátio e confirmada geração solar real ao vivo.
