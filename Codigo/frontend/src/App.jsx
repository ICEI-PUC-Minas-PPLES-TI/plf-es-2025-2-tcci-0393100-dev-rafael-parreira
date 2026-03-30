import React, { useState } from "react";
import logo from "../Logo.svg";
import AuditDashboard from "./AuditDashboard";
import { useTelemetryWS } from "./useTelemetryWS.js";

const apiBaseUrl = import.meta.env.VITE_API_URL || "http://localhost:3001";

const sampleConfig = {
  apiUrl: "https://example.org",
  accessToken: "demo_token_stream_sentry_123",
  virtualUsers: 12
};

const Logo = () => (
  <div
    className="logo-container"
    style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: "20px" }}
  >
    <img src={logo} alt="Stream Sentry Logo" style={{ width: "80px", height: "auto", marginBottom: "10px" }} />
    <h1 style={{ margin: 0 }}>Stream Sentry</h1>
  </div>
);

async function post(path, body) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || "request failed");
  }
  return data;
}

async function postWithAuth(path, body, token) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || "request failed");
  }
  return data;
}

function validateConfig(config) {
  const users = Number(config.virtualUsers);
  if (!Number.isInteger(users) || users < 1 || users > 50) {
    throw new Error("O número de usuários deve estar entre 1 e 50.");
  }
  try {
    const parsedUrl = new URL(config.apiUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("A URL da API deve usar HTTP ou HTTPS.");
    }
  } catch {
    throw new Error("Informe uma URL de API válida.");
  }
  if (!config.accessToken.trim()) {
    throw new Error("Informe o token de acesso.");
  }
  return {
    apiUrl: config.apiUrl.trim(),
    accessToken: config.accessToken.trim(),
    virtualUsers: users
  };
}

export default function App() {
  const [authToken, setAuthToken] = useState(() => localStorage.getItem("streamSentryToken") || "");
  const hasToken = Boolean(authToken);
  const [tab, setTab] = useState("login");
  const [screen, setScreen] = useState(hasToken ? "app" : "auth");
  const [mainView, setMainView] = useState("settings");
  const [feedback, setFeedback] = useState("");
  const [feedbackType, setFeedbackType] = useState("");
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [registerForm, setRegisterForm] = useState({ name: "", email: "", password: "" });
  const [puppeteerLoading, setPuppeteerLoading] = useState(false);
  const [puppeteerResult, setPuppeteerResult] = useState(null);
  const [testStarting, setTestStarting] = useState(false);

  const [configForm, setConfigForm] = useState(() => {
    const savedConfig = localStorage.getItem("streamSentryTechConfig");
    if (!savedConfig) {
      return { apiUrl: apiBaseUrl, accessToken: "", virtualUsers: 10 };
    }
    try {
      const parsed = JSON.parse(savedConfig);
      return {
        apiUrl: parsed.apiUrl || apiBaseUrl,
        accessToken: parsed.accessToken || "",
        virtualUsers: Number(parsed.virtualUsers) || 10
      };
    } catch {
      return { apiUrl: apiBaseUrl, accessToken: "", virtualUsers: 10 };
    }
  });

  const telemetry = useTelemetryWS(apiBaseUrl, authToken, screen === "app");

  const setMessage = (message, type = "") => {
    setFeedback(message);
    setFeedbackType(type);
  };

  async function handleRegister(event) {
    event.preventDefault();
    try {
      const result = await post("/auth/register", registerForm);
      localStorage.setItem("streamSentryToken", result.token);
      setAuthToken(result.token);
      setMessage("Cadastro realizado com sucesso.", "success");
      setRegisterForm({ name: "", email: "", password: "" });
      setScreen("app");
      setMainView("settings");
    } catch (error) {
      setMessage(error.message, "error");
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    try {
      const result = await post("/auth/login", loginForm);
      localStorage.setItem("streamSentryToken", result.token);
      setAuthToken(result.token);
      setMessage(`Bem-vindo, ${result.user.name}.`, "success");
      setLoginForm({ email: "", password: "" });
      setScreen("app");
      setMainView("settings");
    } catch (error) {
      setMessage(error.message, "error");
    }
  }

  function handleSaveConfig(event) {
    event.preventDefault();
    try {
      const validatedConfig = validateConfig(configForm);
      localStorage.setItem("streamSentryTechConfig", JSON.stringify(validatedConfig));
      setPuppeteerResult(null);
      setMessage("Configurações salvas com sucesso.", "success");
    } catch (error) {
      setMessage(error.message, "error");
    }
  }

  async function handlePuppeteerSmoke() {
    try {
      const validatedConfig = validateConfig(configForm);
      setPuppeteerLoading(true);
      setMessage("Executando smoke test do Puppeteer...", "");
      setPuppeteerResult(null);
      const result = await post("/puppeteer/smoke", validatedConfig);
      setPuppeteerResult(result.result || null);
      setMessage("Integração Puppeteer executada com sucesso.", "success");
    } catch (error) {
      setMessage(error.message, "error");
    } finally {
      setPuppeteerLoading(false);
    }
  }

  async function handleStartTest(event) {
    event.preventDefault();
    try {
      const validated = validateConfig(configForm);
      setTestStarting(true);
      setMessage("Iniciando teste com Puppeteer…", "");
      await postWithAuth("/test/start", validated, authToken);
      setMessage("Teste iniciado. Veja a aba Auditoria para métricas ao vivo.", "success");
      setMainView("audit");
    } catch (error) {
      setMessage(error.message, "error");
    } finally {
      setTestStarting(false);
    }
  }

  function handleLogout() {
    localStorage.removeItem("streamSentryToken");
    setAuthToken("");
    setScreen("auth");
    setTab("login");
    setMainView("settings");
    setMessage("Sessão encerrada.", "success");
  }

  function handleUseExample() {
    setConfigForm(sampleConfig);
    setPuppeteerResult(null);
    setMessage("Exemplo preenchido.", "success");
  }

  return (
    <main className="container">
      {screen === "auth" ? (
        <section className="card">
          <Logo />
          <p className="subtitle">Autenticação</p>

          <div className="tabs">
            <button
              type="button"
              className={`tab ${tab === "login" ? "active" : ""}`}
              onClick={() => {
                setTab("login");
                setMessage("");
              }}
            >
              Login
            </button>
            <button
              type="button"
              className={`tab ${tab === "register" ? "active" : ""}`}
              onClick={() => {
                setTab("register");
                setMessage("");
              }}
            >
              Registro
            </button>
          </div>

          {tab === "login" ? (
            <form className="form" onSubmit={handleLogin}>
              <label htmlFor="login-email">Email</label>
              <input
                id="login-email"
                type="email"
                value={loginForm.email}
                onChange={(e) => setLoginForm({ ...loginForm, email: e.target.value })}
                required
              />
              <label htmlFor="login-password">Senha</label>
              <input
                id="login-password"
                type="password"
                value={loginForm.password}
                onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
                required
              />
              <button className="submit" type="submit">
                Entrar
              </button>
            </form>
          ) : (
            <form className="form" onSubmit={handleRegister}>
              <label htmlFor="register-name">Nome</label>
              <input
                id="register-name"
                type="text"
                value={registerForm.name}
                onChange={(e) => setRegisterForm({ ...registerForm, name: e.target.value })}
                required
              />
              <label htmlFor="register-email">Email</label>
              <input
                id="register-email"
                type="email"
                value={registerForm.email}
                onChange={(e) => setRegisterForm({ ...registerForm, email: e.target.value })}
                required
              />
              <label htmlFor="register-password">Senha</label>
              <input
                id="register-password"
                type="password"
                value={registerForm.password}
                onChange={(e) => setRegisterForm({ ...registerForm, password: e.target.value })}
                minLength={6}
                required
              />
              <button className="submit" type="submit">
                Criar conta
              </button>
            </form>
          )}

          <p className={`feedback ${feedbackType}`}>{feedback}</p>
        </section>
      ) : (
        <section className={`card card-app ${mainView === "audit" ? "card-app-audit" : ""}`}>
          <Logo />
          <nav className="app-nav" aria-label="Navegação principal">
            <button
              type="button"
              className={`nav-pill ${mainView === "settings" ? "active" : ""}`}
              onClick={() => setMainView("settings")}
            >
              Configurações
            </button>
            <button
              type="button"
              className={`nav-pill ${mainView === "start" ? "active" : ""}`}
              onClick={() => setMainView("start")}
            >
              Iniciar teste
            </button>
            <button
              type="button"
              className={`nav-pill ${mainView === "audit" ? "active" : ""}`}
              onClick={() => setMainView("audit")}
            >
              Auditoria
            </button>
            <button type="button" className="nav-pill nav-logout" onClick={handleLogout}>
              Sair
            </button>
          </nav>

          {mainView === "settings" && (
            <>
              <p className="subtitle">Configuração técnica do Puppeteer</p>
              <div className="example-box">
                <p>Exemplo rápido para testar:</p>
                <code>URL: {sampleConfig.apiUrl}</code>
                <button className="ghost" type="button" onClick={handleUseExample}>
                  Usar exemplo
                </button>
              </div>
              <form className="form" onSubmit={handleSaveConfig}>
                <div className="config-block">
                  <h2>API</h2>
                  <label htmlFor="api-url">URL da API</label>
                  <input
                    id="api-url"
                    type="url"
                    value={configForm.apiUrl}
                    onChange={(e) => setConfigForm({ ...configForm, apiUrl: e.target.value })}
                    required
                  />
                </div>
                <div className="config-block">
                  <h2>Segurança</h2>
                  <label htmlFor="access-token">Token de acesso</label>
                  <input
                    id="access-token"
                    type="text"
                    value={configForm.accessToken}
                    onChange={(e) => setConfigForm({ ...configForm, accessToken: e.target.value })}
                    required
                  />
                </div>
                <div className="config-block">
                  <h2>Puppeteer</h2>
                  <label htmlFor="virtual-users">Usuários virtuais simultâneos (1 a 50)</label>
                  <input
                    id="virtual-users"
                    type="number"
                    min={1}
                    max={50}
                    value={configForm.virtualUsers}
                    onChange={(e) => setConfigForm({ ...configForm, virtualUsers: Number(e.target.value) })}
                    required
                  />
                </div>
                <div className="actions">
                  <button className="submit" type="submit">
                    Salvar
                  </button>
                  <button className="ghost" type="button" onClick={handlePuppeteerSmoke} disabled={puppeteerLoading}>
                    {puppeteerLoading ? "Executando..." : "Testar Puppeteer"}
                  </button>
                </div>
              </form>
              {puppeteerResult && (
                <div className="result-box">
                  <h2>Resultado da integração</h2>
                  <p>
                    <strong>URL final:</strong> {puppeteerResult.finalUrl || "-"}
                  </p>
                  <p>
                    <strong>Status HTTP:</strong> {String(puppeteerResult.statusCode ?? "-")}
                  </p>
                  <p>
                    <strong>Título:</strong> {puppeteerResult.title || "-"}
                  </p>
                  <p>
                    <strong>Executado em:</strong> {puppeteerResult.executedAt || "-"}
                  </p>
                </div>
              )}
            </>
          )}

          {mainView === "start" && (
            <>
              <p className="subtitle">Iniciar teste (Puppeteer)</p>
              <p className="config-intro">
                Defina a URL da API alvo, o token Bearer enviado nas requisições e quantos usuários virtuais o Puppeteer
                irá simular em lotes. O tráfego de rede aparece em tempo real na aba Auditoria via WebSocket.
              </p>
              <form className="form" onSubmit={handleStartTest}>
                <div className="config-block">
                  <h2>Alvo</h2>
                  <label htmlFor="start-api-url">URL da API</label>
                  <input
                    id="start-api-url"
                    type="url"
                    value={configForm.apiUrl}
                    onChange={(e) => setConfigForm({ ...configForm, apiUrl: e.target.value })}
                    required
                  />
                </div>
                <div className="config-block">
                  <h2>Autenticação</h2>
                  <label htmlFor="start-token">Token de acesso</label>
                  <input
                    id="start-token"
                    type="text"
                    value={configForm.accessToken}
                    onChange={(e) => setConfigForm({ ...configForm, accessToken: e.target.value })}
                    required
                  />
                </div>
                <div className="config-block">
                  <h2>Usuários virtuais (Puppeteer)</h2>
                  <label htmlFor="start-users">Quantidade (1 a 50)</label>
                  <input
                    id="start-users"
                    type="number"
                    min={1}
                    max={50}
                    value={configForm.virtualUsers}
                    onChange={(e) => setConfigForm({ ...configForm, virtualUsers: Number(e.target.value) })}
                    required
                  />
                </div>
                <button className="submit" type="submit" disabled={testStarting}>
                  {testStarting ? "Iniciando…" : "Iniciar teste"}
                </button>
              </form>
            </>
          )}

          {mainView === "audit" && (
            <AuditDashboard
              connected={telemetry.connected}
              lastEvent={telemetry.lastEvent}
              requestTotal={telemetry.requestTotal}
              responseTotal={telemetry.responseTotal}
              failTotal={telemetry.failTotal}
              cumulativeSeries={telemetry.cumulativeSeries}
              rpsSeries={telemetry.rpsSeries}
              statusCounts={telemetry.statusCounts}
              feed={telemetry.feed}
              webrtcAggregate={telemetry.webrtcAggregate}
              webrtcSeries={telemetry.webrtcSeries}
              webrtcLastByUser={telemetry.webrtcLastByUser}
            />
          )}

          <p className={`feedback ${feedbackType}`}>{feedback}</p>
        </section>
      )}
    </main>
  );
}
