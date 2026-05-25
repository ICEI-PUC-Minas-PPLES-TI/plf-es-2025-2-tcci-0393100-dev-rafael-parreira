import React from "react";
import logo from "../Logo.svg";

const ICONS = {
  webrtc: (
    <path d="M5 7.5A3.5 3.5 0 0 1 8.5 4h7A3.5 3.5 0 0 1 19 7.5v4a3.5 3.5 0 0 1-3.5 3.5h-2.2L9 18v-3H8.5A3.5 3.5 0 0 1 5 11.5v-4Zm4 1.25h6m-6 3h3.5" />
  ),
  chaos: <path d="M4 12h3l2-6 4 12 2-6h5M7 18l2-2m6-10 2-2M5 5l2 2m10 10 2 2" />,
  reports: <path d="M7 3.5h7l3 3v14H7v-17Zm7 0v3h3M10 11h4m-4 3h6m-6 3h3" />,
  load: <path d="M4 16.5 8.5 12l3 3L20 6.5M5 6h4m-4 3h7m-7 3h3" />
};

const FEATURES = [
  {
    icon: "webrtc",
    title: "WebRTC",
    text: "RTT, jitter, FPS e bitrate agregados por utilizador virtual, alinhados ao que o browser expõe.",
    items: ["getStats()", "Por usuário", "Tempo real"]
  },
  {
    icon: "chaos",
    title: "Rede / chaos",
    text: "3G, latência, offline e perfis intermitentes aplicados via CDP no Chromium do servidor.",
    items: ["Slow 3G", "Offline", "Latência"]
  },
  {
    icon: "reports",
    title: "Relatórios",
    text: "NDJSON por teste, resumos agregados e exportação com ou sem eventos detalhados.",
    items: ["JSON", "CSV", "Histórico"]
  },
  {
    icon: "load",
    title: "Testes de carga",
    text: "Execução com múltiplos utilizadores virtuais para acompanhar concorrência, requisições e atividade por segundo.",
    items: ["Concorrência", "Req/s", "Controle ao vivo"]
  }
];

function FeatureIcon({ name }) {
  return (
    <span className="landing-feature-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" role="img">
        {ICONS[name]}
      </svg>
    </span>
  );
}

export default function LandingPage({ onEntrar, onRegisto }) {
  return (
    <div className="landing-page">
      <header className="landing-masthead">
        <div className="landing-masthead-inner">
          <a href="#top" className="landing-brand" onClick={(e) => e.preventDefault()}>
            <img src={logo} alt="" className="landing-brand-logo" width={44} height={44} />
            <div>
              <span className="landing-brand-name">Stream Sentry</span>
              <span className="landing-brand-tag">Observabilidade WebRTC &amp; stress</span>
            </div>
          </a>
          <div className="landing-masthead-actions">
            <button type="button" className="nav-link-ghost" onClick={onEntrar}>
              Entrar
            </button>
            <button type="button" className="nav-cta" onClick={onRegisto}>
              Criar conta
            </button>
          </div>
        </div>
      </header>

      <div className="landing-hero" id="top" aria-label="Apresentação">
        <div className="landing-hero-inner">
          <div className="landing-badge">Observabilidade · WebRTC · Puppeteer</div>
          <h1 className="landing-title">Teste e audite o seu tráfego em tempo real</h1>
          <p className="landing-lead">
            Telemetria de rede, amostras <code>getStats()</code> ao estilo <em>webrtc-internals</em>, stress com
            utilizadores virtuais, perfis de chaos e relatórios exportáveis — a partir de uma única consola.
          </p>
          <ul className="landing-points">
            <li>Dashboard com gráficos e eixo de tempo; passe o rato para ver instantes e valores</li>
            <li>Histórico e exportação JSON/CSV por sessão</li>
            <li>Pausa, retomada e ajuste de concorrência durante o teste</li>
          </ul>
          <div className="landing-capabilities" aria-label="Indicadores principais">
            <span>Auditoria ao vivo</span>
            <span>Controle de concorrência</span>
            <span>Exportação detalhada</span>
          </div>
        </div>
      </div>

      <section className="landing-features" aria-label="Funcionalidades">
        {FEATURES.map((feature) => (
          <div className="landing-feature-card" key={feature.title}>
            <FeatureIcon name={feature.icon} />
            <h2>{feature.title}</h2>
            <p>{feature.text}</p>
            <div className="landing-feature-tags">
              {feature.items.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
