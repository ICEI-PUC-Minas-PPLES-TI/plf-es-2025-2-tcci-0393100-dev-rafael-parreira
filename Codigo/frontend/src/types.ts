// Tipos compartilhados do frontend do Stream Sentry.
// Rigor pragmático: as formas públicas (props, retorno do hook, respostas de
// API) são tipadas; estruturas dinâmicas de telemetria WebRTC usam tipos
// parciais com assinaturas de índice para acomodar os campos do getStats().

// ── Autenticação / API ──────────────────────────────────────────────────────
export interface AuthUser {
  id: number;
  name: string;
  email: string;
}

export interface ApiError extends Error {
  unauthorized?: boolean;
}

export type Feedback = "" | "success" | "error";

// ── Configuração do teste ───────────────────────────────────────────────────
export interface ConfigForm {
  apiUrl: string;
  accessToken: string;
  virtualUsers: number;
  callDurationSec: number;
}

export interface ValidatedConfig {
  apiUrl: string;
  accessToken: string;
  virtualUsers: number;
  callDurationSec: number;
}

// ── Telemetria WebRTC ───────────────────────────────────────────────────────
export interface RtcStream {
  packetsReceived?: number;
  packetsLost?: number;
  bytesReceived?: number;
  bytesSent?: number;
  packetsSent?: number;
  framesDecoded?: number;
  framesEncoded?: number;
  framesPerSecond?: number;
  jitter?: number;
  frameWidth?: number;
  frameHeight?: number;
  [key: string]: unknown;
}

export interface WebRtcSummary {
  peerConnections?: number;
  inboundVideo?: RtcStream;
  inboundAudio?: RtcStream;
  outboundVideo?: RtcStream;
  outboundAudio?: RtcStream;
  candidatePair?: { currentRoundTripTimeMs?: number; availableOutgoingBitrate?: number; [k: string]: unknown };
  remoteInbound?: { videoRoundTripTimeMs?: number; audioRoundTripTimeMs?: number; [k: string]: unknown };
  transport?: { bytesReceived?: number; bytesSent?: number; [k: string]: unknown };
  resolution?: string | null;
  statsDebug?: { types?: Record<string, number>; videoElements?: unknown[]; [k: string]: unknown };
  _done?: boolean;
  [key: string]: unknown;
}

export interface WebRtcAggregate {
  usersWithRtc: number;
  peerConnections: number;
  roundTripTimeMs: number | null;
  jitterVideo: number | null;
  jitterAudio: number | null;
  packetsLostTotal: number;
  packetsReceivedTotal: number;
  framesDecoded: number;
  framesEncoded: number;
  inboundBytes: number;
  outboundBytes: number;
  fpsIn: number | null;
  fpsOut: number | null;
  resolution: string | null;
  availableOutgoingBitrate: number | null;
}

export type WebRtcMetricKey = "rttMs" | "jitterVideo" | "downlinkKbps" | "fpsIn";

export type WebRtcSeries = Record<WebRtcMetricKey, number[]>;

export interface SeriesTimeMs {
  cumulative: number[];
  rps: number[];
  elapsed: number[];
  webrtc: Partial<WebRtcSeries>;
}

export interface PerUserSeries {
  rttMs: number[];
  jitterVideo: number[];
  downlinkKbps: number[];
  fpsIn: number[];
  timeMs: number[];
}

export interface FeedItem {
  kind: "req" | "fail" | "info";
  text: string;
  ts?: string;
}

// Evento de telemetria recebido via WebSocket / NDJSON. Dinâmico por natureza.
export interface TelemetryEvent {
  type?: string;
  event?: string;
  ts?: string;
  sessionId?: string;
  userId?: string | number;
  elapsedSec?: number;
  summary?: WebRtcSummary;
  [key: string]: unknown;
}

// ── Visão de telemetria consumida pelo AuditDashboard ───────────────────────
// Tanto o hook ao vivo quanto o snapshot histórico produzem esta forma.
export interface TelemetryView {
  connected: boolean;
  lastEvent: string;
  requestTotal: number;
  responseTotal: number;
  failTotal: number;
  cumulativeSeries: number[];
  rpsSeries: number[];
  statusCounts: Record<string, number>;
  feed: FeedItem[];
  webrtcAggregate: WebRtcAggregate;
  webrtcSeries: WebRtcSeries;
  webrtcPerUserSeries?: Record<string, PerUserSeries>;
  webrtcLastByUser: Record<string, WebRtcSummary>;
  testElapsedSec: number | null;
  elapsedSeries?: number[];
  activeSessionId: string;
  seriesTimeMs: SeriesTimeMs;
  testWallStartMs: number | null;
  joinedUserCount?: number;
  activeStatsUserCount?: number;
  targetVirtualUsers?: number | null;
  callStartedAtMs?: number | null;
}

export interface TelemetryWSOptions {
  onTestRunFinished?: () => void;
  onSessionInvalid?: () => void;
}

// ── Histórico ───────────────────────────────────────────────────────────────
export interface TestHistorySummary {
  http?: { requests?: number };
  webrtc?: { rttMs?: { avg?: number }; statsSamples?: number };
  [key: string]: unknown;
}

export interface TestHistoryRecord {
  id: string;
  startedAt?: string;
  durationSec?: number;
  chaosProfile?: string;
  exitOk?: boolean;
  summary?: TestHistorySummary;
  [key: string]: unknown;
}

export interface HistoricalAudit {
  session?: { id?: string; chaosProfile?: string; [k: string]: unknown };
  snapshot: TelemetryView;
}

// ── Gráfico de séries temporais ─────────────────────────────────────────────
export interface ChartMultiSeries {
  values: number[];
  timeMs: number[];
  color: string;
  userId: string | number;
}
