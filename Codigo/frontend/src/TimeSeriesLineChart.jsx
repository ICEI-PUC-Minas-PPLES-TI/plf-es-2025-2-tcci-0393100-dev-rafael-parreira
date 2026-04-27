import React, { useCallback, useMemo, useState, useRef, useId } from "react";

const KIND_HINTS = {
  rtt: { high: 200, veryHigh: 400, unit: "ms" },
  jitterVideo: { high: 30, veryHigh: 80, unit: "ms" },
  downlinkKbps: { high: 500, veryHigh: 2000, unit: "kbps" },
  fpsIn: { low: 12, veryLow: 5, unit: "fps" },
  rps: { high: 50, veryHigh: 200, unit: "evt/s" },
  cumulative: {},
  elapsed: {}
};

function formatClock(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  try {
    return new Date(ms).toLocaleString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  } catch {
    return "—";
  }
}

function formatRelativeToStart(wallMs, startMs) {
  if (startMs == null || wallMs == null || !Number.isFinite(wallMs) || !Number.isFinite(startMs)) return null;
  const sec = (wallMs - startMs) / 1000;
  if (sec < 0) return null;
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function defaultFormatValue(v, unit) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (unit === "kbps") {
    if (v >= 1000) return `${(v / 1000).toFixed(2)} Mbps`;
    return `${v.toFixed(0)} kbps`;
  }
  if (unit === "s") return `${v.toFixed(1)} s`;
  if (unit === "ms") return `${v.toFixed(1)} ms`;
  if (unit === "fps") return `${v.toFixed(1)} fps`;
  if (unit === "req") return `${Math.round(v)} req`;
  if (unit === "evt/s") return `${v.toFixed(1)} evt/s`;
  return unit ? `${v.toFixed(2)} ${unit}` : String(v);
}

function buildTags(values, kind) {
  if (!values.length || !kind || kind === "cumulative" || kind === "elapsed") {
    if (kind === "cumulative" && values.length >= 2) {
      const last = values[values.length - 1] ?? 0;
      if (last > 100) {
        return [{ key: "load", text: "Volume HTTP elevado", tone: "warn" }];
      }
    }
    return [];
  }
  const h = KIND_HINTS[kind];
  if (!h) return [];
  const maxV = Math.max(...values, 0);
  const minV = values.length ? Math.min(...values) : 0;
  const tags = [];
  if (kind === "rtt" || kind === "jitterVideo") {
    if (maxV >= (h.veryHigh || 99999)) {
      tags.push({ key: "vh", text: kind === "rtt" ? "RTT muito alto" : "Jitter muito alto", tone: "bad" });
    } else if (maxV >= h.high) {
      tags.push({ key: "h", text: kind === "rtt" ? "Alta latência (RTT)" : "Jitter acentuado", tone: "warn" });
    }
  }
  if (kind === "downlinkKbps" && maxV >= (h.veryHigh || 2000)) {
    tags.push({ key: "bw", text: "Pico de débito recebido", tone: "ok" });
  }
  if (kind === "fpsIn" && minV < (h.veryLow || 0) && maxV > 0) {
    tags.push({ key: "fl", text: "FPS baixo nalguns momentos", tone: "warn" });
  }
  if (kind === "rps" && maxV >= h.high) {
    tags.push({ key: "burst", text: "Pico de requisições", tone: "warn" });
  }
  return tags.slice(0, 3);
}

/**
 * Série com eixo de tempo; hover mostra instante, valor (eixos) e dicas contextuais.
 */
export default function TimeSeriesLineChart({
  values = [],
  timeMs = [],
  label,
  color = "#22c55e",
  unit = "",
  testWallStartMs = null,
  metricKind = null,
  formatValue: formatValueProp
}) {
  const fmt = useCallback(
    (v) => (formatValueProp ? formatValueProp(v) : defaultFormatValue(v, unit)),
    [formatValueProp, unit]
  );

  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null);
  const gradId = useId().replace(/:/g, "");
  const W = 400;
  const H = 132;
  const padL = 44;
  const padR = 10;
  const padT = 28;
  const padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const aligned = useMemo(() => {
    const n = values.length;
    if (n === 0) return { pts: [], tMin: 0, tMax: 1, vMin: 0, vMax: 1 };
    const tms =
      timeMs && timeMs.length === n
        ? timeMs
        : values.map((_, i) => i);
    const tNum = tms.map((t) => (Number.isFinite(t) ? t : 0));
    const tMin = Math.min(...tNum);
    const tMax = Math.max(...tNum);
    const tSpan = tMax - tMin || 1;
    const vmax = Math.max(...values, 1e-9);
    const vmin = 0;
    const vspan = Math.max(vmax - vmin, 1e-9);
    const pts = values.map((v, i) => {
      const tx = tNum[i] ?? tMin;
      const x = padL + (innerW * (tx - tMin)) / tSpan;
      const y = padT + innerH * (1 - (v - vmin) / vspan);
      return { x, y, v, t: tx };
    });
    return { pts, tMin, tMax: tMin + tSpan, vMin: vmin, vMax: vmax };
  }, [values, timeMs]);

  const tags = useMemo(() => buildTags(values, metricKind), [values, metricKind]);

  const yTicks = useMemo(() => {
    const { vMax } = aligned;
    const n = 4;
    return Array.from({ length: n + 1 }, (_, i) => (vMax * i) / n);
  }, [aligned]);

  const xTickTimes = useMemo(() => {
    const { tMin, tMax, pts } = aligned;
    if (pts.length < 2) return pts.length ? [pts[0].t, pts[pts.length - 1].t] : [];
    const span = tMax - tMin;
    return [0, 0.25, 0.5, 0.75, 1].map((r) => tMin + r * span);
  }, [aligned]);

  const linePoints = useMemo(() => {
    return aligned.pts.map((p) => `${p.x},${p.y}`).join(" ");
  }, [aligned.pts]);

  const onMove = (e) => {
    if (!aligned.pts.length || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const xSvg = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < aligned.pts.length; i++) {
      const d = Math.abs(aligned.pts[i].x - xSvg);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover({ index: best, xSvg: aligned.pts[best].x, ySvg: aligned.pts[best].y });
  };

  const onLeave = () => setHover(null);

  if (!values.length) {
    return (
      <div className="chart-placeholder">
        <span>{label}</span>
        <p className="muted-small">Aguardando eventos…</p>
      </div>
    );
  }

  const hp = hover && aligned.pts[hover.index];
  const rel = hp ? formatRelativeToStart(hp.t, testWallStartMs) : null;

  return (
    <div className="chart-wrap chart-wrap-interactive" ref={wrapRef}>
      <div className="chart-header-row">
        <span className="chart-label">
          {label}
          {unit ? ` (${unit})` : ""}
        </span>
        {tags.length > 0 && (
          <div className="chart-tag-row" aria-label="Resumo do gráfico">
            {tags.map((t) => (
              <span key={t.key} className={`chart-tag chart-tag--${t.tone}`}>
                {t.text}
              </span>
            ))}
          </div>
        )}
      </div>
      <svg
        className="chart-svg chart-svg--interactive"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={onLeave}
        role="img"
        aria-label={label}
      >
        <defs>
          <linearGradient id={`g-${gradId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.2" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* grid Y */}
        {yTicks.map((yt, i) => {
          const y = padT + innerH * (1 - yt / (aligned.vMax || 1));
          return (
            <g key={i}>
              <line
                x1={padL}
                y1={y}
                x2={W - padR}
                y2={y}
                stroke="rgba(148,163,184,0.15)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
        {aligned.pts.length > 1 &&
          (() => {
            const b = padT + innerH;
            const first = aligned.pts[0];
            const last = aligned.pts[aligned.pts.length - 1];
            const top = linePoints;
            const area = `${top} ${last.x},${b} ${first.x},${b}`;
            return <polygon fill={`url(#g-${gradId})`} points={area} opacity={0.35} />;
          })()}
        <polyline fill="none" stroke={color} strokeWidth="2" points={linePoints} vectorEffect="non-scaling-stroke" />
        {/* X axis labels */}
        {xTickTimes.map((tx, i) => {
          const tSpan = aligned.tMax - aligned.tMin || 1;
          const x = padL + (innerW * (tx - aligned.tMin)) / tSpan;
          const short =
            testWallStartMs != null
              ? formatRelativeToStart(tx, testWallStartMs) || "0:00"
              : formatClock(tx).split(", ").pop() || "—";
          return (
            <text
              key={i}
              x={x}
              y={H - 4}
              fill="#94a3b8"
              fontSize="9"
              textAnchor="middle"
              style={{ userSelect: "none" }}
            >
              {short}
            </text>
          );
        })}
        {/* Y tick labels (left) */}
        {yTicks
          .filter((_, j) => j % 2 === 0)
          .map((yt) => {
            const y = padT + innerH * (1 - yt / (aligned.vMax || 1));
            const yLabel = aligned.vMax < 0.1 ? yt.toFixed(3) : yt < 10 ? yt.toFixed(1) : Math.round(yt);
            return (
              <text
                key={String(yt)}
                x={padL - 4}
                y={y + 3}
                fill="#94a3b8"
                fontSize="9"
                textAnchor="end"
                style={{ userSelect: "none" }}
              >
                {yLabel}
              </text>
            );
          })}
        {hover && hp && (
          <g>
            <line
              x1={hp.x}
              y1={padT}
              x2={hp.x}
              y2={padT + innerH}
              stroke="rgba(148,163,184,0.5)"
              strokeWidth="1"
              strokeDasharray="4 3"
            />
            <circle cx={hp.x} cy={hp.y} r="5" fill={color} stroke="#0f172a" strokeWidth="1" />
          </g>
        )}
      </svg>
      <p className="chart-axis-legend" aria-hidden="true">
        Eixo X: tempo (relógio e tempo no teste) · Eixo Y: {label}
        {unit ? ` (${unit})` : ""}
      </p>
      {hp && (
        <div
          className="chart-floating-tooltip"
          style={{
            left: `${(hp.x / W) * 100}%`,
            transform: "translateX(-50%)"
          }}
        >
          <div className="chart-tooltip-time">{formatClock(hp.t)}</div>
          {rel ? <div className="chart-tooltip-sub">no teste: {rel}</div> : null}
          <div className="chart-tooltip-val">
            {fmt(hp.v)} {unit && <span className="chart-tooltip-unit">· eixo Y ({unit})</span>}
          </div>
        </div>
      )}
    </div>
  );
}
