# Código do Projeto

Estrutura do Stream Sentry:

- `backend/`: API em Go com autenticação JWT, persistência em **MongoDB**, orquestração dos testes (pool de usuários virtuais com Puppeteer) e WebSocket de telemetria
- `frontend/`: interface em React (Vite) com landing page, login/cadastro, configuração de teste, auditoria em tempo real e histórico com exportações

## Pré-requisitos

- Go 1.21+
- Node.js 18+
- **MongoDB** em execução (padrão: `mongodb://localhost:27017`, banco `stream_sentry`) — coleções criadas automaticamente: `users`, `test_history`, `telemetry_events`, `counters`

## Como executar

1. Backend:
   - Copie `backend/.env.example` para `backend/.env` (ajuste `MONGODB_URI`/`MONGODB_DB` se necessário)
   - Em `backend/puppeteer`, execute `npm install` (dependências do runner)
   - Em `backend/`, execute:
     - `go mod tidy`
     - `go run .`

2. Frontend:
   - Copie `frontend/.env.example` para `frontend/.env` (opcional)
   - Em `frontend/`, execute:
     - `npm install`
     - `npm run dev`

## Configuração do teste (pela interface)

Tudo é configurável na tela **Iniciar teste**:

- **URL da API**: alvo do teste. Botões auxiliares criam salas automaticamente:
  - **Criar sala Whereby** (requer `WHEREBY_API_KEY` no `.env`)
  - **Gerar sala Jitsi** (usa `JITSI_BASE_URL`, padrão `meet.jit.si`)
- **Token de acesso**: enviado como Bearer nas requisições; **opcional para Jitsi e Whereby** (o runner não envia `Authorization` a esses domínios)
- **Usuários virtuais (1 a 50)**: concorrência inicial do pool; ajustável ao vivo na aba Auditoria. Para **Whereby** o campo é limitado a **4** (restrição do plano gratuito) e é resetado para 1 ao selecionar uma sala Whereby
- **Duração da chamada (90 a 1800 s)**: tempo que cada usuário virtual permanece na chamada coletando métricas. A contagem exibida na Auditoria **só inicia quando todos os usuários entram na chamada e seus dados começam a alimentar os gráficos**; por isso o tempo total do teste pode ser maior que o configurado
- **Modo do navegador (Puppeteer)**: alterna headless/não-headless pela interface. Para salas **Jitsi**, a janela do usuário virtual 1 sempre aparece (login manual). Com 10+ usuários, um aviso recomenda manter o modo headless
- **Chaos (rede)**: perfil de falhas aplicado via CDP (3G lenta, alta latência, offline, instável etc.), alterável durante o teste

## Ciclo de vida do teste

- **Iniciar teste** na UI (ou `POST /test/start` com `Authorization: Bearer <JWT>` e JSON `{ "apiUrl", "accessToken", "virtualUsers", "callDurationSec", "headful", "chaos": { "profile" } }`).
- O servidor roda o pool em `puppeteer/run-audit.mjs` (`STREAM_SENTRY_POOL=1`): mantém N usuários na chamada e permite ajustar a concorrência ao vivo (`control.json`).
- **Finalização automática**: quando um usuário virtual completa a duração da chamada (`user_done`), o pool entra em **drenagem** — para de repor usuários, aguarda os demais saírem (tolerância de 90 s para travados) e encerra; o status na Auditoria muda para **Finalizado**.
- **Finalizar teste** na UI ou `POST /test/stop` encerra antecipadamente (emite `test_stopped`).
- Apenas um teste por vez; `/test/start` com teste ativo responde **409**, assim como `/test/stop` sem teste ativo.
- Salvaguarda no servidor: o processo é cancelado se exceder a duração da chamada + 5 minutos (margem para a entrada dos usuários).

## Auditoria em tempo real

- O frontend abre `GET /ws/telemetry?token=<JWT>` e recebe eventos NDJSON (requisições, respostas, falhas, eventos de entrada nas salas, `webrtc_stats`).
- Telemetria **WebRTC**: o runner injeta um hook em `RTCPeerConnection` e amostra `getStats()` no estilo *webrtc-internals* (RTP in/out, par ICE, transporte, jitter, RTT, frames). Intervalo: `WEBRTC_STATS_INTERVAL_MS` (padrão 2000). O Chromium sobe com mídia simulada para salas que pedem câmera/microfone.
- **Gráficos por usuário**: com até 7 usuários, cada um recebe uma das 7 cores do arco-íris; acima disso, tonalidades por família de métrica. KPIs com tooltips explicativos.
- Painel de controle ao vivo: pausar/retomar, ajustar concorrência do pool e trocar o perfil de rede (chaos) a qualquer momento.
- Com vários usuários, cada Chromium roda em uma **Worker Thread** (`STREAM_SENTRY_WORKER_THREADS=1`, padrão). Para depurar no mesmo event loop: `STREAM_SENTRY_WORKER_THREADS=0`.

## Histórico e relatórios

- Cada teste gera eventos NDJSON persistidos no **MongoDB** e um resumo agregado (contagens HTTP, RTT/jitter, amostras WebRTC).
- A aba **Histórico** lista as sessões, permite **reabrir a auditoria** de qualquer sessão (mesma tela, reconstruída do log) e exportar:
  - JSON (resumo) e CSV (resumo ampliado)
  - JSON/CSV completos por sessão, com todos os eventos

## Testar com Whereby (automação completa)

1. Configure `WHEREBY_API_KEY` no `.env` (em `https://whereby.com` → Developers → API keys).
2. Clique em **Criar sala Whereby** — a URL é preenchida automaticamente e o número de usuários é ajustado.
3. Inicie o teste: os usuários entram sozinhos como convidados, sem login.

**Limitação**: o plano gratuito do Whereby permite no máximo **4 participantes simultâneos** por sala — a interface avisa e limita o campo.

## Testar com Jitsi Meet (até 50 usuários)

1. Clique em **Gerar sala Jitsi** ou informe `https://meet.jit.si/SuaSalaUnica`.
2. Ao iniciar o teste, a janela do **usuário virtual 1 (anfitrião)** abre visivelmente: faça o **login com o Google manualmente** (o Google bloqueia logins automatizados). Os demais usuários entram como **convidados automaticamente** quando o anfitrião abre a sala.
3. Para não repetir o login a cada teste, configure um **perfil Chrome persistente**: `JITSI_CHROME_PROFILE_DIR=C:/Users/voce/.jitsi-chrome-profile` no `.env` — a sessão Google fica salva e é reaproveitada (funciona com 2FA).
4. Entrada na pré-sala: clique via DOM + **`ghost-cursor`** (movimento de mouse semelhante ao humano). Desligar: `JITSI_USE_GHOST_CURSOR=0`.

Variáveis úteis (ver `.env.example` para a lista completa):

- `JITSI_CLAIM_HOST=1` — sempre reivindicar anfitrião após entrar
- `JITSI_GUEST_MODE=1` ou `JITSI_CLAIM_HOST=0` — nunca tocar no fluxo de anfitrião
- `JITSI_AUTH_EMAIL` / `JITSI_AUTH_PASSWORD` — login automático por credenciais (sem 2FA; pode ser bloqueado pelo Google)
- `JITSI_DEBUG_PAUSE_MS` — tempo de pausa para login manual (padrão ~120 s)
- `JITSI_HOST_BUTTON_WAIT_SEC` — espera pelo botão «Sou o anfitrião» (0 desliga)

**Nota:** se o Chromium mostrar **Não seguro** ou erro de certificado no `meet.jit.si` (antivírus / inspeção HTTPS), suba o backend com `PUPPETEER_IGNORE_HTTPS_ERRORS=1` e confira a data/hora do Windows.

## Zoom (integrado, sem automação viável)

O driver do Zoom permanece no projeto: o runner reconhece links (`zoom.us/j/...`, `zoom.us/wc/...`), converte `/j/<id>` para o web client (`/wc/join/<id>`) e não envia `Authorization` a esses domínios. `ZOOM_PASSCODE` e `ZOOM_DISPLAY_NAME` podem ser configurados no `.env`.

**Na prática, o Zoom não é viável para os testes automatizados**: o web client detecta e bloqueia bots (CAPTCHA, verificação de comportamento) e, mesmo com ingresso manual, expõe apenas parte das estatísticas WebRTC esperadas. Use Whereby (testes pequenos) ou Jitsi (escala) — o Zoom fica disponível apenas para uso manual/exploratório.

## Smoke test do Puppeteer

- O botão **Testar Puppeteer** roda um acesso simples ao alvo e salva evidências em `backend/puppeteer/artifacts/<timestamp>/`:
  - `access-log.json` (requests, responses e falhas)
  - `final-page.png` (screenshot final)
