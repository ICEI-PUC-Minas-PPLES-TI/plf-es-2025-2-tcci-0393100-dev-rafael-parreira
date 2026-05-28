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

const UNAVAILABLE_LABEL = "Indisponível neste alvo";
const UNAVAILABLE_INFO =
  "Esta métrica depende de estatísticas RTP/vídeo que o alvo atual não expõe ao navegador. No Zoom web público, normalmente ficam disponíveis apenas RTT e bytes de transporte.";

function WebRTCKpis({ agg, mediaStatsUnavailable }) {
  const lossRate =
    agg.packetsReceivedTotal > 0
      ? (100 * agg.packetsLostTotal) / (agg.packetsLostTotal + agg.packetsReceivedTotal)
      : null;

  const maybeUnavailable = (value, info) => ({
    value: mediaStatsUnavailable ? UNAVAILABLE_LABEL : value,
    info: mediaStatsUnavailable ? `${info} ${UNAVAILABLE_INFO}` : info,
    unavailable: mediaStatsUnavailable
  });

  const items = [
    {
      label: "RTT (par candidato / remoto)",
      value: fmtMs(agg.roundTripTimeMs),
      info: "Tempo de ida e volta dos pacotes WebRTC. Valores altos indicam latência percebida na chamada."
    },
    {
      label: "Jitter vídeo (RTP)",
      ...maybeUnavailable(
        fmtMs(agg.jitterVideo != null ? agg.jitterVideo * 1000 : null),
        "Variação no tempo de chegada dos pacotes de vídeo RTP. Quanto maior, mais instável tende a ficar o vídeo."
      )
    },
    {
      label: "Jitter áudio (RTP)",
      ...maybeUnavailable(
        fmtMs(agg.jitterAudio != null ? agg.jitterAudio * 1000 : null),
        "Variação no tempo de chegada dos pacotes de áudio RTP. Pode causar cortes ou atraso perceptível no áudio."
      )
    },
    {
      label: "Usuários com WebRTC ativo",
      value: String(agg.usersWithRtc),
      info: "Quantidade de usuários virtuais que já apresentam tráfego ou métricas WebRTC relevantes."
    },
    {
      label: "PeerConnections (soma)",
      value: String(agg.peerConnections),
      info: "Soma das RTCPeerConnections detectadas nos browsers do teste."
    },
    {
      label: "Pacotes perdidos / recebidos",
      ...maybeUnavailable(
        `${agg.packetsLostTotal} / ${agg.packetsReceivedTotal}`,
        "Total de pacotes RTP perdidos comparado aos pacotes recebidos durante as amostras."
      )
    },
    {
      label: "Perda estimada",
      ...maybeUnavailable(
        lossRate != null && Number.isFinite(lossRate) ? `${lossRate.toFixed(2)} %` : "—",
        "Percentual estimado de perda de pacotes RTP. Perdas constantes afetam qualidade de áudio e vídeo."
      )
    },
    {
      label: "Frames decodificados",
      ...maybeUnavailable(String(agg.framesDecoded), "Quantidade de frames de vídeo recebidos e decodificados pelo browser.")
    },
    {
      label: "Frames codificados (out)",
      ...maybeUnavailable(String(agg.framesEncoded), "Quantidade de frames de vídeo preparados para envio pelo browser.")
    },
    {
      label: "FPS entrada (último sample)",
      ...maybeUnavailable(fmtNum(agg.fpsIn, 1), "Frames por segundo do vídeo recebido no último conjunto de métricas.")
    },
    {
      label: "FPS saída (último sample)",
      ...maybeUnavailable(fmtNum(agg.fpsOut, 1), "Frames por segundo do vídeo enviado no último conjunto de métricas.")
    },
    {
      label: "Resolução vídeo (último)",
      ...maybeUnavailable(agg.resolution || "—", "Última resolução de vídeo observada nas estatísticas inbound.")
    },
    {
      label: "Bytes recebidos (RTP in)",
      value: fmtBytes(agg.inboundBytes),
      info: "Volume total de dados RTP recebidos em áudio e vídeo."
    },
    {
      label: "Bytes enviados (RTP out)",
      value: fmtBytes(agg.outboundBytes),
      info: "Volume total de dados RTP enviados em áudio e vídeo."
    },
    {
      label: "Bitrate saída disponível (est.)",
      value: fmtKbps(agg.availableOutgoingBitrate),
      info: "Estimativa de banda disponível para envio reportada pelo par candidato WebRTC."
    }
  ];

  return (
    <div className="webrtc-kpi-grid">
      {items.map((it) => (
        <div key={it.label} className={`webrtc-kpi ${it.unavailable ? "webrtc-kpi--unavailable" : ""}`}>
          <span className="webrtc-kpi-label">
            {it.label}
            <span className="info-dot" tabIndex={0} aria-label={`Informação: ${it.info}`}>
              i
              <span className="info-tooltip" role="tooltip">
                {it.info}
              </span>
            </span>
          </span>
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

function getAuditStatus({ connected, liveTestRunning, lastEvent, historical }) {
  if (historical) return { label: "Concluído", tone: "done" };
  if (lastEvent === "test_stopped") return { label: "Finalizando", tone: "stopping" };
  if (lastEvent === "test_complete" || lastEvent === "server_audit_summary") return { label: "Concluído", tone: "done" };
  if (!liveTestRunning) return { label: "Aguardando", tone: "idle" };
  if (!connected) return { label: "Aguardando conexão", tone: "waiting" };
  if (!lastEvent) return { label: "Aguardando eventos", tone: "waiting" };
  if (lastEvent === "test_start") return { label: "Iniciando", tone: "starting" };
  if (lastEvent === "error" || lastEvent === "user_error") return { label: "Atenção", tone: "warning" };
  return { label: "Em execução", tone: "running" };
}

/**
 * Gera N cores dentro de uma família de matiz (hue) usando variação de
 * luminosidade e pequenos desvios de matiz para distinguir até 50 usuários.
 * Combina 5 offsets de matiz × 8 níveis de luminosidade = 40 combinações únicas
 * antes de repetir — mais que suficiente para 50 usuários.
 */
function makeFamilyPalette(baseHue, n = 50) {
  const lits  = [55, 70, 40, 65, 80, 45, 75, 35];   // 8 níveis de luminosidade
  const hoffs = [0, 15, -15, 25, -25];               // 5 offsets de matiz dentro da família
  return Array.from({ length: n }, (_, i) => {
    const hue = ((baseHue + hoffs[i % hoffs.length]) + 360) % 360;
    const lit = lits[Math.floor(i / hoffs.length) % lits.length];
    return `hsl(${hue}, 82%, ${lit}%)`;
  });
}

// Uma família de cor por gráfico — claramente distintas entre si na roda de cores
const CHART_PALETTES = {
  rttMs:        makeFamilyPalette(270),  // Roxo
  jitterVideo:  makeFamilyPalette(45),   // Âmbar / Amarelo
  downlinkKbps: makeFamilyPalette(165),  // Verde / Teal
  fpsIn:        makeFamilyPalette(340),  // Rosa / Pink
};

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
  webrtcPerUserSeries = {},
  webrtcLastByUser,
  liveTestRunning,
  testElapsedSec,
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
  testWallStartMs = null,
  historical = false
}) {
  const auditStatus = getAuditStatus({ connected, liveTestRunning, lastEvent, historical });

  const userIds = Object.keys(webrtcPerUserSeries || {}).sort((a, b) => Number(a) - Number(b));
  const buildMultiSeries = (key) => {
    const palette = CHART_PALETTES[key] || makeFamilyPalette(200);
    return userIds
      .map((uid, i) => ({
        values: webrtcPerUserSeries[uid]?.[key] || [],
        timeMs: webrtcPerUserSeries[uid]?.timeMs || [],
        color: palette[i] ?? palette[palette.length - 1],
        userId: uid
      }))
      .filter((s) => s.values.length > 0);
  };

  const hasWebrtcConnection =
    (webrtcAggregate?.peerConnections || 0) > 0 ||
    (webrtcAggregate?.roundTripTimeMs != null && Number.isFinite(webrtcAggregate.roundTripTimeMs));
  const userRows = Object.values(webrtcLastByUser || {});
  const hasStatsDebugMedia = userRows.some((row) => {
    const types = row?.statsDebug?.types || {};
    return (
      (types["inbound-rtp"] || 0) > 0 ||
      (types["outbound-rtp"] || 0) > 0 ||
      (types["remote-inbound-rtp"] || 0) > 0 ||
      (row?.statsDebug?.videoElements || []).length > 0
    );
  });
  const hasRtpMediaStats =
    hasStatsDebugMedia ||
    (webrtcAggregate?.packetsReceivedTotal || 0) > 0 ||
    (webrtcAggregate?.packetsLostTotal || 0) > 0 ||
    (webrtcAggregate?.framesDecoded || 0) > 0 ||
    (webrtcAggregate?.framesEncoded || 0) > 0 ||
    Boolean(webrtcAggregate?.resolution) ||
    webrtcAggregate?.jitterVideo != null ||
    webrtcAggregate?.jitterAudio != null ||
    (webrtcAggregate?.fpsIn != null && webrtcAggregate.fpsIn > 0) ||
    (webrtcAggregate?.fpsOut != null && webrtcAggregate.fpsOut > 0);
  const mediaStatsUnavailable = hasWebrtcConnection && !hasRtpMediaStats;
  const mediaUnavailableMessage =
    "Indisponível neste alvo: a chamada expõe conexão e bytes, mas não expõe estatísticas RTP/vídeo ao navegador.";

  return (
    <div className="audit-dashboard">
      <div className="audit-header">
        <div className="audit-title-row">
          <h2>{historical ? "Auditoria histórica" : "Auditoria em tempo real"}</h2>
          <span className={`audit-status-pill audit-status-pill--${auditStatus.tone}`}>{auditStatus.label}</span>
        </div>
        <p className="muted-small">
          {historical ? (
            <>
              Sessão finalizada reconstruída a partir do log salvo
              {activeSessionId ? (
                <>
                  {" "}
                  · <code>{activeSessionId}</code>
                </>
              ) : null}
            </>
          ) : (
            <>
              WebSocket: {connected ? <span className="ok">conectado</span> : <span className="warn">desconectado</span>}
              {lastEvent ? ` · último evento: ${lastEvent}` : ""}
            </>
          )}
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

      <div className="audit-charts">
        <TimeSeriesLineChart
          values={cumulativeSeries}
          timeMs={seriesTimeMs.cumulative}
          testWallStartMs={testWallStartMs}
          label="Requisições"
          color="#22c55e"
          unit="req"
          metricKind="cumulative"
        />
        <TimeSeriesLineChart
          values={rpsSeries}
          timeMs={seriesTimeMs.rps}
          testWallStartMs={testWallStartMs}
          label="Atividade"
          color="#38bdf8"
          unit="evt/s"
          metricKind="rps"
        />
      </div>

      <div className="audit-block webrtc-block">
        <h3>WebRTC</h3>
        <p className="muted-small webrtc-intro">
          O Puppeteer intercepta <code>RTCPeerConnection</code> e amostra <code>getStats()</code> a cada poucos segundos:
          RTP in/out, pares ICE, transporte, jitter, RTT e frames — alinhado ao que o internos do Chrome expõe.
        </p>
        <WebRTCKpis agg={webrtcAggregate} mediaStatsUnavailable={mediaStatsUnavailable} />
        <p className="muted-small webrtc-chart-note">
          {mediaStatsUnavailable
            ? "Este alvo expõe PeerConnections, RTT e bytes de transporte, mas não disponibiliza RTP/vídeo detalhado; por isso jitter, perda, frames e FPS ficam indisponíveis."
            : "Os gráficos abaixo só desenham linhas com tráfego WebRTC (RTP, PeerConnections). As curvas de requisições HTTP estão abaixo; tráfego 200/304 do Meet não significa sozinho que a chamada de vídeo subiu."}
        </p>
        <div className="audit-charts webrtc-charts">
          <TimeSeriesLineChart
            multiSeries={buildMultiSeries("rttMs")}
            values={webrtcSeries.rttMs}
            timeMs={seriesTimeMs.webrtc?.rttMs}
            testWallStartMs={testWallStartMs}
            label="RTT"
            color="hsl(270, 82%, 55%)"
            unit="ms"
            metricKind="rtt"
          />
          <TimeSeriesLineChart
            multiSeries={buildMultiSeries("jitterVideo")}
            values={webrtcSeries.jitterVideo}
            timeMs={seriesTimeMs.webrtc?.jitterVideo}
            testWallStartMs={testWallStartMs}
            label="Jitter vídeo"
            color="hsl(45, 82%, 55%)"
            unit="ms"
            metricKind="jitterVideo"
            unavailableMessage={mediaStatsUnavailable ? mediaUnavailableMessage : ""}
          />
          <TimeSeriesLineChart
            multiSeries={buildMultiSeries("downlinkKbps")}
            values={webrtcSeries.downlinkKbps}
            timeMs={seriesTimeMs.webrtc?.downlinkKbps}
            testWallStartMs={testWallStartMs}
            label="Taxa recebida"
            color="hsl(165, 82%, 55%)"
            unit="kbps"
            metricKind="downlinkKbps"
          />
          <TimeSeriesLineChart
            multiSeries={buildMultiSeries("fpsIn")}
            values={webrtcSeries.fpsIn}
            timeMs={seriesTimeMs.webrtc?.fpsIn}
            testWallStartMs={testWallStartMs}
            label="FPS vídeo (inbound)"
            color="hsl(340, 82%, 55%)"
            unit="fps"
            metricKind="fpsIn"
            unavailableMessage={mediaStatsUnavailable ? mediaUnavailableMessage : ""}
          />
        </div>
        <h4 className="webrtc-sub">Por usuário virtual</h4>
        <WebRTCByUserTable lastByUser={webrtcLastByUser} />
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
