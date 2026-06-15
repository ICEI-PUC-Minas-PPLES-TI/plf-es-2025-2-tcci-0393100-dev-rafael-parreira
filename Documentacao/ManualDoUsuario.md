# Manual do Usuário — Stream Sentry

Este manual descreve, passo a passo, como instalar, configurar e operar o Stream Sentry — ferramenta web para automação de testes end-to-end e monitoramento de qualidade (QoE) em aplicações de videoconferência baseadas em WebRTC.

## 1. Pré-requisitos

- **Go 1.21+**
- **Node.js 18+**
- **MongoDB** em execução (padrão: `mongodb://localhost:27017`)
- Google Chrome / Chromium (instalado automaticamente pelo Puppeteer)

## 2. Instalação e execução (ambiente local)

### Backend (em `Codigo/backend/`)
1. Copie `.env.example` para `.env` e ajuste o que for necessário (ex.: `MONGODB_URI`, `JWT_SECRET`).
2. Instale as dependências do runner: em `puppeteer/`, execute `npm install`.
3. Inicie o servidor: `go mod tidy` e depois `go run .`
   - A API sobe em `http://localhost:3001`.

### Frontend (em `Codigo/frontend/`)
1. Instale as dependências: `npm install`.
2. Inicie a interface: `npm run dev`
   - A aplicação abre em `http://localhost:5173`.

## 3. Criar conta e login

1. Na página inicial, clique em **Criar conta** e informe nome, e-mail e senha (mínimo de 6 caracteres).
2. Para acessos seguintes, use **Entrar** com e-mail e senha. A sessão é mantida por um token JWT.

## 4. Configurar um teste (tela "Iniciar teste")

1. **URL da API (alvo):** informe a sala/página a ser testada. Botões auxiliares:
   - **Criar sala Whereby** (requer `WHEREBY_API_KEY` no `.env`);
   - **Gerar sala Jitsi** (usa `JITSI_BASE_URL`, padrão `meet.jit.si`).
2. **Token de acesso:** enviado como Bearer nas requisições. É **opcional para Jitsi e Whereby**.
3. **Usuários virtuais:** de 1 a 50 (limitado a **4** quando o alvo é Whereby, por restrição do plano gratuito).
4. **Duração da chamada:** de 90 a 1800 segundos — tempo que cada usuário virtual permanece na chamada coletando métricas.
5. **Modo do navegador:** headless (padrão) ou não-headless. Para salas **Jitsi**, a janela do usuário virtual 1 sempre abre, pois é necessário **fazer login manualmente no Google** (o anfitrião).
6. **Chaos (rede):** perfil de instabilidade a aplicar (3G lenta, alta latência, offline, instável etc.).
7. Clique em **Iniciar teste**. A aplicação muda para a aba **Auditoria**.

## 5. Acompanhar a Auditoria (tempo real)

- **Status:** "Em execução" → "Finalizado".
- **Duração do teste** e **Duração da chamada** (esta só começa a contar quando todos os usuários entram na chamada e seus dados começam a alimentar os gráficos).
- **Controles ao vivo:** pausar/retomar, ajustar a concorrência (usuários virtuais) e o perfil de chaos, além de botões de injeção rápida.
- **Indicadores HTTP:** requisições, respostas e falhas, com gráficos de Requisições e Atividade.
- **Seção WebRTC:** indicadores de RTT, jitter, FPS, bitrate, pacotes, frames e resolução, além de gráficos por usuário (uma cor por usuário, com as 7 cores do arco-íris para até 7 usuários).
- **Finalização automática:** ao atingir a duração da chamada, o teste é encerrado e o status muda para "Finalizado".

## 6. Histórico e relatórios

1. Acesse a aba **Histórico** para ver as sessões concluídas (início, duração, chaos, RTT médio, requisições HTTP, amostras WebRTC e status).
2. Em cada sessão você pode:
   - **Ver auditoria** — reabre a tela de Auditoria reconstruída a partir do log;
   - **Exportar** o relatório em **JSON** ou **CSV** (resumo ou completo, com todos os eventos).

## 7. Dicas e solução de problemas

- **Jitsi pede login:** o navegador do usuário virtual 1 abre visível; faça login com o Google. Para não repetir o login a cada teste, configure um perfil Chrome persistente em `JITSI_CHROME_PROFILE_DIR` (`.env`).
- **Aviso "Não seguro"/erro de certificado no Jitsi** (antivírus/inspeção HTTPS): inicie o backend com `PUPPETEER_IGNORE_HTTPS_ERRORS=1` e confira a data/hora do sistema.
- **Whereby limitado a 4 usuários:** restrição do plano gratuito; a interface avisa e limita o campo.
- **Desempenho:** com muitos usuários virtuais, prefira o modo headless — o modo não-headless consome muita memória/CPU.

> Observação: a lista completa de variáveis de ambiente está documentada em `Codigo/backend/.env.example`. Detalhes técnicos adicionais estão no `Codigo/README.md`.
