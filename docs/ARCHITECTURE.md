# Arquitetura do Sistema de Telemetria Fotovoltaica Automotiva

O sistema é dividido em quatro camadas integradas para aquisição, validação, persistência e distribuição em tempo real das grandezas elétricas e térmicas do sistema fotovoltaico veicular:

1. **Camada de Aquisição Embarcada (Hardware & Firmware)**: Controladora MPPT **Epever XTRA 2210N** conectada via barramento **RS485 Modbus RTU (115200 bps, 8N1)** ao microcontrolador **Waveshare ESP32-S3-RS485-CAN** executando **ESPHome**.
2. **Camada de Ingestão, Diagnóstico e Persistência (Backend)**: Servidor **Node.js + Express + WebSocket (`ws`)**, decodificador de registradores de falha/alarme (`0x3200`–`0x3202`), controlador de cadência adaptativa por intensidade de sinal Wi-Fi (RSSI) e persistência sequencial atômica (**Write-Ahead Log em JSONL**).
3. **Camada de Visualização Interativa (Frontend)**: Interface web responsiva com temas claro e escuro, modelos 3D físicos em **WebGL PBR**, barra de estado de carga com gradiente cromático e partículas reativas, cálculo de tempo estimado para carga total e gráfico histórico com amostragem de 1 minuto.
4. **Camada de Retransmissão Cooperativa P2P (Rede Mesh entre Navegadores)**: Cada usuário conectado atua como um nó repetidor via **WebRTC DataChannel (`RTCDataChannel`)** e **Service Worker Offline-First**, retransmitindo pacotes em tempo real para dispositivos mais afastados do veículo.

---

## Diagrama de Arquitetura e Fluxo de Dados

```mermaid
flowchart TD
    subgraph "1. Sistema Embarcado no Veículo"
        PV["Arranjo Fotovoltaico"] -->|CC Alta Eficiência| MPPT["Controladora MPPT<br/>Epever XTRA 2210N"]
        BAT["Banco de Bateria 12V / 24V"] <-->|Carga Regulada| MPPT
        NTC["Sensor de Temperatura NTC<br/>(Conectado na Bateria)"] -->|Leitura Térmica| MPPT
        MPPT <-->|RS485 Modbus RTU<br/>115200 8N1<br/>Reg. 0x3100 / 0x3200 / 0x3300| ESP["Waveshare ESP32-S3 RS485<br/>Firmware ESPHome"]
    end

    subgraph "2. Transporte Sem Fio Adaptativo"
        ESP -->|HTTP POST /api/telemetry<br/>Cadência Dinâmica 1s a 10s<br/>conforme RSSI e clientes ativos| API["Servidor Express + WebSocket"]
    end

    subgraph "3. Processamento e Persistência"
        API -->|Sanitização + Decodificação<br/>Alarmes 0x3200..0x3202| VAL["Validador & Decodificador"]
        VAL -->|Append Atômico| WAL[("Histórico JSONL (WAL)<br/>+ Configurações")]
        VAL -->|Supervisão de Heartbeat (180s)| OFFLINE["Detector de Status Offline"]
    end

    subgraph "4. Visualização e Rede Mesh P2P (Navegadores / Smartphones)"
        API <-->|WebSocket Tempo Real + Sinalização| PEER1["Usuário Próximo ao Veículo<br/>(Nó Repetidor P2P)"]
        API <-.->|Sinal Fraco / Túnel HTTPS| PEER2["Usuário Distante do Veículo"]
        PEER1 <==>|WebRTC DataChannel P2P<br/>Retransmissão Multi-Salto| PEER2
    end
```

---

## Registradores Modbus RTU Lidos (Função `0x04` — Read Input Registers)

| Endereço | Grandeza | Tipo / Escala | Descrição |
| :---: | :--- | :---: | :--- |
| `0x3100` | Tensão de Entrada FV | `U_WORD` ($\div 100$) | Tensão nos terminais do painel solar ($\text{V}$) |
| `0x3101` | Corrente de Entrada FV | `U_WORD` ($\div 100$) | Corrente proveniente do painel solar ($\text{A}$) |
| `0x3102` | Potência de Entrada FV | `U_DWORD_R` ($\div 100$) | Potência instantânea gerada pelo arranjo ($\text{W}$) |
| `0x3104` | Tensão de Carga da Bateria | `U_WORD` ($\div 100$) | Tensão nos terminais da bateria ($\text{V}$) |
| `0x3105` | Corrente de Carga da Bateria | `U_WORD` ($\div 100$) | Corrente entregue à bateria ($\text{A}$) |
| `0x3106` | Potência de Carga da Bateria | `U_DWORD_R` ($\div 100$) | Potência entregue ao banco de baterias ($\text{W}$) |
| `0x3110` | Temperatura da Bateria | `S_WORD` ($\div 100$) | Sensor NTC externo posicionado na bateria ($^\circ\text{C}$) |
| `0x311A` | Estado de Carga (SOC) | `U_WORD` ($0\text{–}100\%$) | Percentual de carga atual da bateria ($\%$) |
| `0x311B` | Temperatura Remota RTS | `S_WORD` ($\div 100$) | Registrador complementar de temperatura da bateria ($^\circ\text{C}$) |
| `0x3200` | Status da Bateria | `U_WORD` (Bitmask) | Alarmes de sobretensão, subtensão, LVD, superaquecimento e tensão nominal |
| `0x3201` | Status do Carregador | `U_WORD` (Bitmask) | Estágio de carga (Boost/Float/Equalize), curto em MOSFET, sobrecorrente e falha FV |
| `0x3202` | Status da Descarga | `U_WORD` (Bitmask) | Curto-circuito na saída, sobrecorrente e falha de descarga |
| `0x330C` | Energia Gerada Hoje | `U_DWORD_R` ($\div 100$) | Produção diária acumulada ($\text{kWh}$) |
| `0x3312` | Energia Gerada Total | `U_DWORD_R` ($\div 100$) | Produção histórica acumulada ($\text{kWh}$) |

---

## Cadência Adaptativa por Proximidade Wi-Fi e Presença de Usuários

Para otimizar o consumo energético e de banda sem sacrificar a fluidez visual:
- **Sem usuários conectados ao site (`activeClients === 0`)**: O servidor instrui o ESP32-S3 (`next_interval_ms: 10000`) a enviar pacotes a cada **10 segundos**.
- **Com usuários visualizando o dashboard (`activeClients > 0`)**:
  - **Sinal Forte (`RSSI >= -55 dBm`)**: Atualização a cada **1 segundo (`1000 ms`)**.
  - **Sinal Médio (`-70 dBm <= RSSI < -55 dBm`)**: Atualização a cada **2 segundos (`2000 ms`)**.
  - **Sinal Fraco (`RSSI < -70 dBm`)**: Atualização a cada **5 segundos (`5000 ms`)**.
- **Gráfico Histórico**: Independentemente da velocidade de atualização dos cartões em tempo real, o gráfico histórico agrega os pontos **minuto a minuto (60 s)** nas visualizações de 24 horas.
