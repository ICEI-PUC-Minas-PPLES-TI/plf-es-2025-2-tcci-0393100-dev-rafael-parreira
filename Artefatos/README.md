# Artefatos do Projeto

Este diretório mantém os artefatos visuais (diagramas UML, diagramas de entidade-relacionamento e telas/mockups) produzidos para documentar a arquitetura, o design e as funcionalidades do sistema.

---

## Design UML e Arquitetura

Os diagramas de modelagem UML e de arquitetura lógica/componentes estão organizados pelos seus tipos. Para cada diagrama, existe o arquivo-fonte em **`.puml`** (PlantUML) e sua respectiva imagem gerada em **`.png`**.

* `/`
	* **ArquiteturaLogica.puml / .png**: Diagrama de **Arquitetura Lógica** (Visão Geral da Estrutura).
	* **DiagramaDeComponentes.puml / .png**: Diagrama de **Componentes** (Estrutura e Relação entre Componentes do Sistema).
	* **DiagramaDeImplantacao.puml / .png**: Diagrama de **Implantação** (Alocação de artefatos em nós físicos).
	* **DiagramaDeClasses.puml / .png**: Diagrama de **Classes** (Estrutura estática do sistema).

---

## Casos de Uso e Fluxos

Esta seção contém diagramas que modelam as interações e o comportamento do sistema.

* `/`
	* **CasosDeUso.puml / .png**: Diagrama de **Casos de Uso** principal.
	* **CasosDeUsoSlides1.puml / .png**: Variação ou detalhe do Diagrama de Casos de Uso para apresentação/slides (1).
	* **CasosDeUsoSlides2.puml / .png**: Variação ou detalhe do Diagrama de Casos de Uso para apresentação/slides (2).
	* **DiagramaDeAtividades.puml / .png**: Diagrama de **Atividades** (Fluxo de trabalho e controle).
	* **DiagramaDeComunicacao.puml / .png**: Diagrama de **Comunicação** (Interação entre objetos ou *lifelines*).

---

## Diagramas de Sequência

Diagramas que detalham a ordem temporal das mensagens trocadas entre objetos para realizar casos de uso específicos.

* `/`
	* **DiagramaDeSequencia.puml / .png**: Diagrama de **Sequência** (Genérico/Principal).
	* **DiagramaDeSequenciaConfiguracaoDeTestes.puml / .png**: Diagrama de Sequência para o caso de uso **Configuração de Testes**.
	* **DiagramaDeSequenciaExecucaoDeTestes.puml / .png**: Diagrama de Sequência para o caso de uso **Execução de Testes**.
	* **DiagramaDeSequenciaExportacaoDeRelatorio.puml / .png**: Diagrama de Sequência para o caso de uso **Exportação de Relatório**.

---

## Modelagem de Dados

Diagrama de Entidade-Relacionamento (DER).

* `/`
	* **DiagramaER.puml / .png**: **Diagrama de Entidade-Relacionamento (DER)** para a base de dados.

---

## Personas

Imagens para documentação das personas do projeto.

* `/`
	* **PersonaAna.png**: Imagem/documento da **Persona Ana**.
	* **PersonaCarla.png**: Imagem/documento da **Persona Carla**.
	* **PersonaFelipe.png**: Imagem/documento da **Persona Felipe**.
	* **PersonaLucas.png**: Imagem/documento da **Persona Lucas**.

---

## Telas / Mockups

Capturas de tela ou mockups de interfaces do sistema.

* `/`
	* **ConfiguracoesAvancadas.png**: Tela/Mockup das **Configurações Avançadas**.
	* **ConfigurarTeste.png**: Tela/Mockup da interface para **Configurar Teste**.
	* **ExecutarTeste.png**: Tela/Mockup da interface para **Executar Teste**.
	* **HistoricoDeTestes.png**: Tela/Mockup do **Histórico de Testes**.
	* **Login.png**: Tela/Mockup da tela de **Login**.
	* **Relatorios.png**: Tela/Mockup da interface de **Relatórios**.