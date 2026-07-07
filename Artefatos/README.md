# Artefatos do Projeto

Este diretório mantém os artefatos visuais (diagramas UML, modelo de dados e telas/mockups) produzidos para documentar a arquitetura, o design e as funcionalidades do Stream Sentry. Para cada diagrama há o arquivo-fonte em **`.puml`** (PlantUML) e a respectiva imagem em **`.png`**.

---

## Arquitetura e Estrutura (UML estático)

* **ArquiteturaLogica.puml / .png**: **Arquitetura Lógica** — visão em camadas (Interface React, Servidor Core em Go, Runner Node.js/Puppeteer, Persistência MongoDB).
* **DiagramaDeComponentes.puml / .png**: **Componentes** — módulos do sistema e suas interfaces (REST e WebSocket).
* **DiagramaDeImplantacao.puml / .png**: **Implantação** — alocação dos artefatos (host único; nota de hospedagem futura).
* **DiagramaDeClasses.puml / .png**: **Classes** — estrutura estática, incluindo o padrão Strategy/Factory (`IConferenceProvider`, `ProviderFactory` e os providers Jitsi/Whereby/Zoom/WebRTC).

---

## Casos de Uso

* **CasosDeUso.puml / .png**: Diagrama de **Casos de Uso** principal.
* **CasosDeUsoSlides1.puml / .png**: Recorte do diagrama de casos de uso para apresentação (1).
* **CasosDeUsoSlides2.puml / .png**: Recorte do diagrama de casos de uso para apresentação (2).

---

## Atividades

* **DiagramaDeAtividades.puml / .png**: Diagrama de **Atividades** — ciclo de vida operacional do sistema.

---

## Diagramas de Sequência do Sistema (DSS)

Visão "caixa-preta" das operações do sistema (Seção 2.4 do Documento de Projeto).

* **DSSAutenticacaoERegistro.puml / .png**: Cadastro e login (autenticação).
* **DSSConfiguracaoDeCenarioDeTeste.puml / .png**: Configuração de cenário de teste.
* **DSSExecucaoEMonitoramentoEmTempoReal.puml / .png**: Execução e monitoramento em tempo real.
* **DSSExportacaoDeResultadosAnaliticos.puml / .png**: Exportação de resultados analíticos.

---

## Diagramas de Sequência (detalhados)

Colaboração entre os componentes internos (Seção 3.2).

* **DiagramaDeSequenciaDeValidacaoViaStrategyPattern.puml / .png**: Configuração e validação (seleção de provedor via Strategy/Factory).
* **DiagramaDeSequenciaOrquestracaoDeWorkersETelemetria.puml / .png**: Execução em tempo real e telemetria.
* **DiagramaDeSequenciaDeGeracaoDeRelatorios.puml / .png**: Geração de relatórios.
* **DiagramaDeSequenciaControleAoVivo.puml / .png**: Controle ao vivo do teste (pausar/retomar, concorrência, chaos, finalizar).
* **DiagramaDeSequenciaHistorico.puml / .png**: Consulta ao histórico e reabertura de auditoria.

---

## Diagramas de Comunicação

Mesmas operações na notação de comunicação (Seção 3.3).

* **DiagramaDeComunicacaoConfiguracaoEValidacao.puml / .png**: Configuração e validação.
* **DiagramaDeComunicacaoExecucaoETelemetria.puml / .png**: Execução e telemetria.
* **DiagramaDeComunicacaoGeracaoDeRelatorios.puml / .png**: Processamento de relatórios.
* **DiagramaDeComunicacaoControleAoVivo.puml / .png**: Controle ao vivo do teste.
* **DiagramaDeComunicacaoHistorico.puml / .png**: Consulta ao histórico.

---

## Modelo de Dados

* **DiagramaER.puml / .png**: **Modelo de dados (MongoDB)** — coleções `users`, `test_history`, `telemetry_events` e `counters` (modelo documental, não relacional).

---

## Personas

* **PersonaLucas.png**: Persona Lucas (Desenvolvedor React).
* **PersonaAna.png**: Persona Ana (Engenheira de QA).
* **PersonaFelipe.png**: Persona Felipe (Tech Lead / Equipe Ágil).
* **PersonaCarla.png**: Persona Carla (material complementar).

---

## Telas / Mockups (wireframes projetados)

* **ConfigurarTeste.png**: Mockup da tela "Configurar Teste".
* **ExecutarTeste.png**: Mockup da tela "Executar Teste".
* **Relatorios.png**: Mockup da tela "Relatórios".
* **HistoricoDeTestes.png**: Mockup do "Histórico de Testes".
* **ConfiguracoesAvancadas.png**: Mockup das "Configurações Avançadas".
* **Login.png**: Mockup da tela de "Login".
