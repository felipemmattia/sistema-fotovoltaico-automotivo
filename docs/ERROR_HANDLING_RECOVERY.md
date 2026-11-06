# Tratamento de Erros, Diagnóstico Modbus e Estratégia de Recuperação

Este documento detalha os mecanismos de tolerância a falhas, decodificação de alarmes de hardware da controladora Epever XTRA 2210N e recuperação automática em todas as camadas do sistema.

---

## 1. Matriz de Resiliência por Camada

| Camada | Evento / Falha | Mecanismo de Proteção e Recuperação |
| :--- | :--- | :--- |
| **Barramento RS485** | Ruído eletromagnético ou leitura corrompida | Verificação de CRC16 Modbus, descarte de `NaN` e *clamping* estrito de faixa física |
| **Controladora MPPT** | Sobretensão, subtensão, superaquecimento ou curto | Leitura contínua dos registradores `0x3200`, `0x3201` e `0x3202` + alerta visual no cabeçalho |
| **Comunicação Serial** | Cabo RS485 desconectado ou controladora desligada | Timeout de 180 segundos (3 min) com transição automática para estado `Offline` |
| **Rede Wi-Fi do Veículo** | Afastamento da rede principal | Reconexão automática + criação de Access Point próprio de contingência no ESP32-S3 |
| **Persistência Backend** | Desligamento abrupto de bateria/alimentação | Escrita atômica sequencial (Write-Ahead Log em `.jsonl`), preservando o histórico |
| **Clientes Distantes** | Sinal Wi-Fi fraco ou perda de pacotes | Cache local via Service Worker + retransmissão cooperativa entre navegadores via WebRTC Mesh P2P |

---

## 2. Diagnóstico de Erros e Alarmes da Controladora (Cabeçalho do Dashboard)

O módulo [`dashboard/backend/validators.js`](../dashboard/backend/validators.js) e o controlador [`dashboard/frontend/js/app.js`](../dashboard/frontend/js/app.js) decodificam em tempo real os três registradores de diagnóstico da Epever XTRA 2210N:

### 2.1 Registrador `0x3200` — Status da Bateria
- **Bits `D3..D0` (Alarme de Tensão da Bateria)**:
  - `0x00`: Normal
  - `0x01`: **Sobretensão na bateria** (`BAT_OVERVOLT`)
  - `0x02`: **Subtensão na bateria** (`BAT_UNDERVOLT`)
  - `0x03`: **Desconexão por descarga profunda — LVD** (`BAT_LVD`)
  - `0x04`: **Falha interna na bateria** (`BAT_FAULT`)
- **Bits `D7..D4` (Alarme de Temperatura da Bateria — Sensor NTC)**:
  - `0x00`: Normal
  - `0x01`: **Superaquecimento na bateria** (`BAT_OVERTEMP`)
  - `0x02`: **Temperatura baixa crítica na bateria** (`BAT_LOWTEMP`)
- **Bit `D8`**: **Resistência interna anormal da bateria** (`BAT_INT_RES`)
- **Bit `D15`**: **Identificação incorreta da tensão nominal do sistema** (`SYS_VOLT_ERR`)

### 2.2 Registrador `0x3201` — Status do Equipamento de Carregamento
- **Bits `D15..D14` (Status da Tensão de Entrada Solar FV)**:
  - `0x02`: **Sobretensão na entrada FV (painéis)** (`PV_OVERVOLT`)
  - `0x03`: **Erro de tensão na entrada FV** (`PV_VOLT_ERR`)
- **Bit `D13`**: **MOSFET de carregamento em curto-circuito** (`CHG_MOSFET_SHORT`)
- **Bit `D12`**: **MOSFET de carregamento ou anti-reverso aberto** (`CHG_MOSFET_OPEN`)
- **Bit `D11`**: **MOSFET anti-reverso em curto-circuito** (`ANTIREV_MOSFET_SHORT`)
- **Bit `D10`**: **Sobrecorrente na entrada FV** (`PV_OVERCURRENT`)
- **Bit `D9`**: **Sobrecorrente na saída de carga** (`LOAD_OVERCURRENT`)
- **Bit `D8`**: **Curto-circuito na saída de carga** (`LOAD_SHORT`)
- **Bit `D4`**: **Entrada FV em curto-circuito** (`PV_SHORT`)
- **Bits `D3..D2` (Estágio de Carregamento)**:
  - `00`: Em espera / Sem carregamento
  - `01`: **Flutuação (Float)**
  - `02`: **Boost (Absorção)**
  - `03`: **Equalização**
- **Bit `D1`**: **Falha interna na controladora MPPT** (`CTRL_FAULT`)

### 2.3 Registrador `0x3202` — Status do Equipamento de Descarga
- **Bit `D11`**: **Curto-circuito na saída de descarga** (`DIS_OUT_SHORT`)
- **Bit `D5`**: **Sobretensão no estágio Boost** (`BOOST_OVERVOLT`)
- **Bit `D4`**: **Sobrecorrente na saída** (`DIS_OVERCURRENT`)

Sempre que qualquer um desses bits de falha é ativado (ou caso as grandezas elétricas/térmicas ultrapassem os limites de segurança), o cabeçalho do dashboard exibe imediatamente o alerta correspondente com o endereço do registrador diagnóstico.
