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
- O frontend abre `GET /ws/telemetry?token=<JWT>` e recebe eventos NDJSON (requisições, respostas, falhas) enquanto roda `puppeteer/run-audit.mjs`.
- Apenas um teste por vez no servidor; se já houver um em execução, a API responde **409**.