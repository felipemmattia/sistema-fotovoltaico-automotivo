# Guia de Conexão Física (Hardware & Pinagem)

Este documento detalha o esquema elétrico e a pinagem oficial entre a placa **Waveshare ESP32-S3-RS485-CAN** e a controladora de carga solar **Epever XTRA 2210N MPPT**.

---

## 1. Conector RJ45 da Controladora Epever XTRA 2210N

A porta de comunicação RS485 da controladora Epever XTRA 2210N utiliza um conector RJ45 de 8 vias com a seguinte pinagem padrão:

| Pino RJ45 Epever | Sinal / Função | Descrição | Conexão na Waveshare ESP32-S3-RS485-CAN |
| :---: | :--- | :--- | :--- |
| **Pino 1** | `+5V DC` | Alimentação auxiliar (+5V, máx. 50 mA) | *Não conectar* (Alimentar o ESP32-S3 via conversor 12V→5V) |
| **Pino 2** | `+5V DC` | Alimentação auxiliar (+5V, máx. 50 mA) | *Não conectar* |
| **Pino 3** | **RS485-A** | Linha diferencial positiva (Data +) | Borne **RS485 A** |
| **Pino 4** | **RS485-A** | Linha diferencial positiva (Data +) | Borne **RS485 A** |
| **Pino 5** | **RS485-B** | Linha diferencial negativa (Data -) | Borne **RS485 B** |
| **Pino 6** | **RS485-B** | Linha diferencial negativa (Data -) | Borne **RS485 B** |
| **Pino 7** | **GND** | Referência de terra do barramento | Borne **GND** |
| **Pino 8** | **GND** | Referência de terra do barramento | Borne **GND** |

> [!IMPORTANT]
> Conecte sempre o **GND** (Pino 7 ou 8 do cabo RJ45) ao borne **GND** da placa Waveshare ESP32-S3 para garantir a mesma referência de potencial entre os transceptores RS485 e evitar erros de CRC no barramento.

---

## 2. Pinagem Interna da Placa Waveshare ESP32-S3-RS485-CAN

Na placa **Waveshare ESP32-S3-RS485-CAN**, o transceptor RS485 embarcado está conectado aos seguintes pinos do microcontrolador ESP32-S3 (configurados em `esphome/epever_solar_esp32s3.yaml`):

| Função no Firmware ESPHome | Pino GPIO ESP32-S3 | Descrição |
| :--- | :---: | :--- |
| **UART TX (`tx_pin`)** | `GPIO 17` | Entrada de dados (DI) do transceptor RS485 integrado |
| **UART RX (`rx_pin`)** | `GPIO 18` | Saída de leitura (RO) do transceptor RS485 integrado |
| **Controle de Direção (`flow_control_pin`)** | `GPIO 21` | Controle Half-Duplex (DE / $\overline{\text{RE}}$) do transceptor RS485 |

- **Parâmetros Seriais da Epever XTRA 2210N**: `115200 bps`, `8` bits de dados, sem paridade (`NONE`), `1` stop bit (`8N1`), endereço escravo Modbus `0x01`.

---

## 3. Sensor Externo de Temperatura da Bateria (NTC)

O sistema utiliza o sensor de temperatura externo (termistor NTC conectado à entrada dedicada de sonda térmica da controladora Epever XTRA 2210N e fixado junto à bateria):
- A controladora disponibiliza a leitura real dessa sonda externa no registrador Modbus `0x3110` (e espelhado em `0x311B`), com resolução de $0{,}01\,^\circ\text{C}$.
- O firmware lê diretamente `0x3110` e publica o valor em `external_temp`, sem necessidade de cabos adicionais até o ESP32-S3.

---

## 4. Alimentação Elétrica no Ambiente Automotivo

- Utilize um conversor **DC-DC Step-Down (Buck) automotivo de 12V/24V para 5V (mínimo 2 A)** com fusível de proteção de $2\,\text{A}$ na linha positiva.
- Alimente a placa Waveshare ESP32-S3 pela porta USB-C ou pelos terminais de alimentação $5\,\text{V}/\text{GND}$.
