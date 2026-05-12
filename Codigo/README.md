# Código do Projeto

Estrutura criada para o Stream Sentry:

- `backend/`: API de autenticação com JWT em Go
- `frontend/`: interface em React (Vite) com login e registro

## Como executar

1. Backend:
   - Copie `backend/.env.example` para `backend/.env`
   - Em `backend/`, execute:
     - `go mod tidy`
     - `go run .`
   - Para habilitar o smoke test de integração com Puppeteer:
     - em `backend/puppeteer`, execute `npm install`

2. Frontend:
   - Copie `frontend/.env.example` para `frontend/.env` (opcional)
   - Em `frontend/`, execute:
     - `npm install`
     - `npm run dev`

## Evidências de acesso com Puppeteer

- O smoke test salva evidências em `backend/puppeteer/artifacts/<timestamp>/`:
  - `access-log.json` (requests, responses e falhas)
  - `final-page.png` (screenshot final)
- Para modo visual (ideal para gravar vídeo de demonstração), inicie o backend com:
  - `PUPPETEER_HEADFUL=1 PUPPETEER_SLOW_MO=250 go run .`

## Teste de auditoria (Puppeteer + tempo real)

- Após login, use **Iniciar teste** na UI (ou `POST /test/start` com `Authorization: Bearer <JWT>` e JSON `{ "apiUrl", "accessToken", "virtualUsers" }`).
- **Finalizar teste** na UI ou `POST /test/stop` (com o mesmo Bearer) cancela o processo Node/Puppeteer no servidor e emite `test_stopped` no WebSocket.
- O frontend abre `GET /ws/telemetry?token=<JWT>` e recebe eventos NDJSON (requisições, respostas, falhas) enquanto roda `puppeteer/run-audit.mjs`.
- Apenas um teste por vez no servidor; se já houver um em execução, a API responde **409** em novo `/test/start`; `/test/stop` sem teste ativo responde **409**.
- Telemetria **WebRTC**: o script injeta um hook em `RTCPeerConnection` e envia eventos `webrtc_stats` (campos de `getStats()` no estilo *webrtc-internals*: RTP in/out, par ICE, transporte, jitter, frames). Intervalo opcional: `WEBRTC_STATS_INTERVAL_MS` (padrão 2000). O Chromium do Puppeteer sobe com flags de mídia simulada para salas que pedem câmera/microfone.
- Com vários usuários virtuais, cada Chromium roda em uma **Worker Thread** separada (`STREAM_SENTRY_WORKER_THREADS=1`, padrão no backend) para evitar que um único event loop do Node atrase as coletas de `getStats()`. Para depuração, use `STREAM_SENTRY_WORKER_THREADS=0`.
- Permanência na página após o carregamento: `AUDIT_PAGE_DWELL_MS` (padrão **8000** ms). Para Jitsi, prefira **20000–45000** para a chamada estabilizar e aparecerem métricas.

## Testar com Jitsi Meet (recomendado)

1. Crie um nome de sala único, por exemplo `StreamSentryTesteSeuNome`.
2. Em **URL da API** use: `https://meet.jit.si/StreamSentryTesteSeuNome` (HTTPS).
3. Em **token de acesso** pode usar qualquer texto não vazio (ex.: `public-jitsi`) — só valida o formulário no Stream Sentry; o runner **não** envia `Authorization` ao `meet.jit.si` (evita conflitos com o fluxo do Meet).
4. Use **1 usuário virtual** na primeira vez; depois aumente com cuidado (cada um abre um Chromium).
5. Opcional para depuração: no diretório `backend`, `PUPPETEER_HEADFUL=1 PUPPETEER_SLOW_MO=300 AUDIT_PAGE_DWELL_MS=30000 go run .`
6. Abra **Auditoria** antes de **Iniciar teste** para ver o WebSocket; o feed mostra se o clique na pré-sala Jitsi funcionou (`jitsi_prejoin`).
7. Entrada na pré-sala: além do clique via DOM, o runner usa a lib **`ghost-cursor`** (movimento de rato semelhante ao humano) nos botões conhecidos do Jitsi. Desligar: `JITSI_USE_GHOST_CURSOR=0`.
8. Para **ver a janela** e o fluxo de conta / Sign in / anfitrião: `PUPPETEER_HEADFUL=1 JITSI_DEBUG_LOGIN_UI=1` (no `.env` do `backend` ou variáveis ao lançar `go run .`). Pausa automática de ~**90s** após tentar abrir a UI; `JITSI_DEBUG_PAUSE_MS=120000` ajusta o tempo, `=0` remove a pausa. O feed de auditoria mostra `jitsi_login_ui_reveal` e `jitsi_debug_pause`.
9. Após **Entrar** pode aparecer **«Sou o anfitrião»** (abre o Google). **Por omissão**, o runner **só** clica nesse botão se tiveres `JITSI_AUTH_ENABLED=1` **e** `JITSI_AUTH_EMAIL` / `JITSI_AUTH_PASSWORD` no `.env` (fluxo anfitrião + Google automático). **Sem** credenciais, o modo de junção é **convidado**: tenta «continuar como convidado» / **Cancel** no diálogo (telemetria `jitsi_guest_path`) — **não** abre o fluxo de anfitrião, para não bloquear na página do Google. Forçar sempre o clique de anfitrião (ex.: concluires o Google em headful): `JITSI_CLAIM_HOST=1`. Forçar **nunca** tocar nesse botão: `JITSI_GUEST_MODE=1` ou `JITSI_CLAIM_HOST=0`. Com credenciais, a espera ao botão é **~90s**; sem credenciais, **~25s** (e convidado ~24s). `JITSI_HOST_BUTTON_WAIT_SEC=0` desliga a espera do anfitrião. `JITSI_POST_HOST_AUTH_DELAY_MS` (padrão 5000) aplica após o login; combine com `AUDIT_PAGE_DWELL_MS` (20000–45000) no Jitsi.

**Nota:** O `meet.jit.si` pode mudar a UI ou exigir interação humana em alguns países; se o join automático falhar, use modo headful e observe a tela. Se o Chromium mostrar **Não seguro** ou falha de certificado (antivírus / inspeção HTTPS), suba o backend com `PUPPETEER_IGNORE_HTTPS_ERRORS=1` e confira data/hora do Windows.

## Testar com Zoom

O cliente web público (`zoom.us/wc/...` ou `/j/...`) costuma exigir **login**, **CAPTCHA** ou bloquear automação — não é um alvo confiável para Puppeteer “só com URL”.

Cenário viável: uma **página sua** (React) que incorpora o **Zoom Meeting SDK** com JWT gerado no seu backend (SDK Key/Secret da Zoom Marketplace). Aí a **URL da API** seria essa página (ex.: `https://meuapp.com/zoom-room`) e o **token** seria o que sua aplicação espera (Bearer), não o JWT da Zoom em si, a menos que você repasse no header para a sua API.

Para o TCC/demonstração rápida, use **Jitsi** ou uma página **WebRTC mínima** sua; reserve Zoom para quando tiver o SDK embedado e credenciais.