# Guia Completo de Implantação, Servidor 24/7 Portátil, Multi-Wi-Fi e OTA Sem Fio

Este guia documenta passo a passo como o sistema completo foi implantado em produção para o TCC no **SENAI**, abrangendo desde a gravação inicial do firmware ESP32-S3, atualizações sem fio (OTA), domínio fixo gratuito até o servidor 24/7 portátil no computador cabeado da sala de aula.

---

## 1. Arquitetura de Publicação Gratuita com Domínio Fixo (`https://telemetriafv.duckdns.org`)

Para oferecer um endereço profissional, fixo, com HTTPS válido e **custo zero** (sem alugar VPS e sem depender de IP público fixo na rede do SENAI), combinamos quatro serviços gratuitos:

1. **DuckDNS (`telemetriafv.duckdns.org`)**: fornece o subdomínio gratuito com registro DNS `A` apontado para o IP do GitHub Pages (`185.199.108.153`).
2. **GitHub Pages (branch `gh-pages`)**: hospeda permanentemente o frontend estático (`index.html`, `css/`, `js/`, `sw.js`, `CNAME` e `runtime-config.json`) com certificado TLS/HTTPS automático.
3. **Cloudflare Quick Tunnel (`cloudflared`)**: executado no computador cabeado da sala de aula, cria um túnel HTTPS/WSS criptografado de saída para `http://localhost:3000` sem precisar abrir portas no roteador/firewall da escola.
4. **Resolução Dinâmica (`runtime-config.json`)**: sempre que o servidor da sala inicia ou renova o túnel, o script [`scripts/start_public_tunnel.ps1`](../scripts/start_public_tunnel.ps1) publica automaticamente a nova URL `https://....trycloudflare.com` em `gh-pages/runtime-config.json` via API do GitHub. Tanto o **navegador** ([`dashboard/frontend/js/app.js`](../dashboard/frontend/js/app.js)) quanto o **ESP32-S3 na Amarok** ([`esphome/epever_solar_esp32s3.yaml`](../esphome/epever_solar_esp32s3.yaml)) consultam `raw.githubusercontent.com` com *cache-buster* e passam a conversar com o servidor novo automaticamente em poucos segundos!

> [!TIP]
> **Por que o computador da sala pode ser 100% cabeado (sem Wi-Fi)?**
> Porque o ESP32-S3 envia os dados por **HTTPS através do túnel público**. A Amarok pode estar conectada no Wi-Fi WPA2 do pátio/sala ou no hotspot 4G/5G de um celular, enquanto o servidor fica no cabo de rede da sala de aula — eles não precisam estar na mesma sub-rede local!

---

## 2. Firmware do ESP32-S3: Multi-Wi-Fi, Descoberta Instantânea e OTA Sem Fio

### 2.1 Configuração de Credenciais (`esphome/secrets.yaml`)

O arquivo [`esphome/secrets.yaml`](../esphome/secrets.yaml) é estritamente ignorado pelo Git (`.gitignore`) para nunca expor senhas institucionais ou pessoais. Crie-o a partir do modelo [`esphome/secrets.yaml.example`](../esphome/secrets.yaml.example):

```bash
cd esphome
cp secrets.yaml.example secrets.yaml
```

No [`esphome/epever_solar_esp32s3.yaml`](../esphome/epever_solar_esp32s3.yaml#L24-L48), o Wi-Fi utiliza o bloco `networks:` com prioridades decrescentes (e **sem** `fast_connect: true`, para permitir escaneamento completo e escolha pela maior prioridade):
- **Prioridade `100` (Chave Mestra / Resgate):** hotspot pessoal do smartphone. Se for necessário manutenção/OTA de emergência perto do carro, basta ligar o hotspot que o ESP32-S3 sempre dá preferência a ele.
- **Prioridades `60` a `15`:** redes Wi-Fi institucionais WPA2-PSK **sem página de login (*captive portal*)** e com saída real para internet.

> [!WARNING]
> **Atenção a redes com *Captive Portal* ou sem internet:** se uma rede Wi-Fi exigir página de login no navegador ou estiver sem saída para internet (ex.: rede WPA3 interna isolada), o ESP32-S3 conecta ao Wi-Fi mas fica impedido de alcançar o túnel HTTPS. Sempre teste primeiro no celular se a rede abre `https://telemetriafv.duckdns.org` diretamente sem pedir login; redes reprovadas devem ser removidas do `networks:`.

### 2.2 Primeira Gravação via Cabo USB-C

Seguindo os cuidados elétricos descritos em [HARDWARE_WIRING.md](HARDWARE_WIRING.md) (alimentação externa desligada + notebook na bateria):

```powershell
# Compila e grava na porta COM detectada (ex.: COM5)
esphome run --device COM5 .\esphome\epever_solar_esp32s3.yaml
```

### 2.3 Atualizações Futuras 100% Sem Fio (OTA Nativo — Porta `3232`)

Com o firmware atual gravado, o ESP32-S3 expõe o protocolo **OTA nativo criptografado do ESPHome na porta `3232`** (muito mais rápido e confiável do que o upload HTTP na porta 80). Para atualizar sem precisar abrir o painel da Amarok nem conectar cabo USB-C:

```powershell
# Pelo nome mDNS (mesma rede Wi-Fi)
esphome run --no-logs --device epever-solar-esp32s3.local .\esphome\epever_solar_esp32s3.yaml

# Ou diretamente pelo IP local do ESP32-S3
esphome run --no-logs --device 10.193.218.104 .\esphome\epever_solar_esp32s3.yaml
```

### 2.4 Como Funciona a Descoberta Instantânea do Túnel no ESP32-S3

No bloco `interval:` de [`esphome/epever_solar_esp32s3.yaml`](../esphome/epever_solar_esp32s3.yaml#L528-L614):
1. Ao ligar (ou após 2 falhas consecutivas de envio HTTP POST caso o servidor da sala reinicie e gere um novo túnel), o ESP32-S3 executa `GET` em:
   `https://raw.githubusercontent.com/felipemmattia/sistema-fotovoltaico-automotivo/gh-pages/runtime-config.json?_=<millis>`
2. O parâmetro `?_=<millis>` elimina atrasos de cache CDN (Fastly/GitHub Pages), fazendo o veículo descobrir o túnel novo em **~10 a 15 segundos** (em vez de aguardar 60–90 s do build do GitHub Pages).
3. Se por qualquer motivo o `raw.githubusercontent.com` falhar, o firmware realiza fallback automático em `https://telemetriafv.duckdns.org/runtime-config.json`.

---

## 3. Implantação no Computador Cabeado da Sala de Aula (Modo 100% Portátil)

Em computadores institucionais (como os laboratórios do SENAI), ferramentas como `winget`, instaladores `.msi` e Docker Desktop frequentemente são bloqueados por falta de privilégios de Administrador.

Para resolver isso definitivamente, o script [`scripts/start_public_tunnel.ps1`](../scripts/start_public_tunnel.ps1) foi tornado **100% autossuficiente e portátil**:
- Detecta automaticamente se `node` e `gh` existem no sistema; caso contrário, baixa e extrai as versões oficiais portáteis (**Node.js v22 LTS** e **GitHub CLI `gh`**) dentro de `scripts/bin/`.
- Baixa automaticamente o cliente oficial **`cloudflared-windows-amd64.exe`** em `scripts/bin/`.
- Instala automaticamente as dependências de produção do backend (`npm install --production`).
- Solicita autenticação no GitHub (`gh auth login --web`) **uma única vez** na primeira execução interativa.
- Registra o atalho silencioso **`TelemetriaFV_Servidor_24_7.lnk`** em `shell:startup` (pasta *Inicializar* do usuário), iniciando tudo invisível (`-WindowStyle Hidden`) sempre que o PC ligar.

### Comando Único de Instalação no PC da Sala (PowerShell — sem Admin)

Basta colar e executar esta única linha no PowerShell do usuário no computador da sala:

```powershell
[Net.ServicePointManager]::SecurityProtocol=3072; iwr https://github.com/felipemmattia/sistema-fotovoltaico-automotivo/archive/refs/heads/main.zip -OutFile tcc.zip -UseBasicParsing; Expand-Archive tcc.zip TelemetriaFV -Force; cd TelemetriaFV\sistema-fotovoltaico-automotivo-main; .\iniciar_servidor_24_7.bat
```

### Boas Práticas Operacionais no Servidor da Sala
1. **Apenas 1 servidor ativo por vez:** ao migrar o serviço para o PC da sala, desative o supervisor e remova o atalho `TelemetriaFV_Servidor_24_7.lnk` do notebook de desenvolvimento para evitar que dois computadores sobrescrevam o `runtime-config.json` um do outro.
2. **Opções de Energia do Windows:** configure *"Suspender atividade do computador"* como **Nunca**.
3. **Queda de Energia / Reinício:**
   - Após reiniciar e entrar no usuário do Windows, o atalho em `shell:startup` sobe tudo sozinho em ~25–30 segundos.
   - Para religamento automático do gabinete após falta de luz, habilite **`Restore on AC Power Loss -> Power On`** na BIOS/UEFI (caso disponível).
4. **Arquivo `.env.duckdns` (opcional):** o IP `185.199.108.153` do GitHub Pages já permanece salvo fixo no DuckDNS; caso deseje validação automática periódica pelo script, basta criar `.env.duckdns` na raiz com `DUCKDNS_DOMAIN=telemetriafv` e `DUCKDNS_TOKEN=<SEU_TOKEN>` (arquivo ignorado pelo Git).

---

## 4. Alternativas de Execução (Docker e Nuvem)

### 4.1 Execução Local com Docker Compose
```bash
cd dashboard
docker compose up -d --build
# Acesse http://localhost:3000
```

### 4.2 Hospedagem em Nuvem Gratuita (Render.com)
O arquivo [`render.yaml`](../render.yaml) e o [`dashboard/Dockerfile`](../dashboard/Dockerfile) permitem subir uma instância na nuvem em 1 clique no plano gratuito do Render (definindo a variável `TELEMETRY_API_KEY`).

---

## 5. Rede Mesh P2P Cooperativa (`mesh.js`) e Service Worker (`sw.js`)

1. **Retransmissão P2P entre Navegadores (`WebRTC DataChannel`):**
   - Cada usuário conectado ao dashboard estabelece canais `RTCDataChannel` diretos com os demais espectadores (sinalizados pelo WebSocket do servidor).
   - Pacotes recebidos com menor latência são retransmitidos em até **3 saltos (*multi-hop*)** com deduplicação por ID, ampliando a resiliência quando o sinal móvel ou Wi-Fi oscila.
   - O painel *Telemetria e hardware* exibe em tempo real o status da malha (`Rede Mesh P2P · N nós`).
2. **Cache Offline-First (`dashboard/frontend/sw.js`):**
   - Estratégia *Network-First com fallback para cache* para HTML, CSS e scripts (incluindo o motor 3D WebGL), sem nunca interceptar `/api/` ou `runtime-config.json` (evitando exibição de dados obsoletos).
3. **Persistência Offline-First das Configurações do Veículo:**
   - Alterações de nome do veículo, capacidade da bateria (`Ah`), tensão nominal (`V`) ou potência do painel (`kWp`) são salvas imediatamente em `localStorage` e sincronizadas automaticamente com `POST /api/settings` assim que a conexão com o servidor estiver ativa.
