[![Open in Codespaces](https://classroom.github.com/assets/launch-codespace-2972f46106e565e64193e422d61a12cf1da4916b45550586e14ef0a7c637dd04.svg)](https://classroom.github.com/open-in-codespaces?assignment_repo_id=20564753)
# StreamSentry

O StreamSentry é uma ferramenta web open-source (licença MIT) para automação de testes end-to-end em aplicações de videoconferência baseadas em WebRTC, com suporte a Jitsi Meet, Whereby e Zoom. A ferramenta atende desenvolvedores, engenheiros de QA, pesquisadores acadêmicos e equipes ágeis, oferecendo uma interface intuitiva para configurar e executar testes com até 50 usuários virtuais simultâneos (Puppeteer + Chromium), visualizar métricas detalhadas em tempo real (RTT, jitter, FPS, bitrate, taxas de falha) e exportar relatórios em JSON/CSV.

Projetado para simplificar a validação de estabilidade e qualidade de áudio/vídeo, o StreamSentry reduz a dependência de testes manuais demorados e ferramentas proprietárias caras, integrando-se a fluxos de trabalho ágeis e suportando modificações para pesquisas acadêmicas. O sistema inclui injeção de falhas de rede (perfis de chaos como 3G lento, alta latência e offline), histórico de sessões persistido em MongoDB e auditoria em tempo real via WebSocket, conforme os requisitos descritos no Documento de Visão.

## Alunos integrantes da equipe

* Rafael Parreira Chequer

## Professores responsáveis

* Cleiton Silva Tavares
* Danilo de Quadros Maia Filho
* Leonardo Vilela Cardoso
* Raphael Ramos Dias Costa

## Instruções de utilização

Pré-requisitos: **Go 1.21+**, **Node.js 18+** e **MongoDB** em execução (padrão `mongodb://localhost:27017`).

1. **Backend** (em `Codigo/backend/`):
   - Copie `.env.example` para `.env`
   - Em `puppeteer/`, execute `npm install`
   - Execute `go mod tidy` e `go run .` — a API sobe em `http://localhost:3001`

2. **Frontend** (em `Codigo/frontend/`):
   - Execute `npm install` e `npm run dev` — a interface sobe em `http://localhost:5173`

3. Acesse a interface, crie uma conta e use **Iniciar teste** para configurar o alvo (sala Jitsi/Whereby ou API própria), o número de usuários virtuais e a duração da chamada. Acompanhe as métricas na aba **Auditoria** e exporte relatórios pela aba **Histórico**.

As instruções completas — incluindo todas as variáveis de ambiente, o passo a passo por provedor (Whereby, Jitsi, Zoom) e o ciclo de vida do teste — estão em [`Codigo/README.md`](Codigo/README.md).
