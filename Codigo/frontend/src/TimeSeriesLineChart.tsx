import { useCallback, useMemo, useState, useRef, useId } from "react";
import type { ChartMultiSeries } from "./types";

interface ChartPoint {
  x: number;
  y: number;
  v: number;
  t: number;
}

type HoverState =
  | {
      multi: true;
      items: { pt: ChartPoint; color: string; userId: string | number }[];
      xBar: number;
      t: number;
    }
  | { multi?: false; index: number; xSvg: number; ySvg: number }
  | null;

interface TimeSeriesLineChartProps {
  values?: number[];
  timeMs?: number[];
  label: string;
  color?: string;
  unit?: string;
  testWallStartMs?: number | null;
  metricKind?: string | null;
  formatValue?: (v: number) => string;
  unavailableMessage?: string;
  multiSeries?: ChartMultiSeries[] | null;
}

const KIND_HINTS: Record<string, { high?: number; veryHigh?: number; low?: number; veryLow?: number; unit?: string }> = {
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

interface ChartTag {
  key: string;
  text: string;
  tone: "ok" | "warn" | "bad";
}

function buildTags(values: number[], kind: string | null): ChartTag[] {
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
  const tags: ChartTag[] = [];
  if (kind === "rtt" || kind === "jitterVideo") {
    if (maxV >= (h.veryHigh ?? 99999)) {
      tags.push({ key: "vh", text: kind === "rtt" ? "RTT muito alto" : "Jitter muito alto", tone: "bad" });
    } else if (maxV >= (h.high ?? 99999)) {
      tags.push({ key: "h", text: kind === "rtt" ? "Alta latência (RTT)" : "Jitter acentuado", tone: "warn" });
    }
  }
  if (kind === "downlinkKbps" && maxV >= (h.veryHigh ?? 2000)) {
    tags.push({ key: "bw", text: "Pico de taxa recebida", tone: "ok" });
  }
  if (kind === "fpsIn" && minV < (h.veryLow ?? 0) && maxV > 0) {
    tags.push({ key: "fl", text: "FPS baixo nalguns momentos", tone: "warn" });
  }
  if (kind === "rps" && maxV >= (h.high ?? 99999)) {
    tags.push({ key: "burst", text: "Pico de requisições", tone: "warn" });
  }
  return tags.slice(0, 3);
}

const W = 460;
const H = 178;
const padL = 72;
const padR = 16;
const padT = 30;
const padB = 52;
const innerW = W - padL - padR;
const innerH = H - padT - padB;

/**
 * Série com eixo de tempo.
 * - Modo simples: `values` + `timeMs` (uma linha)
 * - Modo multi: `multiSeries` — array de `{ values, timeMs, color, userId }` (uma linha por utilizador)
 */
export default function TimeSeriesLineChart({
  values = [],
  timeMs = [],
  label,
  color = "#22c55e",
  unit = "",
  testWallStartMs = null,
  metricKind = null,
  formatValue: formatValueProp,
  unavailableMessage = "",
  multiSeries = null
}: TimeSeriesLineChartProps) {
  const fmt = useCallback(
    (v: number) => (formatValueProp ? formatValueProp(v) : defaultFormatValue(v, unit)),
    [formatValueProp, unit]
  );

  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverState>(null);
  const gradId = useId().replace(/:/g, "");

  // ── Multi-series aligned data ────────────────────────────────────────────
  const activeSeries = useMemo(() => {
    if (!multiSeries || !multiSeries.length) return null;
    return multiSeries.filter((s) => s.values && s.values.length > 0);
  }, [multiSeries]);

  const isMulti = activeSeries && activeSeries.length > 0;

  const alignedMulti = useMemo(() => {
    if (!activeSeries || !activeSeries.length) return null;
    let tGMin = Infinity, tGMax = -Infinity, vGMax = 1e-9;
    for (const s of activeSeries) {
      const n = s.values.length;
      const tms = s.timeMs && s.timeMs.length === n ? s.timeMs : s.values.map((_, i) => i);
      for (const t of tms) { if (Number.isFinite(t)) { tGMin = Math.min(tGMin, t); tGMax = Math.max(tGMax, t); } }
      for (const v of s.values) { if (Number.isFinite(v) && v > vGMax) vGMax = v; }
    }
    if (!Number.isFinite(tGMin)) tGMin = 0;
    if (!Number.isFinite(tGMax) || tGMax <= tGMin) tGMax = tGMin + 1;
    const tSpan = tGMax - tGMin;
    const perS = activeSeries.map((s) => {
      const n = s.values.length;
      const tms = s.timeMs && s.timeMs.length === n ? s.timeMs : s.values.map((_, i) => i);
      const tNum = tms.map((t) => (Number.isFinite(t) ? t : tGMin));
      const pts = s.values.map((v, i) => ({
        x: padL + (innerW * (tNum[i] - tGMin)) / tSpan,
        y: padT + innerH * (1 - Math.max(v, 0) / vGMax),
        v,
        t: tNum[i]
      }));
      return { ...s, pts };
    });
    return { perS, tMin: tGMin, tMax: tGMax, vMax: vGMax };
  }, [activeSeries]);

  // ── Single-series aligned data (unchanged) ───────────────────────────────
  const aligned = useMemo(() => {
    const n = values.length;
    if (n === 0) return { pts: [], tMin: 0, tMax: 1, vMin: 0, vMax: 1 };
    const tms =
      timeMs && timeMs.length === n ? timeMs : values.map((_, i) => i);
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

  // ── Derived display state ─────────────────────────────────────────────────
  const allValuesForTags = useMemo(() => {
    if (isMulti && activeSeries) return activeSeries.flatMap((s) => s.values);
    return values;
  }, [isMulti, activeSeries, values]);

  const tags = useMemo(() => buildTags(allValuesForTags, metricKind), [allValuesForTags, metricKind]);

  const { tMin: uTMin, tMax: uTMax, vMax: uVMax } = isMulti && alignedMulti
    ? { tMin: alignedMulti.tMin, tMax: alignedMulti.tMax, vMax: alignedMulti.vMax }
    : aligned;

  const yTicks = useMemo(() => {
    const n = 4;
    return Array.from({ length: n + 1 }, (_, i) => (uVMax * i) / n);
  }, [uVMax]);

  const xTickTimes = useMemo(() => {
    if (isMulti && alignedMulti) {
      const span = alignedMulti.tMax - alignedMulti.tMin;
      return [0, 0.25, 0.5, 0.75, 1].map((r) => alignedMulti.tMin + r * span);
    }
    const { tMin, tMax, pts } = aligned;
    if (pts.length < 2) return pts.length ? [pts[0].t, pts[pts.length - 1].t] : [];
    const span = tMax - tMin;
    return [0, 0.25, 0.5, 0.75, 1].map((r) => tMin + r * span);
  }, [isMulti, alignedMulti, aligned]);

  const linePoints = useMemo(() => {
    return aligned.pts.map((p) => `${p.x},${p.y}`).join(" ");
  }, [aligned.pts]);

  // ── Hover handlers ────────────────────────────────────────────────────────
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const xSvg = ((e.clientX - rect.left) / rect.width) * W;

    if (isMulti && alignedMulti) {
      const { tMin, tMax, perS } = alignedMulti;
      const tSpan = tMax - tMin || 1;
      const hoverT = tMin + ((xSvg - padL) / innerW) * tSpan;
      const items = perS
        .map((s) => {
          if (!s.pts.length) return null;
          let best = 0, bestDt = Infinity;
          for (let i = 0; i < s.pts.length; i++) {
            const dt = Math.abs(s.pts[i].t - hoverT);
            if (dt < bestDt) { bestDt = dt; best = i; }
          }
          return { pt: s.pts[best], color: s.color, userId: s.userId };
        })
        .filter((it): it is { pt: ChartPoint; color: string; userId: string | number } => it != null);
      if (items.length) setHover({ multi: true, items, xBar: items[0].pt.x, t: items[0].pt.t });
    } else if (aligned.pts.length) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < aligned.pts.length; i++) {
        const d = Math.abs(aligned.pts[i].x - xSvg);
        if (d < bestD) { bestD = d; best = i; }
      }
      setHover({ index: best, xSvg: aligned.pts[best].x, ySvg: aligned.pts[best].y });
    }
  };

  const onLeave = () => setHover(null);

  // ── Empty state ───────────────────────────────────────────────────────────
  const hasData = isMulti ? true : values.length > 0;
  if (unavailableMessage || !hasData) {
    return (
      <div className={`chart-placeholder ${unavailableMessage ? "chart-placeholder--unavailable" : ""}`}>
        <span>{label}</span>
        <p className="muted-small">{unavailableMessage || "Aguardando eventos…"}</p>
      </div>
    );
  }

  // ── Single-series hover refs ──────────────────────────────────────────────
  const hp = !hover?.multi && hover && aligned.pts[hover.index];
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
          const y = padT + innerH * (1 - yt / (uVMax || 1));
          return (
            <line
              key={i}
              x1={padL} y1={y} x2={W - padR} y2={y}
              stroke="rgba(148,163,184,0.15)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}

        {/* ── Single-series rendering ── */}
        {!isMulti && aligned.pts.length > 1 && (() => {
          const b = padT + innerH;
          const first = aligned.pts[0];
          const last = aligned.pts[aligned.pts.length - 1];
          const area = `${linePoints} ${last.x},${b} ${first.x},${b}`;
          return <polygon fill={`url(#g-${gradId})`} points={area} opacity={0.35} />;
        })()}
        {!isMulti && (
          <polyline fill="none" stroke={color} strokeWidth="2" points={linePoints} vectorEffect="non-scaling-stroke" />
        )}

        {/* ── Multi-series rendering ── */}
        {isMulti && alignedMulti && alignedMulti.perS.map((s) => (
          s.pts.length > 1 ? (
            <polyline
              key={s.userId}
              fill="none"
              stroke={s.color}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={s.pts.map((p) => `${p.x},${p.y}`).join(" ")}
              vectorEffect="non-scaling-stroke"
            />
          ) : s.pts.length === 1 ? (
            <circle key={s.userId} cx={s.pts[0].x} cy={s.pts[0].y} r="3" fill={s.color} />
          ) : null
        ))}

        {/* X axis labels */}
        {xTickTimes.map((tx, i) => {
          const tSpan = uTMax - uTMin || 1;
          const x = padL + (innerW * (tx - uTMin)) / tSpan;
          const short =
            testWallStartMs != null
              ? formatRelativeToStart(tx, testWallStartMs) || "0:00"
              : formatClock(tx).split(", ").pop() || "—";
          return (
            <text key={i} x={x} y={H - 28} fill="#94a3b8" fontSize="11" textAnchor="middle" style={{ userSelect: "none" }}>
              {short}
            </text>
          );
        })}

        <text x={padL + innerW / 2} y={H - 8} fill="#cbd5e1" fontSize="12" fontWeight="600" textAnchor="middle" style={{ userSelect: "none" }}>
          Tempo (relógio e tempo no teste)
        </text>
        <text x={18} y={padT + innerH / 2} fill="#cbd5e1" fontSize="12" fontWeight="600" textAnchor="middle"
          transform={`rotate(-90 18 ${padT + innerH / 2})`} style={{ userSelect: "none" }}>
          {`${label}${unit ? ` (${unit})` : ""}`}
        </text>

        {/* Y tick labels */}
        {yTicks.filter((_, j) => j % 2 === 0).map((yt) => {
          const y = padT + innerH * (1 - yt / (uVMax || 1));
          const yLabel = uVMax < 0.1 ? yt.toFixed(3) : yt < 10 ? yt.toFixed(1) : Math.round(yt);
          return (
            <text key={String(yt)} x={padL - 4} y={y + 3} fill="#94a3b8" fontSize="11" textAnchor="end" style={{ userSelect: "none" }}>
              {yLabel}
            </text>
          );
        })}

        {/* Hover crosshair — single */}
        {!hover?.multi && hover && hp && (
          <g>
            <line x1={hp.x} y1={padT} x2={hp.x} y2={padT + innerH} stroke="rgba(148,163,184,0.5)" strokeWidth="1" strokeDasharray="4 3" />
            <circle cx={hp.x} cy={hp.y} r="5" fill={color} stroke="#0f172a" strokeWidth="1" />
          </g>
        )}

        {/* Hover crosshair — multi */}
        {hover?.multi && (
          <g>
            <line x1={hover.xBar} y1={padT} x2={hover.xBar} y2={padT + innerH} stroke="rgba(148,163,184,0.5)" strokeWidth="1" strokeDasharray="4 3" />
            {hover.items.map((it) => (
              <circle key={it.userId} cx={it.pt.x} cy={it.pt.y} r="4" fill={it.color} stroke="#0f172a" strokeWidth="1.5" />
            ))}
          </g>
        )}
      </svg>

      {/* Tooltip — single */}
      {!hover?.multi && hp && (
        <div className="chart-floating-tooltip" style={{ left: `${(hp.x / W) * 100}%`, transform: "translateX(-50%)" }}>
          <div className="chart-tooltip-time">{formatClock(hp.t)}</div>
          {rel ? <div className="chart-tooltip-sub">no teste: {rel}</div> : null}
          <div className="chart-tooltip-val">
            {fmt(hp.v)} {unit && <span className="chart-tooltip-unit">· eixo Y ({unit})</span>}
          </div>
        </div>
      )}

      {/* Tooltip — multi */}
      {hover?.multi && (
        <div className="chart-floating-tooltip chart-floating-tooltip--multi" style={{ left: `${(hover.xBar / W) * 100}%`, transform: "translateX(-50%)" }}>
          <div className="chart-tooltip-time">{formatClock(hover.t)}</div>
          {formatRelativeToStart(hover.t, testWallStartMs) && (
            <div className="chart-tooltip-sub">no teste: {formatRelativeToStart(hover.t, testWallStartMs)}</div>
          )}
          {hover.items.map((it) => (
            <div key={it.userId} className="chart-tooltip-user-row">
              <span className="chart-tooltip-user-dot" style={{ background: it.color }} />
              <span className="chart-tooltip-user-label">U{it.userId}</span>
              <span className="chart-tooltip-val-inline">{fmt(it.pt.v)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Legend — multi */}
      {isMulti && activeSeries && activeSeries.length > 1 && (
        <div className="chart-legend">
          {activeSeries.map((s) => (
            <span key={s.userId} className="chart-legend-item">
              <span className="chart-legend-dot" style={{ background: s.color }} />
              <span className="chart-legend-label">Usuário {s.userId}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
