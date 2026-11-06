# Justificativa Técnica da Stack e Decisões de Engenharia

## 1. Tecnologias Utilizadas

| Camada | Tecnologia | Justificativa de Engenharia |
| :--- | :--- | :--- |
| **Firmware Embarcado** | **ESPHome (ESP32-S3)** | Implementação nativa de Modbus RTU com controle de pino de direção RS485 (`GPIO 21`), watchdog de hardware, reconexão Wi-Fi automática, portal cativo de contingência e ajuste dinâmico da taxa de envio via resposta HTTP JSON. |
| **Backend & Tempo Real** | **Node.js + Express + `ws`** | Baixo consumo de memória (~35 MB RAM), ideal para execução containerizada e distribuição simultânea de pacotes via WebSockets e sinalização WebRTC. |
| **Rede Cooperativa P2P** | **WebRTC `RTCDataChannel` + Service Worker** | Transforma cada navegador conectado em um nó repetidor de telemetria em tempo real, ampliando o alcance efetivo para usuários distantes do veículo sem exigir infraestrutura extra. |
| **Persistência de Dados** | **Write-Ahead Log (`JSONL` Atômico)** | Gravação sequencial atômica imune a corrupção de banco de dados em cortes repentinos de alimentação típicos de sistemas veiculares. |
| **Visualização 3D e Gráfica** | **WebGL PBR Customizado + Canvas 2D + Chart.js** | Renderização 3D leve sem dependências pesadas externas: módulo solar reativo à irradiância, bateria 3D com preenchimento proporcional ao SOC, termômetro 3D reativo à temperatura NTC e barra de carga com partículas dinâmicas. |

---

## 2. Limites de Sanitização e Clamping (`validators.js`)

| Grandeza | Intervalo Aceito | Valor Padrão | Proteção Aplicada |
| :--- | :---: | :---: | :--- |
| Tensão FV (`pv_voltage`) | $0{,}0\,\text{V} \text{ – } 120{,}0\,\text{V}$ | $0{,}0\,\text{V}$ | Clamping + Alerta de sobretensão FV $\ge 95\,\text{V}$ |
| Corrente FV (`pv_current`) | $0{,}0\,\text{A} \text{ – } 30{,}0\,\text{A}$ | $0{,}0\,\text{A}$ | Clamping contra ruídos de leitura |
| Potência FV (`pv_power`) | $0{,}0\,\text{W} \text{ – } 1000{,}0\,\text{W}$ | $0{,}0\,\text{W}$ | Clamping + Rastreamento de pico diário |
| Tensão da Bateria (`battery_voltage`) | $0{,}0\,\text{V} \text{ – } 36{,}0\,\text{V}$ | $0{,}0\,\text{V}$ | Clamping + Supervisão de subtensão/sobretensão ($12\,\text{V}/24\,\text{V}$) |
| Corrente da Bateria (`battery_current`) | $0{,}0\,\text{A} \text{ – } 30{,}0\,\text{A}$ | $0{,}0\,\text{A}$ | Clamping + Alerta acima da corrente nominal ($20\,\text{A}$) |
| Estado de Carga (`battery_soc`) | $0\% \text{ – } 100\%$ | $0\%$ | Clamping inteiro $[0, 100]$ |
| Temperatura da Bateria (`external_temp`) | $-40{,}0\,^\circ\text{C} \text{ – } 85{,}0\,^\circ\text{C}$ | $25{,}0\,^\circ\text{C}$ | Clamping + Alerta térmico em temperaturas elevadas ($\ge 44\,^\circ\text{C}$) ou críticas ($\ge 50\,^\circ\text{C}$) |
