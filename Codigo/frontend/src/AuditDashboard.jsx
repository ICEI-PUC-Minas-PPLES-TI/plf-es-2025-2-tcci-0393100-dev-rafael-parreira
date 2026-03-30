import React from "react";

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

function SimpleLineChart({ series, label, color, unit = "" }) {
  const w = 320;
  const h = 120;
  const pad = 8;
  if (!series.length) {
    return (
      <div className="chart-placeholder">
        <span>{label}</span>
        <p className="muted-small">Aguardando eventos…</p>
      </div>
    );
  }
  const maxVal = Math.max(...series, 1e-6);
  const step = (w - pad * 2) / Math.max(series.length - 1, 1);
  const points = series.map((v, i) => {
    const x = pad + i * step;
    const y = h - pad - (v / maxVal) * (h - pad * 2);
    return `${x},${y}`;
  });
  return (
    <div className="chart-wrap">
      <span className="chart-label">
        {label}
        {unit ? ` (${unit})` : ""}
      </span>
      <svg viewBox={`0 0 ${w} ${h}`} className="chart-svg" preserveAspectRatio="none">
        <polyline fill="none" stroke={color} strokeWidth="2" points={points.join(" ")} />
      </svg>
    </div>
  );
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
    .filter((r) => r.peerConnections > 0);
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
  webrtcLastByUser
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
        <div className="audit-charts webrtc-charts">
          <SimpleLineChart series={webrtcSeries.rttMs} label="RTT" color="#a78bfa" unit="ms" />
          <SimpleLineChart series={webrtcSeries.jitterVideo} label="Jitter vídeo" color="#f472b6" unit="ms" />
          <SimpleLineChart series={webrtcSeries.downlinkKbps} label="Taxa recebida (aprox.)" color="#34d399" unit="kbps" />
          <SimpleLineChart series={webrtcSeries.fpsIn} label="FPS vídeo (inbound)" color="#fbbf24" unit="fps" />
        </div>
        <h4 className="webrtc-sub">Por usuário virtual</h4>
        <WebRTCByUserTable lastByUser={webrtcLastByUser} />
      </div>

      <div className="audit-charts">
        <SimpleLineChart series={cumulativeSeries} label="Requisições acumuladas" color="#22c55e" />
        <SimpleLineChart series={rpsSeries} label="Atividade por segundo (aprox.)" color="#38bdf8" />
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
                <code>{item.text}</code>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
