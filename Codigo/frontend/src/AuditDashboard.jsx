import React from "react";
import { summaryHasWebrtcActivity } from "./useTelemetryWS.js";
import TimeSeriesLineChart from "./TimeSeriesLineChart.jsx";

function fmtMs(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(1)} ms`;
}

function fmtNum(v, d = 0) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(d);
}

function fmtKbps(v) {
  if (v == null || !Number.isFinite(v) || v <= 0) return "—";
  if (v >= 1000) return `${(v / 1000).toFixed(2)} Mbps`;
  return `${v.toFixed(0)} kbps`;
}

function fmtBytes(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KiB`;
  return `${(v / (1024 * 1024)).toFixed(2)} MiB`;
}

function fmtDurationSec(sec) {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function shortClock(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  } catch {
    return "";
  }
}

function StatusBars({ counts }) {
  const entries = Object.entries(counts).sort((a, b) => Number(b[1]) - Number(a[1]));
  if (!entries.length) {
    return <p className="muted-small">Nenhuma resposta HTTP ainda.</p>;
  }
  const max = Math.max(...entries.map(([, n]) => n), 1);
  return (
    <div className="status-bars">
      {entries.map(([status, n]) => (
        <div key={status} className="status-bar-row">
          <span className="status-code">{status}</span>
          <div className="status-bar-track">
            <div className="status-bar-fill" style={{ width: `${(n / max) * 100}%` }} />
          </div>
          <span className="status-count">{n}</span>
        </div>
      ))}
    </div>
  );
}

function WebRTCKpis({ agg }) {
  const lossRate =
    agg.packetsReceivedTotal > 0
      ? (100 * agg.packetsLostTotal) / (agg.packetsLostTotal + agg.packetsReceivedTotal)
      : null;

  const items = [
    { label: "RTT (par candidato / remoto)", value: fmtMs(agg.roundTripTimeMs) },
    { label: "Jitter vídeo (RTP)", value: fmtMs(agg.jitterVideo != null ? agg.jitterVideo * 1000 : null) },
    { label: "Jitter áudio (RTP)", value: fmtMs(agg.jitterAudio != null ? agg.jitterAudio * 1000 : null) },
    { label: "Usuários com WebRTC ativo", value: String(agg.usersWithRtc) },
    { label: "PeerConnections (soma)", value: String(agg.peerConnections) },
    { label: "Pacotes perdidos / recebidos", value: `${agg.packetsLostTotal} / ${agg.packetsReceivedTotal}` },
    { label: "Perda estimada", value: lossRate != null && Number.isFinite(lossRate) ? `${lossRate.toFixed(2)} %` : "—" },
    { label: "Frames decodificados", value: String(agg.framesDecoded) },
    { label: "Frames codificados (out)", value: String(agg.framesEncoded) },
    { label: "FPS entrada (último sample)", value: fmtNum(agg.fpsIn, 1) },
    { label: "FPS saída (último sample)", value: fmtNum(agg.fpsOut, 1) },
    { label: "Resolução vídeo (último)", value: agg.resolution || "—" },
    { label: "Bytes recebidos (RTP in)", value: fmtBytes(agg.inboundBytes) },
    { label: "Bytes enviados (RTP out)", value: fmtBytes(agg.outboundBytes) },
    { label: "Bitrate saída disponível (est.)", value: fmtKbps(agg.availableOutgoingBitrate) }
  ];

  return (
    <div className="webrtc-kpi-grid">
      {items.map((it) => (
        <div key={it.label} className="webrtc-kpi">
          <span className="webrtc-kpi-label">{it.label}</span>
          <span className="webrtc-kpi-value">{it.value}</span>
        </div>
      ))}
    </div>
  );
}

function WebRTCByUserTable({ lastByUser }) {
  const rows = Object.entries(lastByUser)
    .map(([id, s]) => ({ id, ...s }))
    .filter((r) => summaryHasWebrtcActivity(r));
  if (!rows.length) {
    return <p className="muted-small">Nenhum RTCPeerConnection ativo nos workers (página sem WebRTC ou ainda a conectar).</p>;
  }
  return (
    <div className="webrtc-user-table-wrap">
      <table className="webrtc-user-table">
        <thead>
          <tr>
            <th>User</th>
            <th>PCs</th>
            <th>RTT</th>
            <th>Jitter V</th>
            <th>Perda V</th>
            <th>Frames dec.</th>
            <th>Resolução</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{r.peerConnections}</td>
              <td>{fmtMs(r.candidatePair?.currentRoundTripTimeMs)}</td>
              <td>{fmtMs(r.inboundVideo?.jitter != null ? r.inboundVideo.jitter * 1000 : null)}</td>
              <td>
                {r.inboundVideo?.packetsLost ?? 0} / {r.inboundVideo?.packetsReceived ?? 0}
              </td>
              <td>{r.inboundVideo?.framesDecoded ?? 0}</td>
              <td>
                {r.inboundVideo?.frameWidth && r.inboundVideo?.frameHeight
                  ? `${r.inboundVideo.frameWidth}×${r.inboundVideo.frameHeight}`
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const CHAOS_OPTIONS = [
  { value: "off", label: "Desligado" },
  { value: "slow_3g", label: "Rede lenta (3G)" },
  { value: "fast_3g", label: "3G rápida" },
  { value: "high_latency", label: "Alta latência" },
  { value: "offline", label: "Offline" },
  { value: "flaky", label: "Intermitente (chaos)" },
  { value: "dns_failure", label: "Falha DNS (simulada)" }
];

const CHAOS_QUICK = [
  { value: "off", label: "Normal" },
  { value: "slow_3g", label: "3G lenta" },
  { value: "high_latency", label: "Latência +" },
  { value: "offline", label: "Offline" },
  { value: "flaky", label: "Instável" }
];

export default function AuditDashboard({
  connected,
  lastEvent,
  requestTotal,
  responseTotal,
  failTotal,
  cumulativeSeries,
  rpsSeries,
  statusCounts,
  feed,
  webrtcAggregate,
  webrtcSeries,
  webrtcLastByUser,
  liveTestRunning,
  testElapsedSec,
  elapsedSeries,
  activeSessionId,
  auditTargetUsers,
  auditChaos,
  onAuditTargetChange,
  onAuditChaosChange,
  onApplyControl,
  onPause,
  onResume,
  controlBusy,
  onInjectChaos,
  seriesTimeMs = { cumulative: [], rps: [], elapsed: [], webrtc: {} },
  testWallStartMs = null
}) {
  return (
    <div className="audit-dashboard">
      <div className="audit-header">
        <h2>Auditoria em tempo real</h2>
        <p className="muted-small">
          WebSocket: {connected ? <span className="ok">conectado</span> : <span className="warn">desconectado</span>}
          {lastEvent ? ` · último evento: ${lastEvent}` : ""}
        </p>
      </div>

      {liveTestRunning && (
        <div className="audit-controls-panel">
          <div className="audit-duration-row">
            <div className="duration-pill">
              <span className="muted-small">Duração do teste</span>
              <strong className="duration-value">{fmtDurationSec(testElapsedSec)}</strong>
              {activeSessionId ? (
                <code className="session-chip" title="Sessão">
                  {activeSessionId}
                </code>
              ) : null}
            </div>
            <div className="audit-pause-row">
              <button type="button" className="ghost btn-compact" onClick={onPause} disabled={controlBusy}>
                Pausar
              </button>
              <button type="button" className="ghost btn-compact" onClick={onResume} disabled={controlBusy}>
                Retomar
              </button>
            </div>
          </div>
          <div className="audit-control-grid">
            <label className="control-field">
              <span>Utilizadores virtuais (concorrência)</span>
              <input
                type="number"
                min={1}
                max={50}
                value={auditTargetUsers}
                onChange={(e) => onAuditTargetChange(Number(e.target.value))}
              />
            </label>
            <label className="control-field">
              <span>Perfil de rede (chaos)</span>
              <select value={auditChaos} onChange={(e) => onAuditChaosChange(e.target.value)}>
                {CHAOS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="submit btn-apply-control" onClick={onApplyControl} disabled={controlBusy}>
              {controlBusy ? "A aplicar…" : "Aplicar alterações"}
            </button>
          </div>
          {typeof onInjectChaos === "function" && (
            <div className="chaos-quick-row">
              <span className="muted-small chaos-quick-label">Injeção rápida</span>
              <div className="chaos-quick-buttons">
                {CHAOS_QUICK.map((q) => (
                  <button
                    key={q.value}
                    type="button"
                    className={`ghost chaos-chip ${auditChaos === q.value ? "active" : ""}`}
                    disabled={controlBusy}
                    onClick={() => onInjectChaos(q.value)}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <p className="muted-small control-hint">
            Pode alterar o perfil de rede <strong>em qualquer momento</strong>: o servidor atualiza <code>control.json</code> e
            o runner aplica CDP aos Chromium em ~1&nbsp;s. Use os atalhos ou o menu e &quot;Aplicar&quot;. Pausa congela o dwell
            na página; utilizadores ajustam a concorrência (pool).
          </p>
        </div>
      )}

      {elapsedSeries?.length > 0 && (
        <div className="audit-charts elapsed-chart-row">
          <TimeSeriesLineChart
            values={elapsedSeries}
            timeMs={seriesTimeMs.elapsed}
            testWallStartMs={testWallStartMs}
            label="Tempo decorrido do teste"
            color="#94a3b8"
            unit="s"
            metricKind="elapsed"
          />
        </div>
      )}

      <div className="audit-kpis">
        <div className="kpi">
          <span className="kpi-value">{requestTotal}</span>
          <span className="kpi-label">Requisições</span>
        </div>
        <div className="kpi">
          <span className="kpi-value">{responseTotal}</span>
          <span className="kpi-label">Respostas HTTP</span>
        </div>
        <div className="kpi">
          <span className="kpi-value">{failTotal}</span>
          <span className="kpi-label">Falhas de rede</span>
        </div>
      </div>

      <div className="audit-block webrtc-block">
        <h3>WebRTC</h3>
        <p className="muted-small webrtc-intro">
          O Puppeteer intercepta <code>RTCPeerConnection</code> e amostra <code>getStats()</code> a cada poucos segundos:
          RTP in/out, pares ICE, transporte, jitter, RTT e frames — alinhado ao que o internos do Chrome expõe.
        </p>
        <WebRTCKpis agg={webrtcAggregate} />
        <p className="muted-small webrtc-chart-note">
          Os gráficos abaixo só desenham linhas com tráfego WebRTC (RTP, PeerConnections). As curvas de requisições HTTP estão
          abaixo; tráfego 200/304 do Meet não significa sozinho que a chamada de vídeo subiu.
        </p>
        <div className="audit-charts webrtc-charts">
          <TimeSeriesLineChart
            values={webrtcSeries.rttMs}
            timeMs={seriesTimeMs.webrtc?.rttMs}
            testWallStartMs={testWallStartMs}
            label="RTT"
            color="#a78bfa"
            unit="ms"
            metricKind="rtt"
          />
          <TimeSeriesLineChart
            values={webrtcSeries.jitterVideo}
            timeMs={seriesTimeMs.webrtc?.jitterVideo}
            testWallStartMs={testWallStartMs}
            label="Jitter vídeo"
            color="#f472b6"
            unit="ms"
            metricKind="jitterVideo"
          />
          <TimeSeriesLineChart
            values={webrtcSeries.downlinkKbps}
            timeMs={seriesTimeMs.webrtc?.downlinkKbps}
            testWallStartMs={testWallStartMs}
            label="Taxa recebida (aprox.)"
            color="#34d399"
            unit="kbps"
            metricKind="downlinkKbps"
          />
          <TimeSeriesLineChart
            values={webrtcSeries.fpsIn}
            timeMs={seriesTimeMs.webrtc?.fpsIn}
            testWallStartMs={testWallStartMs}
            label="FPS vídeo (inbound)"
            color="#fbbf24"
            unit="fps"
            metricKind="fpsIn"
          />
        </div>
        <h4 className="webrtc-sub">Por usuário virtual</h4>
        <WebRTCByUserTable lastByUser={webrtcLastByUser} />
      </div>

      <div className="audit-charts">
        <TimeSeriesLineChart
          values={cumulativeSeries}
          timeMs={seriesTimeMs.cumulative}
          testWallStartMs={testWallStartMs}
          label="Requisições acumuladas"
          color="#22c55e"
          unit="req"
          metricKind="cumulative"
        />
        <TimeSeriesLineChart
          values={rpsSeries}
          timeMs={seriesTimeMs.rps}
          testWallStartMs={testWallStartMs}
          label="Atividade por segundo (aprox.)"
          color="#38bdf8"
          unit="evt/s"
          metricKind="rps"
        />
      </div>

      <div className="audit-block">
        <h3>Distribuição de status HTTP</h3>
        <StatusBars counts={statusCounts} />
      </div>

      <div className="audit-block">
        <h3>Feed ao vivo</h3>
        <ul className="feed-list">
          {feed.length === 0 ? (
            <li className="muted-small">Inicie um teste na aba &quot;Iniciar teste&quot; para ver o tráfego aqui.</li>
          ) : (
            feed.map((item, i) => (
              <li key={`${item.ts}-${i}`} className={item.kind === "fail" ? "feed-fail" : ""}>
                <code>
                  {item.ts ? <span className="feed-time">{shortClock(item.ts)} · </span> : null}
                  {item.text}
                </code>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
