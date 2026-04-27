import React from "react";
import logo from "../Logo.svg";

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
          <div className="landing-hero-ctas">
            <button type="button" className="submit landing-cta-primary" onClick={onEntrar}>
              Entrar na aplicação
            </button>
            <button type="button" className="ghost landing-cta-secondary" onClick={onRegisto}>
              Criar conta
            </button>
          </div>
        </div>
      </div>

      <section className="landing-features" aria-label="Funcionalidades">
        <div className="landing-feature-card">
          <h2>WebRTC</h2>
          <p>RTT, jitter, FPS e bitrate agregados por utilizador virtual, alinhado ao que o browser expõe.</p>
        </div>
        <div className="landing-feature-card">
          <h2>Rede / chaos</h2>
          <p>3G, latência, offline e perfis intermitentes aplicados via CDP no Chromium do servidor.</p>
        </div>
        <div className="landing-feature-card">
          <h2>Relatórios</h2>
          <p>NDJSON por teste, resumos agregados e exportação com ou sem eventos detalhados.</p>
        </div>
      </section>
    </div>
  );
}
