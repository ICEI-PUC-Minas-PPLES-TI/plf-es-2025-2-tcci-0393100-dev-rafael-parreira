import React, { useState, useEffect } from "react";
import logo from "../Logo.svg";
import AuditDashboard from "./AuditDashboard";
import LandingPage from "./LandingPage";
import { buildTelemetrySnapshotFromEvents, useTelemetryWS } from "./useTelemetryWS.js";

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

function makeApiError(data, response, defaultMsg = "request failed") {
  const err = new Error((data && data.message) || defaultMsg);
  err.unauthorized = response.status === 401;
  return err;
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
    throw makeApiError(data, response);
  }
  return data;
}

async function getWithAuth(path, token) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw makeApiError(data, response);
  }
  return data;
}

async function downloadReportBlob(path, token, filename) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw makeApiError(err, response, "download failed");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const CHAOS_START_OPTIONS = [
  { value: "off", label: "Desligado" },
  { value: "slow_3g", label: "Rede lenta (3G)" },
  { value: "fast_3g", label: "3G rápida" },
  { value: "high_latency", label: "Alta latência" },
  { value: "offline", label: "Offline" },
  { value: "flaky", label: "Intermitente (chaos)" },
  { value: "dns_failure", label: "Falha DNS (simulada)" }
];

function isWherebyUrl(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "whereby.com" || h.endsWith(".whereby.com");
  } catch {
    return false;
  }
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
  if (!isWherebyUrl(config.apiUrl) && !config.accessToken.trim()) {
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
  const [screen, setScreen] = useState(hasToken ? "app" : "landing");
  const [mainView, setMainView] = useState("start");
  const [feedback, setFeedback] = useState("");
  const [feedbackType, setFeedbackType] = useState("");
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [registerForm, setRegisterForm] = useState({ name: "", email: "", password: "" });
  const [puppeteerLoading, setPuppeteerLoading] = useState(false);
  const [puppeteerResult, setPuppeteerResult] = useState(null);
  const [wherebyCreating, setWherebyCreating] = useState(false);
  const [testStarting, setTestStarting] = useState(false);
  const [testStopping, setTestStopping] = useState(false);
  const [liveTestRunning, setLiveTestRunning] = useState(false);
  const [activeTestSessionId, setActiveTestSessionId] = useState("");
  const [activeTestElapsedSec, setActiveTestElapsedSec] = useState(null);
  const [chaosProfile, setChaosProfile] = useState("off");
  const [auditTargetUsers, setAuditTargetUsers] = useState(1);
  const [auditChaos, setAuditChaos] = useState("off");
  const [controlBusy, setControlBusy] = useState(false);
  const [historyItems, setHistoryItems] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  const [historicalAudit, setHistoricalAudit] = useState(null);
  const [historicalAuditLoading, setHistoricalAuditLoading] = useState(false);

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

  const setMessage = (message, type = "") => {
    setFeedback(message);
    setFeedbackType(type);
  };

  function handleSessionInvalid() {
    localStorage.removeItem("streamSentryToken");
    setAuthToken("");
    setScreen("auth");
    setTab("login");
    setMainView("start");
    setLiveTestRunning(false);
    setMessage(
      "Sessão expirada ou inválida. Entre de novo. Se o erro voltar, confirme no servidor o mesmo JWT_SECRET usado no login (ex.: variável de ambiente .env) e que o token não esteja desatualizado no navegador.",
      "error"
    );
  }

  function markTestFinished() {
    setLiveTestRunning(false);
    setActiveTestSessionId("");
    setActiveTestElapsedSec(null);
  }

  const telemetry = useTelemetryWS(apiBaseUrl, authToken, screen === "app", {
    onTestRunFinished: markTestFinished,
    onSessionInvalid: handleSessionInvalid
  });

  function applyTestStatus(status, { announce = false } = {}) {
    const running = Boolean(status?.running);
    setLiveTestRunning(running);
    if (!running) {
      setActiveTestSessionId("");
      setActiveTestElapsedSec(null);
      return;
    }

    const users = Number(status.targetVirtualUsers ?? status.virtualUsers);
    if (Number.isFinite(users) && users >= 1) {
      setAuditTargetUsers(users);
    }
    const profile = status.chaosProfile || "off";
    setAuditChaos(profile);
    setChaosProfile(profile);
    setActiveTestSessionId(status.sessionId || "");
    setActiveTestElapsedSec(Number.isFinite(Number(status.elapsedSec)) ? Number(status.elapsedSec) : null);
    setMainView("audit");
    if (announce) {
      setMessage("Teste em execução recuperado. Pode acompanhar e finalizar pela Auditoria.", "success");
    }
  }

  async function syncTestStatus(options = {}) {
    const status = await getWithAuth("/test/status", authToken);
    applyTestStatus(status, options);
    return status;
  }

  useEffect(() => {
    if (screen !== "app" || !authToken) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const status = await getWithAuth("/test/status", authToken);
        if (!cancelled) applyTestStatus(status);
      } catch (e) {
        if (cancelled) return;
        if (e.unauthorized) {
          handleSessionInvalid();
          return;
        }
        setMessage(e.message, "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [screen, authToken]);

  useEffect(() => {
    if (screen !== "app" || !authToken || mainView !== "history") return undefined;
    let cancelled = false;
    (async () => {
      setHistoryLoading(true);
      try {
        const data = await getWithAuth("/tests/history", authToken);
        if (!cancelled) setHistoryItems(data.items || []);
      } catch (e) {
        if (cancelled) return;
        if (e.unauthorized) {
          handleSessionInvalid();
          return;
        }
        setMessage(e.message, "error");
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [screen, authToken, mainView]);

  async function handleRegister(event) {
    event.preventDefault();
    try {
      const result = await post("/auth/register", registerForm);
      localStorage.setItem("streamSentryToken", result.token);
      setAuthToken(result.token);
      setMessage("Cadastro realizado com sucesso.", "success");
      setRegisterForm({ name: "", email: "", password: "" });
      setScreen("app");
      setMainView("start");
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
      setMainView("start");
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

  async function handleCreateWherebyRoom() {
    try {
      setWherebyCreating(true);
      setMessage("Criando sala Whereby…", "");
      const result = await postWithAuth("/platform/whereby/create-room", {}, authToken);
      setConfigForm((prev) => ({ ...prev, apiUrl: result.roomUrl, accessToken: "" }));
      setMessage(`Sala criada: ${result.roomUrl}`, "success");
    } catch (error) {
      if (error.unauthorized) { handleSessionInvalid(); return; }
      setMessage(error.message, "error");
    } finally {
      setWherebyCreating(false);
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
      const result = await postWithAuth(
        "/test/start",
        { ...validated, chaos: { profile: chaosProfile } },
        authToken
      );
      setAuditTargetUsers(validated.virtualUsers);
      setAuditChaos(chaosProfile);
      setActiveTestSessionId(result.sessionId || "");
      setActiveTestElapsedSec(0);
      setLiveTestRunning(true);
      setMessage("Teste iniciado. Veja a aba Auditoria para métricas ao vivo.", "success");
      setMainView("audit");
    } catch (error) {
      if (error.unauthorized) {
        handleSessionInvalid();
        return;
      }
      if (error.message.toLowerCase().includes("already running")) {
        try {
          await syncTestStatus({ announce: true });
        } catch {
          setMessage("Já existe um teste em execução, mas não foi possível recuperar o estado agora.", "error");
        }
        return;
      }
      setMessage(error.message, "error");
    } finally {
      setTestStarting(false);
    }
  }

  async function handleApplyTestControl() {
    try {
      setControlBusy(true);
      await postWithAuth(
        "/test/control",
        { targetVirtualUsers: auditTargetUsers, chaos: { profile: auditChaos } },
        authToken
      );
      setMessage("Controlo do teste atualizado.", "success");
    } catch (error) {
      if (error.unauthorized) {
        handleSessionInvalid();
        return;
      }
      setMessage(error.message, "error");
    } finally {
      setControlBusy(false);
    }
  }

  async function handleInjectChaos(profile) {
    try {
      setControlBusy(true);
      setAuditChaos(profile);
      await postWithAuth("/test/control", { chaos: { profile } }, authToken);
      setMessage(`Rede / chaos aplicado: ${profile}`, "success");
    } catch (error) {
      if (error.unauthorized) {
        handleSessionInvalid();
        return;
      }
      setMessage(error.message, "error");
    } finally {
      setControlBusy(false);
    }
  }

  async function handlePauseTest() {
    try {
      setControlBusy(true);
      await postWithAuth("/test/pause", {}, authToken);
      setMessage("Pausa pedida — o dwell na página vai congelar.", "success");
    } catch (error) {
      if (error.unauthorized) {
        handleSessionInvalid();
        return;
      }
      setMessage(error.message, "error");
    } finally {
      setControlBusy(false);
    }
  }

  async function handleResumeTest() {
    try {
      setControlBusy(true);
      await postWithAuth("/test/resume", {}, authToken);
      setMessage("Retomada pedida.", "success");
    } catch (error) {
      if (error.unauthorized) {
        handleSessionInvalid();
        return;
      }
      setMessage(error.message, "error");
    } finally {
      setControlBusy(false);
    }
  }

  async function handleDownloadReport(format, opts = {}) {
    const { includeEvents = false, sessionId = null } = opts;
    try {
      setReportBusy(true);
      const params = new URLSearchParams({ format });
      if (includeEvents) params.set("includeEvents", "1");
      if (sessionId) params.set("sessionId", sessionId);

      let name = "stream-sentry-relatorio.json";
      if (format === "csv") {
        if (sessionId) {
          name = includeEvents
            ? `stream-sentry-eventos-${sessionId}.csv`
            : `stream-sentry-sessao-${sessionId}.csv`;
        } else {
          name = "stream-sentry-relatorio.csv";
        }
      } else if (format === "json") {
        if (sessionId) {
          name = includeEvents
            ? `stream-sentry-sessao-completa-${sessionId}.json`
            : `stream-sentry-sessao-${sessionId}.json`;
        } else if (includeEvents) {
          name = "stream-sentry-todas-sessoes-detalhado.json";
        } else {
          name = "stream-sentry-relatorio.json";
        }
      }

      await downloadReportBlob(`/reports/export?${params.toString()}`, authToken, name);
      setMessage(`Relatório ${format.toUpperCase()} transferido.`, "success");
    } catch (error) {
      if (error.unauthorized) {
        handleSessionInvalid();
        return;
      }
      setMessage(error.message, "error");
    } finally {
      setReportBusy(false);
    }
  }

  async function handleOpenHistoricalAudit(sessionId) {
    try {
      setHistoricalAuditLoading(true);
      setMessage("A carregar auditoria histórica…", "");
      const data = await getWithAuth(`/reports/session/${encodeURIComponent(sessionId)}`, authToken);
      const snapshot = buildTelemetrySnapshotFromEvents(data.events || [], data.session || { id: sessionId });
      setHistoricalAudit({ session: data.session || { id: sessionId }, snapshot });
      setMainView("historicalAudit");
      setMessage("Auditoria histórica carregada.", "success");
    } catch (error) {
      if (error.unauthorized) {
        handleSessionInvalid();
        return;
      }
      setMessage(error.message, "error");
    } finally {
      setHistoricalAuditLoading(false);
    }
  }

  async function handleStopTest(event) {
    event?.preventDefault();
    try {
      setTestStopping(true);
      await postWithAuth("/test/stop", {}, authToken);
      markTestFinished();
      setMessage("Teste a encerrar (Chromium e Puppeteer vão fechar).", "success");
    } catch (error) {
      if (error.unauthorized) {
        handleSessionInvalid();
        return;
      }
      setMessage(error.message, "error");
    } finally {
      setTestStopping(false);
    }
  }

  function handleLogout() {
    localStorage.removeItem("streamSentryToken");
    setAuthToken("");
    setLiveTestRunning(false);
    setScreen("landing");
    setTab("login");
    setMainView("start");
    setMessage("Sessão encerrada.", "success");
  }

  function handleUseExample() {
    setConfigForm(sampleConfig);
    setPuppeteerResult(null);
    setMessage("Exemplo preenchido.", "success");
  }

  return (
    <main className="app-root">
      {screen === "landing" ? (
        <LandingPage
          onEntrar={() => {
            setTab("login");
            setMessage("");
            setScreen("auth");
          }}
          onRegisto={() => {
            setTab("register");
            setMessage("");
            setScreen("auth");
          }}
        />
      ) : null}
      {screen === "auth" ? (
        <section className="card card-auth">
          <button type="button" className="link-back" onClick={() => setScreen("landing")}>
            ← Voltar ao início
          </button>
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
      ) : null}
      {screen === "app" ? (
        <section className={`card card-app ${mainView === "audit" || mainView === "historicalAudit" ? "card-app-audit" : ""}`}>
          <header className="site-header">
            <div className="site-header-top">
              <a href="#main-app" className="site-brand" onClick={(e) => e.preventDefault()}>
                <img src={logo} alt="" className="site-brand-icon" width={40} height={40} />
                <div>
                  <span className="site-brand-title">Stream Sentry</span>
                  <span className="site-brand-sub">Auditoria e stress WebRTC</span>
                </div>
              </a>
              <nav className="site-nav" aria-label="Navegação principal">
                <button
                  type="button"
                  className={`nav-link ${mainView === "start" ? "active" : ""}`}
                  onClick={() => setMainView("start")}
                >
                  Iniciar teste
                </button>
                <button
                  type="button"
                  className={`nav-link ${mainView === "audit" ? "active" : ""}`}
                  onClick={() => setMainView("audit")}
                >
                  Auditoria
                </button>
                <button
                  type="button"
                  className={`nav-link ${mainView === "history" || mainView === "historicalAudit" ? "active" : ""}`}
                  onClick={() => setMainView("history")}
                >
                  Histórico
                </button>
              </nav>
              <div className="site-header-actions">
                {liveTestRunning && (
                  <button
                    type="button"
                    className="btn-header-stop"
                    onClick={handleStopTest}
                    disabled={testStopping}
                    title="Cancela o processo Node/Puppeteer no servidor"
                  >
                    {testStopping ? "A encerrar…" : "Finalizar teste"}
                  </button>
                )}
                <button type="button" className="btn-header-logout" onClick={handleLogout}>
                  Sair
                </button>
              </div>
            </div>
          </header>

          <p className={`feedback feedback-top ${feedbackType}`}>{feedback}</p>

          {mainView === "start" && (
            <>
              <p className="config-intro">
                Defina a URL alvo, o token Bearer enviado nas requisições e quantos usuários virtuais o Puppeteer irá
                simular em lotes. Também pode usar salas WebRTC como Jitsi ou Whereby; nesses domínios o token é opcional.
              </p>
              <p className="muted-small">
                Zoom: prefira uma página sua com Zoom Meeting SDK. Links públicos <code>zoom.us/j/...</code> são tentados via
                web client, mas podem pedir login, CAPTCHA ou confirmação manual.
              </p>
              <div className="example-box">
                <p>Exemplo rápido para testar:</p>
                <code>URL: {sampleConfig.apiUrl}</code>
                <button className="ghost" type="button" onClick={handleUseExample}>
                  Usar exemplo
                </button>
              </div>
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
                  <button
                    className="ghost"
                    type="button"
                    onClick={handleCreateWherebyRoom}
                    disabled={wherebyCreating}
                    style={{ marginTop: "8px" }}
                  >
                    {wherebyCreating ? "Criando sala…" : "Criar sala Whereby"}
                  </button>
                </div>
                <div className="config-block">
                  <h2>Autenticação</h2>
                  <label htmlFor="start-token">
                    Token de acesso{isWherebyUrl(configForm.apiUrl) ? " (não necessário para Whereby)" : ""}
                  </label>
                  <input
                    id="start-token"
                    type="text"
                    value={configForm.accessToken}
                    onChange={(e) => setConfigForm({ ...configForm, accessToken: e.target.value })}
                    required={!isWherebyUrl(configForm.apiUrl)}
                    placeholder={isWherebyUrl(configForm.apiUrl) ? "Opcional para Whereby" : ""}
                  />
                </div>
                <div className="config-block">
                  <h2>Usuários virtuais (Puppeteer)</h2>
                  <label htmlFor="start-users">Quantidade inicial (1 a 50)</label>
                  <input
                    id="start-users"
                    type="number"
                    min={1}
                    max={50}
                    value={configForm.virtualUsers}
                    onChange={(e) => setConfigForm({ ...configForm, virtualUsers: Number(e.target.value) })}
                    required
                  />
                  <p className="muted-small">
                    Com o servidor em modo pool, este valor define a concorrência inicial; pode ajustar durante o teste na
                    Auditoria.
                  </p>
                </div>
                <div className="config-block">
                  <h2>Chaos (rede)</h2>
                  <label htmlFor="chaos-profile">Perfil de injeção de falhas na chamada</label>
                  <select
                    id="chaos-profile"
                    value={chaosProfile}
                    onChange={(e) => setChaosProfile(e.target.value)}
                  >
                    {CHAOS_START_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="actions-inline">
                  <button className="submit" type="submit" disabled={testStarting || testStopping}>
                    {testStarting ? "Iniciando…" : "Iniciar teste"}
                  </button>
                  <button className="ghost" type="button" onClick={handleSaveConfig}>
                    Salvar configurações
                  </button>
                  <button className="ghost" type="button" onClick={handlePuppeteerSmoke} disabled={puppeteerLoading}>
                    {puppeteerLoading ? "Executando..." : "Testar Puppeteer"}
                  </button>
                  <button
                    type="button"
                    className="ghost stop-test"
                    onClick={handleStopTest}
                    disabled={testStopping || !liveTestRunning}
                  >
                    {testStopping ? "A encerrar…" : "Finalizar teste"}
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

          {mainView === "history" && (
            <>
              <p className="subtitle">Histórico de testes e relatórios</p>
              <p className="config-intro">
                Cada teste gera um ficheiro NDJSON no servidor com <strong>todos os eventos</strong> (rede, WebRTC,
                latências). O resumo agrega contagens HTTP, estatísticas RTT/jitter e uma série temporal de latência.
                Use as exportações detalhadas para análise completa ou por sessão.
              </p>
              <div className="report-actions report-actions-grid">
                <button
                  type="button"
                  className="submit"
                  disabled={reportBusy}
                  onClick={() => handleDownloadReport("json")}
                >
                  {reportBusy ? "A preparar…" : "JSON (resumo)"}
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={reportBusy}
                  onClick={() => handleDownloadReport("csv")}
                >
                  CSV (resumo alargado)
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={reportBusy}
                  title="Todas as sessões com eventos completos (pode ser um ficheiro grande)"
                  onClick={() => handleDownloadReport("json", { includeEvents: true })}
                >
                  JSON completo (todas)
                </button>
              </div>
              {historyLoading ? (
                <p className="muted-small">A carregar histórico…</p>
              ) : (
                <div className="history-table-wrap">
                  <table className="history-table">
                    <thead>
                      <tr>
                        <th>Sessão</th>
                        <th>Início</th>
                        <th>Duração (s)</th>
                        <th>Chaos</th>
                        <th>RTT médio</th>
                        <th>HTTP req</th>
                        <th>WebRTC amostras</th>
                        <th>Estado</th>
                        <th>Ações</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyItems.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="muted-small">
                            Ainda não há testes concluídos neste servidor.
                          </td>
                        </tr>
                      ) : (
                        [...historyItems].reverse().map((row) => (
                          <tr key={row.id}>
                            <td>
                              <code className="history-id">{row.id}</code>
                            </td>
                            <td>{row.startedAt ? new Date(row.startedAt).toLocaleString() : "—"}</td>
                            <td>{row.durationSec != null ? Number(row.durationSec).toFixed(1) : "—"}</td>
                            <td>{row.chaosProfile ?? "—"}</td>
                            <td>
                              {row.summary?.webrtc?.rttMs?.avg != null
                                ? `${Number(row.summary.webrtc.rttMs.avg).toFixed(1)} ms`
                                : "—"}
                            </td>
                            <td>{row.summary?.http?.requests ?? "—"}</td>
                            <td>{row.summary?.webrtc?.statsSamples ?? "—"}</td>
                            <td>{row.exitOk ? "OK" : "Erro"}</td>
                            <td className="history-actions-cell">
                              <div className="history-actions">
                                <button
                                  type="button"
                                  className="submit btn-tiny"
                                  disabled={historicalAuditLoading}
                                  title="Abrir esta sessão usando a mesma tela de Auditoria"
                                  onClick={() => handleOpenHistoricalAudit(row.id)}
                                >
                                  {historicalAuditLoading ? "Abrindo…" : "Ver auditoria"}
                                </button>
                                <button
                                  type="button"
                                  className="ghost btn-tiny"
                                  disabled={reportBusy}
                                  title="JSON com metadados + todos os eventos NDJSON"
                                  onClick={() => handleDownloadReport("json", { sessionId: row.id, includeEvents: true })}
                                >
                                  JSON+log
                                </button>
                                <button
                                  type="button"
                                  className="ghost btn-tiny"
                                  disabled={reportBusy}
                                  title="Uma linha por evento (evento, tempo, JSON)"
                                  onClick={() => handleDownloadReport("csv", { sessionId: row.id, includeEvents: true })}
                                >
                                  CSV
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
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
              webrtcPerUserSeries={telemetry.webrtcPerUserSeries}
              webrtcLastByUser={telemetry.webrtcLastByUser}
              liveTestRunning={liveTestRunning}
              testElapsedSec={telemetry.testElapsedSec ?? activeTestElapsedSec}
              activeSessionId={telemetry.activeSessionId || activeTestSessionId}
              auditTargetUsers={auditTargetUsers}
              auditChaos={auditChaos}
              onAuditTargetChange={setAuditTargetUsers}
              onAuditChaosChange={setAuditChaos}
              onApplyControl={handleApplyTestControl}
              onPause={handlePauseTest}
              onResume={handleResumeTest}
              controlBusy={controlBusy}
              onInjectChaos={handleInjectChaos}
              seriesTimeMs={telemetry.seriesTimeMs}
              testWallStartMs={telemetry.testWallStartMs}
            />
          )}

          {mainView === "historicalAudit" && historicalAudit?.snapshot && (
            <>
              <div className="history-audit-toolbar">
                <button type="button" className="ghost" onClick={() => setMainView("history")}>
                  ← Voltar ao histórico
                </button>
                <span className="muted-small">
                  Visualizando sessão <code>{historicalAudit.session?.id || historicalAudit.snapshot.activeSessionId}</code>
                </span>
              </div>
              <AuditDashboard
                connected={false}
                lastEvent={historicalAudit.snapshot.lastEvent}
                requestTotal={historicalAudit.snapshot.requestTotal}
                responseTotal={historicalAudit.snapshot.responseTotal}
                failTotal={historicalAudit.snapshot.failTotal}
                cumulativeSeries={historicalAudit.snapshot.cumulativeSeries}
                rpsSeries={historicalAudit.snapshot.rpsSeries}
                statusCounts={historicalAudit.snapshot.statusCounts}
                feed={historicalAudit.snapshot.feed}
                webrtcAggregate={historicalAudit.snapshot.webrtcAggregate}
                webrtcSeries={historicalAudit.snapshot.webrtcSeries}
                webrtcLastByUser={historicalAudit.snapshot.webrtcLastByUser}
                liveTestRunning={false}
                testElapsedSec={historicalAudit.snapshot.testElapsedSec}
                activeSessionId={historicalAudit.snapshot.activeSessionId}
                auditTargetUsers={0}
                auditChaos={historicalAudit.session?.chaosProfile || "off"}
                controlBusy={false}
                seriesTimeMs={historicalAudit.snapshot.seriesTimeMs}
                testWallStartMs={historicalAudit.snapshot.testWallStartMs}
                historical
              />
            </>
          )}
        </section>
      ) : null}
    </main>
  );
}
