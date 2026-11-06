# Guia de Implantação, Acesso Público Gratuito e Rede Mesh P2P

Este guia descreve como gravar o firmware no ESP32-S3, iniciar o servidor localmente ou em container Docker e disponibilizar o dashboard gratuitamente na internet para visualização externa (como bancas e demonstrações no SENAI).

---

## 1. Gravação do Firmware no ESP32-S3 (ESPHome)

1. Acesse a pasta `esphome/`:
   ```bash
   cd esphome
   ```
2. Copie o arquivo de exemplo de credenciais para `secrets.yaml`:
   ```bash
   cp secrets.yaml.example secrets.yaml
   ```
3. Preencha os campos do seu `secrets.yaml` (este arquivo é ignorado pelo Git para proteger suas senhas):
   - `wifi_ssid` e `wifi_password`: Nome e senha da rede Wi-Fi ou roteador veicular.
   - `fallback_ap_ssid` e `fallback_ap_password`: Rede Wi-Fi própria criada pelo ESP32-S3 caso a rede principal não esteja disponível.
   - `dashboard_webhook_url`: URL do endpoint `/api/telemetry` do servidor.
   - `telemetry_api_key`: Chave de autenticação da API.
4. Compile e grave o firmware via USB-C:
   ```bash
   esphome run epever_solar_esp32s3.yaml
   ```

---

## 2. Execução do Servidor e Dashboard (Docker)

1. Acesse a pasta `dashboard/`:
   ```bash
   cd dashboard
   ```
2. Suba o serviço em segundo plano com Docker Compose:
   ```bash
   docker compose up -d --build
   ```
3. O dashboard estará disponível localmente em:
   - **`http://localhost:3000`**

---

## 3. Como Colocar o Site no Ar Gratuitamente (Sem Pagar Domínio ou Servidor)

Para que avaliadores, professores e alunos do **SENAI** acessem o dashboard em tempo real pelo celular (4G/5G ou Wi-Fi) sem custo de domínio nem mensalidade de hospedagem, o projeto inclui duas opções gratuitas:

### Opção 1 (Imediata — Recomendada para Apresentações no SENAI): Cloudflare Quick Tunnel
O script [`scripts/start_public_tunnel.ps1`](../scripts/start_public_tunnel.ps1) cria um túnel HTTPS público gratuito (`https://....trycloudflare.com`) direto para o seu container Docker local, com suporte completo a **WebSockets (`wss://`)** e **WebRTC Mesh P2P**:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start_public_tunnel.ps1
```
- O terminal exibirá uma URL pública segura (`https://nome-gerado.trycloudflare.com`).
- Basta enviar esse link ou gerar um QR Code para que qualquer pessoa no SENAI acesse a dashboard ao vivo pelo celular ou computador, sem precisar estar na mesma rede e sem pagar nada.

### Opção 2 (Hospedagem Nuvem Gratuita 24/7): Render.com Free Tier
Caso deseje manter uma instância na nuvem gratuitamente usando o `Dockerfile` incluso:
1. Crie uma conta gratuita em [https://render.com](https://render.com).
2. Clique em **New + → Web Service** e selecione o repositório GitHub deste projeto.
3. Defina **Root Directory** como `dashboard` e **Environment** como `Docker`.
4. Selecione o plano **Free ($0/mês)** e adicione a variável `TELEMETRY_API_KEY`.
5. Aponte o `dashboard_webhook_url` do ESP32-S3 para `https://seu-app.onrender.com/api/telemetry`.

---

## 4. Como Funciona o Modo Repetidor Cooperativo (Rede Mesh P2P + Hotspot)

Para garantir que mesmo usuários distantes do veículo consigam visualizar os dados em tempo real:

1. **Retransmissão P2P entre Navegadores (`WebRTC DataChannel` — Automático)**:
   - Assim que qualquer usuário abre o site, o módulo [`dashboard/frontend/js/mesh.js`](../dashboard/frontend/js/mesh.js) conecta automaticamente o navegador dele aos navegadores dos demais espectadores via **WebRTC DataChannel**.
   - Dispositivos mais próximos do carro (com sinal forte) retransmitem imediatamente cada pacote de telemetria recebido para os dispositivos mais distantes em até 3 saltos (*multi-hop*).
   - O painel **Telemetria e hardware** mostra em tempo real quantos nós repetidores estão ativos (`Rede Mesh P2P: Retransmitindo · N nós`).
2. **Cache Offline-First (`Service Worker`)**:
   - O [`dashboard/frontend/sw.js`](../dashboard/frontend/sw.js) armazena toda a interface gráfica e os modelos 3D no próprio aparelho no primeiro acesso. Assim, mesmo com sinal mínimo a dezenas de metros do carro, o site abre instantaneamente e precisa receber apenas pacotes leves de ~300 bytes.
3. **Repetição Física de Sinal Wi-Fi entre Smartphones (Wi-Fi Sharing)**:
   - Em smartphones Android modernos conectados ao Wi-Fi do veículo, basta ativar o **Roteador Wi-Fi (Hotspot) com Compartilhamento de Wi-Fi ativo** (*Wi-Fi Bridge / Repeater*). Dessa forma, o próprio celular de quem está perto do carro amplifica fisicamente a cobertura de rádio para quem está mais longe.
