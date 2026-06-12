8. Post Mortem: Desafios de Integração com Provedores de Videoconferência

Esta seção registra, de forma retrospectiva, os principais obstáculos técnicos enfrentados durante a implementação dos drivers de integração (Strategy Pattern / IConferenceProvider) com os provedores de videoconferência suportados pelo Stream Sentry — Zoom, Whereby e Jitsi. O objetivo é documentar as decisões de arquitetura tomadas em resposta a limitações externas, fora do controle do projeto, de modo a justificar o estado final da integração entregue e orientar trabalhos futuros.

8.1 Zoom

A integração inicial planejada utilizava o Zoom como um dos provedores de referência, dada sua relevância de mercado. O driver de integração com o Zoom permanece implementado e funcional, podendo ser utilizado manualmente pelo operador do sistema. Entretanto, durante a fase de implementação dos Workers Puppeteer (TestEngine / WorkerNode), foram identificados dois problemas críticos que tornam o Zoom inviável como provedor de referência para os testes automatizados do projeto:

Bloqueio de acesso a bots: o Zoom Web Client possui mecanismos de detecção de automação (fingerprinting de navegador, CAPTCHA e verificações de comportamento) que identificam sessões controladas pelo Puppeteer e bloqueiam o ingresso na sala de reunião. Mesmo com técnicas de mitigação (uso de ghost-cursor para simular movimentação humana do mouse, perfis de navegador persistentes e user agents customizados), o acesso automatizado às salas via zoom.us/j/... mostrou-se inconsistente e frequentemente bloqueado, impedindo a execução confiável de testes de carga com múltiplos usuários virtuais.

Coleta parcial de métricas mesmo no acesso manual: ao contornar o bloqueio realizando o ingresso manual na sala (sem automação), constatou-se que o Zoom Web Client não expõe a totalidade das estatísticas de WebRTC (RTCPeerConnection.getStats()) esperadas — aproximadamente metade dos indicadores de Qualidade de Experiência (QoE) definidos no Glossário (Tabela 4), como jitterVideo e downlinkKbps para os fluxos de entrada de outros participantes, não estavam disponíveis ou retornavam valores nulos/zerados. Isso compromete a integridade dos relatórios analíticos (visualizarRelatorio, Tabela 3) e a comparabilidade dos dados entre provedores.

Em resumo, o Zoom está integrado ao sistema e pode ser utilizado manualmente, mas não é considerado viável como provedor de testes automatizados, seja pela impossibilidade de automação confiável, seja pela telemetria incompleta mesmo quando o acesso é viabilizado manualmente. O driver permanece isolado pela ProviderFactory para eventual retomada caso o Zoom disponibilize, no futuro, um SDK oficial (Zoom Meeting SDK) com suporte a automação headless e exposição completa de estatísticas WebRTC.

8.2 Migração para o Whereby

Como alternativa ao Zoom, o projeto migrou o foco de integração para o Whereby, plataforma baseada em WebRTC nativo com interface web mais permissiva à automação. A migração trouxe um ganho expressivo em relação ao objetivo central do TCC (US02): foi possível automatizar integralmente o fluxo de criação de sala, ingresso dos usuários virtuais e coleta de telemetria, sem necessidade de intervenção manual, login ou contorno de mecanismos anti-bot — os Workers Puppeteer ingressam na sala como convidados, habilitam câmera/microfone simulados e iniciam a coleta de estatísticas WebRTC de forma consistente para todos os participantes.

A limitação identificada nesta integração não é técnica, mas comercial: o plano gratuito do Whereby restringe as salas a um máximo de 4 usuários simultâneos por chamada. Isso impõe um teto ao volume de usuários virtuais simulável em uma única sessão de teste quando o Whereby é o provedor selecionado, em contraste com o limite de 50 usuários estabelecido como meta geral do sistema (TA-02, Glossário). Esse limite é uma restrição de licenciamento da própria plataforma Whereby e poderia ser superado mediante a contratação de um plano pago (Whereby Embedded/Business), o que está fora do escopo orçamentário do TCC.

8.3 Jitsi

O Jitsi Meet (meet.jit.si e instâncias self-hosted) foi o provedor que mais se aproximou do cenário ideal descrito no Documento de Visão, suportando a simulação de até 50 usuários virtuais simultâneos, conforme prometido nos requisitos não funcionais e validado no caso de teste TA-01.

Entretanto, o processo de automação para o Jitsi não é totalmente otimizado quando a sala exige a presença de um anfitrião autenticado (host). Diferentemente do Whereby, o ingresso como anfitrião no Jitsi pode requerer autenticação via conta Google (ou outro provedor de identidade), e os mecanismos de login automático (JITSI_AUTH_*, formulário in-page) mostraram-se frágeis diante de fluxos de 2FA (autenticação em dois fatores) e telas de confirmação dinâmicas do Google. Como solução de contorno, o sistema foi projetado para que:

- Apenas o usuário virtual 1 (VU1), responsável por reivindicar o papel de anfitrião, abra uma janela de navegador visível (modo não-headless), permitindo que o operador do teste realize o login manualmente na primeira execução;
- Um perfil de navegador Chrome persistente (JITSI_CHROME_PROFILE_DIR) seja reaproveitado nas execuções subsequentes, evitando repetir o login manual a cada novo teste;
- Os usuários virtuais 2 a N ingressem como convidados, de forma totalmente headless e automatizada, aguardando o anfitrião abrir a sala.

Dessa forma, o Jitsi atende ao requisito de escala (até 50 usuários) e à coleta completa de métricas WebRTC, porém com a ressalva de que a primeira execução (ou a expiração da sessão do perfil) demanda uma intervenção pontual do usuário para autenticação — uma limitação aceitável frente à inviabilidade definitiva encontrada no Zoom, mas que indica uma oportunidade de melhoria futura (ex.: uso de contas de serviço dedicadas ou salas que dispensem anfitrião autenticado).

8.4 Síntese Comparativa

Zoom: integrado e utilizável manualmente, porém inviável para automação (bloqueio anti-bot) e com coleta parcial de métricas mesmo no uso manual; sem limite de usuários definido; status: integrado, porém não recomendado.

Whereby: automação completa, sem intervenção manual, métricas WebRTC completas; limite de 4 usuários no plano gratuito; status: provedor recomendado para testes pequenos.

Jitsi: automação quase completa (host requer login manual na primeira execução), métricas WebRTC completas; suporta até 50 usuários; status: provedor recomendado para testes de escala.

Essa retrospectiva reforça a importância arquitetural do padrão Strategy/Factory (IConferenceProvider / ProviderFactory) adotado no Diagrama de Classes (Seção 3.1): a transição do provedor de referência durante o desenvolvimento — do Zoom para o Whereby e o Jitsi — foi absorvida sem necessidade de alterar o núcleo do TestEngine, validando o desacoplamento proposto desde a concepção do sistema.
