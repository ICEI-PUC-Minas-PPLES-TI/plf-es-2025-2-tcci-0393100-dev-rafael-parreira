import { useEffect, useRef, useState } from "react";

/** @typedef {{ onTestRunFinished?: () => void; onSessionInvalid?: () => void }} TelemetryWSOptions */

function buildWsUrl(apiBaseUrl, token) {
  const base = apiBaseUrl.replace(/^http/, "ws").replace(/\/$/, "");
  return `${base}/ws/telemetry?token=${encodeURIComponent(token)}`;
}

function avg(nums) {
  const n = nums.filter((x) => x != null && Number.isFinite(x));
  if (!n.length) return null;
  return n.reduce((a, b) => a + b, 0) / n.length;
}

/**
 * Sinal de WebRTC além de peerConnections (útil quando o hook no Chromium não
 * contou PCs mas getStats ainda traz tráfego).
 */
export function summaryHasWebrtcActivity(s) {
  if (!s) return false;
  if ((s.peerConnections || 0) > 0) return true;
  const iv = s.inboundVideo;
  const ia = s.inboundAudio;
  const ov = s.outboundVideo;
  const oa = s.outboundAudio;
  if ((iv?.packetsReceived || 0) > 0 || (iv?.bytesReceived || 0) > 0 || (iv?.framesDecoded || 0) > 0) return true;
  if ((ia?.packetsReceived || 0) > 0 || (ia?.bytesReceived || 0) > 0) return true;
  if ((ov?.bytesSent || 0) > 0 || (ov?.framesEncoded || 0) > 0) return true;
  if ((oa?.packetsSent || 0) > 0) return true;
  if (s.candidatePair?.currentRoundTripTimeMs != null && Number.isFinite(s.candidatePair.currentRoundTripTimeMs))
    return true;
  if ((s.transport?.bytesReceived || 0) > 0 || (s.transport?.bytesSent || 0) > 0) return true;
  if (
    s.remoteInbound?.videoRoundTripTimeMs != null ||
    s.remoteInbound?.audioRoundTripTimeMs != null
  ) {
    return true;
  }
  return false;
}

function totalRtcpBytesIn(s) {
  if (!s) return 0;
  const rtpBytes = (s.inboundVideo?.bytesReceived || 0) + (s.inboundAudio?.bytesReceived || 0);
  return rtpBytes > 0 ? rtpBytes : s.transport?.bytesReceived || 0;
}

/**
 * Não deixar um getStats "morno" (sem tráfego ainda) substituir a última leitura
 * com métricas na tabela por utilizador.
 */
function pickWebrtcSummaryForDisplay(prev, next) {
  if (!next) return prev;
  if (!prev) return next;
  if (summaryHasWebrtcActivity(next)) return next;
  if (summaryHasWebrtcActivity(prev)) return prev;
  return next;
}

function rttFromSummary(s) {
  return (
    s.candidatePair?.currentRoundTripTimeMs ??
    s.remoteInbound?.videoRoundTripTimeMs ??
    s.remoteInbound?.audioRoundTripTimeMs
  );
}

/** Média entre utilizadores com atividade — gráficos refletem o teste, não só o último evento. */
function seriesAveragesFromLastByUser(map) {
  const rows = Object.values(map).filter((s) => s && summaryHasWebrtcActivity(s));
  if (!rows.length) return { rtt: null, jitterVideoMs: null, fps: null };
  const rtts = rows.map((r) => rttFromSummary(r)).filter((x) => x != null && Number.isFinite(x));
  const jvs = rows
    .map((r) => r.inboundVideo?.jitter)
    .filter((x) => x != null && Number.isFinite(x))
    .map((j) => j * 1000);
  const fss = rows.map((r) => r.inboundVideo?.framesPerSecond).filter((x) => x != null && Number.isFinite(x));
  return {
    rtt: rtts.length ? avg(rtts) : null,
    jitterVideoMs: jvs.length ? avg(jvs) : null,
    fps: fss.length ? avg(fss) : null
  };
}

function aggregateWebRTC(lastByUser) {
  const rows = Object.values(lastByUser).filter((s) => s && summaryHasWebrtcActivity(s));
  if (!rows.length) {
    return {
      usersWithRtc: 0,
      peerConnections: 0,
      roundTripTimeMs: null,
      jitterVideo: null,
      jitterAudio: null,
      packetsLostTotal: 0,
      packetsReceivedTotal: 0,
      framesDecoded: 0,
      framesEncoded: 0,
      inboundBytes: 0,
      outboundBytes: 0,
      fpsIn: null,
      fpsOut: null,
      resolution: null,
      availableOutgoingBitrate: null
    };
  }

  const cand = avg(rows.map((r) => r.candidatePair?.currentRoundTripTimeMs).filter(Number.isFinite));
  const rv = avg(rows.map((r) => r.remoteInbound?.videoRoundTripTimeMs).filter(Number.isFinite));
  const ra = avg(rows.map((r) => r.remoteInbound?.audioRoundTripTimeMs).filter(Number.isFinite));
  const rtt = cand ?? rv ?? ra;

  const jv = rows.map((r) => r.inboundVideo?.jitter).filter((x) => x != null && Number.isFinite(x));
  const ja = rows.map((r) => r.inboundAudio?.jitter).filter((x) => x != null && Number.isFinite(x));

  let pl = 0;
  let pr = 0;
  let fd = 0;
  let fe = 0;
  let bin = 0;
  let bout = 0;
  let pc = 0;
  let res = null;
  let aob = null;
  let fpsIn = null;
  let fpsOut = null;

  for (const r of rows) {
    pc += r.peerConnections || 0;
    pl += (r.inboundVideo?.packetsLost || 0) + (r.inboundAudio?.packetsLost || 0);
    pr += (r.inboundVideo?.packetsReceived || 0) + (r.inboundAudio?.packetsReceived || 0);
    fd += r.inboundVideo?.framesDecoded || 0;
    fe += r.outboundVideo?.framesEncoded || 0;
    const inboundRtpBytes = (r.inboundVideo?.bytesReceived || 0) + (r.inboundAudio?.bytesReceived || 0);
    const outboundRtpBytes = (r.outboundVideo?.bytesSent || 0) + (r.outboundAudio?.bytesSent || 0);
    bin += inboundRtpBytes > 0 ? inboundRtpBytes : r.transport?.bytesReceived || 0;
    bout += outboundRtpBytes > 0 ? outboundRtpBytes : r.transport?.bytesSent || 0;
    if (r.inboundVideo?.frameWidth && r.inboundVideo?.frameHeight) {
      res = `${r.inboundVideo.frameWidth}×${r.inboundVideo.frameHeight}`;
    }
    if (r.candidatePair?.availableOutgoingBitrate != null) aob = r.candidatePair.availableOutgoingBitrate;
    if (r.inboundVideo?.framesPerSecond != null) fpsIn = r.inboundVideo.framesPerSecond;
    if (r.outboundVideo?.framesPerSecond != null) fpsOut = r.outboundVideo.framesPerSecond;
  }

  return {
    usersWithRtc: rows.length,
    peerConnections: pc,
    roundTripTimeMs: rtt,
    jitterVideo: jv.length ? avg(jv) : null,
    jitterAudio: ja.length ? avg(ja) : null,
    packetsLostTotal: pl,
    packetsReceivedTotal: pr,
    framesDecoded: fd,
    framesEncoded: fe,
    inboundBytes: bin,
    outboundBytes: bout,
    fpsIn,
    fpsOut,
    resolution: res,
    availableOutgoingBitrate: aob
  };
}

function timestampFromEvent(data) {
  const parsed = Date.parse(data?.ts || "");
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function emptyTelemetrySnapshot() {
  return {
    connected: false,
    lastEvent: "",
    requestTotal: 0,
    responseTotal: 0,
    failTotal: 0,
    cumulativeSeries: [],
    rpsSeries: [],
    statusCounts: {},
    feed: [],
    webrtcAggregate: aggregateWebRTC({}),
    webrtcSeries: { rttMs: [], jitterVideo: [], downlinkKbps: [], fpsIn: [] },
    webrtcLastByUser: {},
    testElapsedSec: null,
    activeSessionId: "",
    seriesTimeMs: {
      cumulative: [],
      rps: [],
      elapsed: [],
      webrtc: { rttMs: [], jitterVideo: [], downlinkKbps: [], fpsIn: [] }
    },
    testWallStartMs: null
  };
}

export function buildTelemetrySnapshotFromEvents(events = [], session = {}) {
  const snapshot = emptyTelemetrySnapshot();
  const totals = { req: 0, res: 0, fail: 0 };
  const statusMap = {};
  const feed = [];
  const lastByUser = {};
  const webrtcSeries = { rttMs: [], jitterVideo: [], downlinkKbps: [], fpsIn: [] };
  const webrtcTimeMs = { rttMs: [], jitterVideo: [], downlinkKbps: [], fpsIn: [] };
  const cumulativeSeries = [];
  const cumulativeTimeMs = [];
  const rpsBuckets = new Map();
  let bytesTotal = { ts: 0, sumBytes: 0 };
  let testWallStartMs = Date.parse(session?.startedAt || "");
  if (Number.isNaN(testWallStartMs)) testWallStartMs = null;

  const pushLimited = (arr, value, cap) => {
    arr.push(value);
    if (arr.length > cap) arr.shift();
  };

  const prependFeed = (item) => {
    feed.unshift(item);
    if (feed.length > 40) feed.pop();
  };

  const appendWebrtcSample = (sampleMs) => {
    let sumB = 0;
    for (const s of Object.values(lastByUser)) {
      if (s) sumB += totalRtcpBytesIn(s);
    }
    let downKbps = 0;
    if (bytesTotal.ts && sampleMs > bytesTotal.ts && sumB >= bytesTotal.sumBytes) {
      const dt = (sampleMs - bytesTotal.ts) / 1000;
      downKbps = ((sumB - bytesTotal.sumBytes) * 8) / 1000 / Math.max(dt, 0.001);
    }
    bytesTotal = { ts: sampleMs, sumBytes: sumB };
    const hasRtcSample = Object.values(lastByUser).some((s) => s && summaryHasWebrtcActivity(s));
    if (!hasRtcSample && downKbps <= 0.75) return;

    const averages = seriesAveragesFromLastByUser(lastByUser);
    const cap = 60;
    const pushMetric = (key, value) => {
      pushLimited(webrtcSeries[key], value != null && Number.isFinite(value) ? value : 0, cap);
      pushLimited(webrtcTimeMs[key], sampleMs, cap);
    };
    pushMetric("rttMs", averages.rtt);
    pushMetric("jitterVideo", averages.jitterVideoMs);
    pushMetric("downlinkKbps", downKbps);
    pushMetric("fpsIn", averages.fps);
  };

  for (const raw of events || []) {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!data || data.type !== "telemetry") continue;
    const ts = timestampFromEvent(data);
    snapshot.lastEvent = data.event || snapshot.lastEvent;
    if (data.sessionId) snapshot.activeSessionId = String(data.sessionId);

    if (data.event === "test_start") {
      const startedAtMs = Date.parse(data.startedAtISO || "");
      if (!Number.isNaN(startedAtMs)) testWallStartMs = startedAtMs;
      if (data.elapsedSec != null && Number.isFinite(Number(data.elapsedSec))) {
        snapshot.testElapsedSec = Number(data.elapsedSec);
      }
      continue;
    }

    if (data.elapsedSec != null && Number.isFinite(Number(data.elapsedSec))) {
      snapshot.testElapsedSec = Number(data.elapsedSec);
    }

    if (data.event === "request") {
      totals.req += 1;
      pushLimited(cumulativeSeries, totals.req, 100);
      pushLimited(cumulativeTimeMs, ts, 100);
      const sec = Math.floor(ts / 1000) * 1000;
      rpsBuckets.set(sec, (rpsBuckets.get(sec) || 0) + 1);
      prependFeed({ kind: "req", text: `${data.method} ${(data.url || "").slice(0, 72)}`, ts: data.ts });
    } else if (data.event === "response") {
      totals.res += 1;
      const st = String(data.status ?? "?");
      statusMap[st] = (statusMap[st] || 0) + 1;
    } else if (data.event === "request_failed") {
      totals.fail += 1;
      prependFeed({ kind: "fail", text: data.errorText || "fail", ts: data.ts });
    } else if (data.event === "webrtc_stats" && data.summary) {
      const uid = String(data.userId ?? "");
      lastByUser[uid] = pickWebrtcSummaryForDisplay(lastByUser[uid], data.summary);
      appendWebrtcSample(ts);
    } else if (data.event === "chaos_profile_changed" && data.profile != null) {
      prependFeed({ kind: "info", text: `Chaos de rede: perfil «${data.profile}»`, ts: data.ts });
    } else if (data.event === "test_stopped" || data.event === "test_complete" || data.event === "server_audit_summary") {
      if (data.message) prependFeed({ kind: "info", text: String(data.message), ts: data.ts });
    }
  }

  const sortedBuckets = [...rpsBuckets.entries()].sort((a, b) => a[0] - b[0]).slice(-80);
  snapshot.requestTotal = totals.req;
  snapshot.responseTotal = totals.res;
  snapshot.failTotal = totals.fail;
  snapshot.cumulativeSeries = cumulativeSeries;
  snapshot.rpsSeries = sortedBuckets.map(([, count]) => count);
  snapshot.statusCounts = statusMap;
  snapshot.feed = feed;
  snapshot.webrtcLastByUser = lastByUser;
  snapshot.webrtcAggregate = aggregateWebRTC(lastByUser);
  snapshot.webrtcSeries = webrtcSeries;
  snapshot.seriesTimeMs = {
    cumulative: cumulativeTimeMs,
    rps: sortedBuckets.map(([ts]) => ts),
    elapsed: [],
    webrtc: webrtcTimeMs
  };
  snapshot.testWallStartMs = testWallStartMs;
  if (!snapshot.activeSessionId && session?.id) snapshot.activeSessionId = session.id;
  if (snapshot.testElapsedSec == null && session?.durationSec != null) snapshot.testElapsedSec = Number(session.durationSec);
  snapshot.lastEvent = snapshot.lastEvent || "server_audit_summary";
  return snapshot;
}

export function useTelemetryWS(apiBaseUrl, token, enabled, options) {
  const onTestRunFinishedRef = useRef(options?.onTestRunFinished);
  onTestRunFinishedRef.current = options?.onTestRunFinished;
  const onSessionInvalidRef = useRef(options?.onSessionInvalid);
  onSessionInvalidRef.current = options?.onSessionInvalid;

  const [connected, setConnected] = useState(false);
  const [requestTotal, setRequestTotal] = useState(0);
  const [responseTotal, setResponseTotal] = useState(0);
  const [failTotal, setFailTotal] = useState(0);
  const [cumulativeSeries, setCumulativeSeries] = useState([]);
  const [rpsSeries, setRpsSeries] = useState([]);
  const [statusCounts, setStatusCounts] = useState({});
  const [feed, setFeed] = useState([]);
  const [lastEvent, setLastEvent] = useState("");
  const secondBucketRef = useRef({ second: 0, count: 0 });
  const rpsHistoryRef = useRef([]);
  const rpsHistoryTimeRef = useRef([]);
  const lastByUserRef = useRef({});
  /** Soma de bytes (todos os VU) + timestamp — taxa recebida coerente com vários browser. */
  const webrtcBytesTotalRef = useRef({ ts: 0, sumBytes: 0 });
  const webrtcFramesByUserRef = useRef({});
  /** Séries por utilizador virtual: { [uid]: { rttMs, jitterVideo, downlinkKbps, fpsIn, timeMs } } */
  const webrtcPerUserSeriesRef = useRef({});
  /** Bytes anteriores por utilizador para calcular downlink individual. */
  const prevBytesPerUserRef = useRef({});

  const [webrtcAggregate, setWebrtcAggregate] = useState(() => aggregateWebRTC({}));
  const [webrtcSeries, setWebrtcSeries] = useState({
    rttMs: [],
    jitterVideo: [],
    downlinkKbps: [],
    fpsIn: []
  });
  const [webrtcLastByUser, setWebrtcLastByUser] = useState({});
  const [webrtcPerUserSeries, setWebrtcPerUserSeries] = useState({});
  const [testElapsedSec, setTestElapsedSec] = useState(null);
  const [elapsedSeries, setElapsedSeries] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [seriesTimeMs, setSeriesTimeMs] = useState({
    cumulative: [],
    rps: [],
    elapsed: [],
    webrtc: { rttMs: [], jitterVideo: [], downlinkKbps: [], fpsIn: [] }
  });
  const [testWallStartMs, setTestWallStartMs] = useState(null);
  const [joinedUserCount, setJoinedUserCount] = useState(0);
  const [activeStatsUserCount, setActiveStatsUserCount] = useState(0);
  const [targetVirtualUsers, setTargetVirtualUsers] = useState(null);
  const [callStartedAtMs, setCallStartedAtMs] = useState(null);

  const totalsRef = useRef({ req: 0, res: 0, fail: 0 });
  const cumulativeListRef = useRef([]);
  const cumulativeTimeMsRef = useRef([]);
  const statusMapRef = useRef({});
  const feedListRef = useRef([]);
  const lastEventRef = useRef("");
  const sessionIdRef = useRef("");
  const elapsedValueRef = useRef(null);
  const elapsedListRef = useRef([]);
  const elapsedTimeMsRef = useRef([]);
  const lastElapsedUiAtRef = useRef(0);
  const webrtcSeriesRef = useRef({ rttMs: [], jitterVideo: [], downlinkKbps: [], fpsIn: [] });
  const webrtcTimeMsRef = useRef({ rttMs: [], jitterVideo: [], downlinkKbps: [], fpsIn: [] });
  /** Usuários que já entraram na chamada (evento user_joined) — usado para só iniciar a
   *  contagem da "duração da chamada" quando todos os VUs tiverem entrado. */
  const joinedUserIdsRef = useRef(new Set());
  /** Usuários cujas métricas WebRTC já estão ativas (alimentando os gráficos). */
  const activeStatsUserIdsRef = useRef(new Set());
  const targetVirtualUsersRef = useRef(null);
  const callStartedAtRef = useRef(null);

  useEffect(() => {
    if (!enabled || !token) {
      setConnected(false);
      return undefined;
    }

    const ac = new AbortController();
    let ws;
    /** ~5 updates/s UI; carga pesada (séries, acumulado) fica no flush, não no onmessage. */
    const FLUSH_MS = 200;
    const ELAPSED_UI_MIN_MS = 500;
    const REQUEST_FEED_MIN_MS = 100;
    const CUMULATIVE_MAX = 100;

    const webrtcDirtyRef = { current: false };
    const lastRequestFeedAtRef = { current: 0 };
    const lastWebrtcStatsNoteAtRef = { current: 0 };
    /** Duração suave: relógio local + resync a partir de `elapsedSec` do runner. */
    const clientElapsedRef = { current: { active: false, wallMs: 0, baseSec: 0 } };

    const resetMetrics = () => {
      clientElapsedRef.current = { active: false, wallMs: 0, baseSec: 0 };
      webrtcDirtyRef.current = false;
      lastRequestFeedAtRef.current = 0;
      lastWebrtcStatsNoteAtRef.current = 0;
      totalsRef.current = { req: 0, res: 0, fail: 0 };
      cumulativeListRef.current = [];
      statusMapRef.current = {};
      feedListRef.current = [];
      lastEventRef.current = "";
      sessionIdRef.current = "";
      elapsedValueRef.current = null;
      elapsedListRef.current = [];
      elapsedTimeMsRef.current = [];
      lastElapsedUiAtRef.current = 0;
      secondBucketRef.current = { second: 0, count: 0 };
      rpsHistoryRef.current = [];
      rpsHistoryTimeRef.current = [];
      lastByUserRef.current = {};
      webrtcBytesTotalRef.current = { ts: 0, sumBytes: 0 };
      webrtcFramesByUserRef.current = {};
      webrtcSeriesRef.current = { rttMs: [], jitterVideo: [], downlinkKbps: [], fpsIn: [] };
      webrtcTimeMsRef.current = { rttMs: [], jitterVideo: [], downlinkKbps: [], fpsIn: [] };
      webrtcPerUserSeriesRef.current = {};
      prevBytesPerUserRef.current = {};
      cumulativeTimeMsRef.current = [];
      joinedUserIdsRef.current = new Set();
      activeStatsUserIdsRef.current = new Set();
      targetVirtualUsersRef.current = null;
      callStartedAtRef.current = null;
      setJoinedUserCount(0);
      setActiveStatsUserCount(0);
      setTargetVirtualUsers(null);
      setCallStartedAtMs(null);
      setRequestTotal(0);
      setResponseTotal(0);
      setFailTotal(0);
      setCumulativeSeries([]);
      setRpsSeries([]);
      setStatusCounts({});
      setFeed([]);
      setLastEvent("");
      setWebrtcAggregate(aggregateWebRTC({}));
      setWebrtcSeries({ rttMs: [], jitterVideo: [], downlinkKbps: [], fpsIn: [] });
      setWebrtcLastByUser({});
      setWebrtcPerUserSeries({});
      setTestElapsedSec(null);
      setElapsedSeries([]);
      setActiveSessionId("");
      setSeriesTimeMs({
        cumulative: [],
        rps: [],
        elapsed: [],
        webrtc: { rttMs: [], jitterVideo: [], downlinkKbps: [], fpsIn: [] }
      });
      setTestWallStartMs(null);
    };

    const appendCumulativeSample = () => {
      if (!sessionIdRef.current) return;
      const c = cumulativeListRef.current;
      const t = totalsRef.current.req;
      const ms = Date.now();
      c.push(t);
      cumulativeTimeMsRef.current.push(ms);
      if (c.length > CUMULATIVE_MAX) {
        c.shift();
        cumulativeTimeMsRef.current.shift();
      }
    };

    const timestampFromEvent = (data) => {
      const parsed = Date.parse(data?.ts || "");
      return Number.isNaN(parsed) ? Date.now() : parsed;
    };

    const appendWebrtcSeriesSample = (sampleMs) => {
      const m = lastByUserRef.current;
      let sumB = 0;
      for (const s of Object.values(m)) {
        if (s) sumB += totalRtcpBytesIn(s);
      }
      const prevB = webrtcBytesTotalRef.current;
      let downKbps = 0;
      if (prevB.ts && sampleMs > prevB.ts && sumB >= prevB.sumBytes) {
        const dt = (sampleMs - prevB.ts) / 1000;
        downKbps = ((sumB - prevB.sumBytes) * 8) / 1000 / Math.max(dt, 0.001);
      }
      webrtcBytesTotalRef.current = { ts: sampleMs, sumBytes: sumB };
      const hasRtcSample = Object.values(m).some((s) => s && summaryHasWebrtcActivity(s));
      /** Sem tráfego RTP/PCs, não empilhar zeros — senão os gráficos parecem “válidos” e confundem com HTTP. */
      const meaningfulDownlink = downKbps > 0.75;
      if (!hasRtcSample && !meaningfulDownlink) {
        return;
      }
      const sa = seriesAveragesFromLastByUser(m);
      const rtt = sa.rtt;
      const jv = sa.jitterVideoMs;
      const fps = sa.fps;
      const cap = 60;
      const push = (arr, v) => {
        const x = v != null && Number.isFinite(v) ? v : 0;
        return [...arr, x].slice(-cap);
      };
      const pushT = (tarr) => [...tarr, sampleMs || Date.now()].slice(-cap);
      const ws = webrtcSeriesRef.current;
      const wst = webrtcTimeMsRef.current;
      ws.rttMs = push(ws.rttMs, rtt != null && Number.isFinite(rtt) ? rtt : 0);
      wst.rttMs = pushT(wst.rttMs);
      ws.jitterVideo = push(ws.jitterVideo, jv != null && Number.isFinite(jv) ? jv : 0);
      wst.jitterVideo = pushT(wst.jitterVideo);
      ws.downlinkKbps = push(ws.downlinkKbps, downKbps);
      wst.downlinkKbps = pushT(wst.downlinkKbps);
      ws.fpsIn = push(ws.fpsIn, fps != null && Number.isFinite(fps) ? fps : 0);
      wst.fpsIn = pushT(wst.fpsIn);

      // Séries por utilizador virtual
      const pus = webrtcPerUserSeriesRef.current;
      const pbu = prevBytesPerUserRef.current;
      for (const [uid, s] of Object.entries(m)) {
        if (!s || !summaryHasWebrtcActivity(s)) continue;
        if (!pus[uid]) pus[uid] = { rttMs: [], jitterVideo: [], downlinkKbps: [], fpsIn: [], timeMs: [] };
        const us = pus[uid];
        const uRtt = rttFromSummary(s);
        const uJv = s.inboundVideo?.jitter != null ? s.inboundVideo.jitter * 1000 : null;
        const uFps = s.inboundVideo?.framesPerSecond ?? null;
        const uBytes = totalRtcpBytesIn(s);
        let uDownKbps = 0;
        const pb = pbu[uid];
        if (pb && sampleMs > pb.ts && uBytes >= pb.sumBytes) {
          const dt = (sampleMs - pb.ts) / 1000;
          uDownKbps = ((uBytes - pb.sumBytes) * 8) / 1000 / Math.max(dt, 0.001);
        }
        pbu[uid] = { ts: sampleMs, sumBytes: uBytes };
        const pushU = (arr, v) => [...arr, v != null && Number.isFinite(v) ? v : 0].slice(-cap);
        us.rttMs = pushU(us.rttMs, uRtt);
        us.jitterVideo = pushU(us.jitterVideo, uJv);
        us.downlinkKbps = pushU(us.downlinkKbps, uDownKbps);
        us.fpsIn = pushU(us.fpsIn, uFps);
        us.timeMs = pushU(us.timeMs, sampleMs);
      }
    };

    const flushWebrtcSeriesFromRef = () => {
      if (!webrtcDirtyRef.current) return;
      webrtcDirtyRef.current = false;
    };

    const flushThrottled = () => {
      appendCumulativeSample();
      flushWebrtcSeriesFromRef();

      setRequestTotal(totalsRef.current.req);
      setResponseTotal(totalsRef.current.res);
      setFailTotal(totalsRef.current.fail);
      setCumulativeSeries(cumulativeListRef.current.slice());
      const b = secondBucketRef.current;
      setRpsSeries([...rpsHistoryRef.current, b.count].slice(-80));
      setStatusCounts({ ...statusMapRef.current });
      setFeed([...feedListRef.current].slice(0, 40));
      setLastEvent(lastEventRef.current);
      if (sessionIdRef.current) setActiveSessionId(sessionIdRef.current);
      if (elapsedListRef.current.length) setElapsedSeries(elapsedListRef.current.slice());
      setWebrtcLastByUser({ ...lastByUserRef.current });
      setWebrtcAggregate(aggregateWebRTC(lastByUserRef.current));
      const s = webrtcSeriesRef.current;
      const wtm = webrtcTimeMsRef.current;
      setWebrtcSeries({
        rttMs: s.rttMs.slice(),
        jitterVideo: s.jitterVideo.slice(),
        downlinkKbps: s.downlinkKbps.slice(),
        fpsIn: s.fpsIn.slice()
      });
      setWebrtcPerUserSeries(
        Object.fromEntries(
          Object.entries(webrtcPerUserSeriesRef.current).map(([uid, us]) => [
            uid,
            {
              rttMs: us.rttMs.slice(),
              jitterVideo: us.jitterVideo.slice(),
              downlinkKbps: us.downlinkKbps.slice(),
              fpsIn: us.fpsIn.slice(),
              timeMs: us.timeMs.slice()
            }
          ])
        )
      );
      const rpsAll = [...rpsHistoryRef.current, b.count];
      const tAll = [...rpsHistoryTimeRef.current, Date.now()];
      const rpsStart = Math.max(0, rpsAll.length - 80);
      const rpsV = rpsAll.slice(rpsStart);
      const rpsT = tAll.slice(rpsStart);
      setSeriesTimeMs({
        cumulative: [...cumulativeTimeMsRef.current],
        rps: rpsT,
        elapsed: [...elapsedTimeMsRef.current],
        webrtc: {
          rttMs: wtm.rttMs.slice(),
          jitterVideo: wtm.jitterVideo.slice(),
          downlinkKbps: wtm.downlinkKbps.slice(),
          fpsIn: wtm.fpsIn.slice()
        }
      });
    };

    let flushIv = null;
    const elapsedDurationIv = setInterval(() => {
      if (clientElapsedRef.current.active) {
        const { wallMs, baseSec } = clientElapsedRef.current;
        setTestElapsedSec(baseSec + (Date.now() - wallMs) / 1000);
      }
    }, 300);

    function stopFlushInterval() {
      if (flushIv != null) {
        clearInterval(flushIv);
        flushIv = null;
      }
    }

    const prependFeed = (item) => {
      feedListRef.current = [item, ...feedListRef.current].slice(0, 40);
    };

    /** Um usuário só conta como "pronto" quando JÁ ENTROU na chamada (user_joined)
     *  E suas métricas WebRTC estão ativas nos gráficos — a pré-sala também cria
     *  RTCPeerConnections, então atividade sozinha não significa que entrou. */
    const maybeStartCallTimer = (tsIso) => {
      if (callStartedAtRef.current != null) return;
      let ready = 0;
      for (const id of activeStatsUserIdsRef.current) {
        if (joinedUserIdsRef.current.has(id)) ready += 1;
      }
      setActiveStatsUserCount(ready);
      const target = targetVirtualUsersRef.current;
      if (target != null && ready >= target) {
        callStartedAtRef.current = Date.now();
        setCallStartedAtMs(callStartedAtRef.current);
        prependFeed({
          kind: "info",
          text: `Todos os ${target} usuários entraram e os dados começaram a atualizar nos gráficos — iniciando a contagem da duração da chamada.`,
          ts: tsIso
        });
      }
    };

    function wireWebSocket(socket) {
      socket.onopen = () => {
        setConnected(true);
        stopFlushInterval();
        flushIv = setInterval(flushThrottled, FLUSH_MS);
        flushThrottled();
      };
      socket.onclose = () => {
        stopFlushInterval();
        flushThrottled();
        setConnected(false);
      };
      socket.onerror = () => setConnected(false);

      socket.onmessage = (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (data.type !== "telemetry") {
          return;
        }

        lastEventRef.current = data.event || "";

        if (data.event === "test_start") {
          resetMetrics();
          const startedAtMs = Date.parse(data.startedAtISO || "");
          const wall = Number.isNaN(startedAtMs) ? Date.now() : startedAtMs;
          setTestWallStartMs(wall);
          if (data.sessionId) sessionIdRef.current = String(data.sessionId);
          const target = Number(data.targetVirtualUsers ?? data.virtualUsers);
          if (Number.isFinite(target) && target >= 1) {
            targetVirtualUsersRef.current = target;
            setTargetVirtualUsers(target);
          }
          if (data.elapsedSec != null && Number.isFinite(Number(data.elapsedSec))) {
            const es = Number(data.elapsedSec);
            elapsedValueRef.current = es;
            elapsedListRef.current = [es];
            elapsedTimeMsRef.current = [wall];
            lastElapsedUiAtRef.current = Date.now();
            clientElapsedRef.current = {
              active: true,
              wallMs: Date.now(),
              baseSec: es
            };
            setTestElapsedSec(es);
          } else {
            clientElapsedRef.current = { active: true, wallMs: Date.now(), baseSec: 0 };
            elapsedListRef.current = [0];
            elapsedTimeMsRef.current = [wall];
            setTestElapsedSec(0);
          }
          lastEventRef.current = "test_start";
          flushThrottled();
          return;
        }

        if (data.elapsedSec != null && Number.isFinite(Number(data.elapsedSec))) {
          const es = Number(data.elapsedSec);
          elapsedValueRef.current = es;
          if (clientElapsedRef.current.active) {
            clientElapsedRef.current = { active: true, wallMs: Date.now(), baseSec: es };
          }
          const t = Date.now();
          if (t - lastElapsedUiAtRef.current >= ELAPSED_UI_MIN_MS) {
            lastElapsedUiAtRef.current = t;
            elapsedListRef.current = [...elapsedListRef.current, es].slice(-80);
            elapsedTimeMsRef.current = [...elapsedTimeMsRef.current, t].slice(-80);
          }
        }
        if (data.sessionId && typeof data.sessionId === "string") {
          sessionIdRef.current = data.sessionId;
        }

        if (data.event === "test_stopped") {
          clientElapsedRef.current = { ...clientElapsedRef.current, active: false };
          prependFeed({
            kind: "info",
            text: data.message || "Teste interrompido.",
            ts: data.ts
          });
          onTestRunFinishedRef.current?.();
          flushThrottled();
          return;
        }

        if (data.event === "test_complete" || data.event === "server_audit_summary") {
          clientElapsedRef.current = { ...clientElapsedRef.current, active: false };
          onTestRunFinishedRef.current?.();
        }

        if (data.event === "request") {
          const t = totalsRef.current;
          t.req += 1;
          const nowSec = Math.floor(Date.now() / 1000);
          const bucket = secondBucketRef.current;
          if (bucket.second !== nowSec) {
            rpsHistoryRef.current.push(bucket.count);
            rpsHistoryTimeRef.current.push(Date.now());
            rpsHistoryRef.current = rpsHistoryRef.current.slice(-40);
            rpsHistoryTimeRef.current = rpsHistoryTimeRef.current.slice(-40);
            bucket.second = nowSec;
            bucket.count = 1;
          } else {
            bucket.count += 1;
          }
          const tFeed = Date.now();
          if (tFeed - lastRequestFeedAtRef.current >= REQUEST_FEED_MIN_MS) {
            lastRequestFeedAtRef.current = tFeed;
            prependFeed({ kind: "req", text: `${data.method} ${(data.url || "").slice(0, 72)}`, ts: data.ts });
          }
        }

        if (data.event === "response") {
          totalsRef.current.res += 1;
          const st = String(data.status ?? "?");
          const m = statusMapRef.current;
          m[st] = (m[st] || 0) + 1;
        }

        if (data.event === "request_failed") {
          totalsRef.current.fail += 1;
          prependFeed({ kind: "fail", text: data.errorText || "fail", ts: data.ts });
        }

        if (data.event === "chaos_profile_changed" && data.profile != null) {
          prependFeed({
            kind: "info",
            text: `Chaos de rede: perfil «${data.profile}» (aplicado nos Chromium)`,
            ts: data.ts
          });
        }

        if (data.event === "pool_draining" && data.message) {
          prependFeed({ kind: "info", text: String(data.message), ts: data.ts });
        }

        if (data.event === "jitsi_debug_hint" && data.message) {
          prependFeed({ kind: "info", text: String(data.message), ts: data.ts });
        }
        if (data.event === "jitsi_debug_pause" && data.message) {
          prependFeed({ kind: "info", text: `Pausa depuração Jitsi: ${String(data.message).slice(0, 200)}`, ts: data.ts });
        }
        if (data.event === "jitsi_login_ui_reveal" && data.result != null) {
          const r = data.result;
          const detail = r.clicks?.length ? `cliques: ${r.clicks.join(", ")}` : r.note || r.error || JSON.stringify(r).slice(0, 120);
          prependFeed({
            kind: "info",
            text: `Jitsi reveal UI: ${r.ok ? "ok" : "sem match"} — ${detail}`,
            ts: data.ts
          });
        }
        if (data.event === "jitsi_join_mode" && data.message) {
          prependFeed({
            kind: "info",
            text: `Jitsi: ${data.claimHost ? "reivindicar anfitrião" : "não tocar anfitrião (convidado)"} — ${String(data.message).slice(0, 280)}`,
            ts: data.ts
          });
        }
        if (data.event === "jitsi_guest_path") {
          if (data.ok) {
            const bits = [data.method, data.label && String(data.label).slice(0, 80), data.attempt && `tent. ${data.attempt}`]
              .filter(Boolean)
              .join(" · ");
            prependFeed({ kind: "info", text: `Jitsi: caminho convidado/dispensar — ${bits}`, ts: data.ts });
          } else {
            prependFeed({ kind: "info", text: String(data.message || "convidado: sem match no diálogo").slice(0, 240), ts: data.ts });
          }
        }
        if (data.event === "jitsi_host_button") {
          if (data.skipped) {
            prependFeed({ kind: "info", text: String(data.message || "Espera pelo botão anfitrião desligada"), ts: data.ts });
          } else if (data.ok) {
            const bits = [data.method || "click", data.label && String(data.label).slice(0, 80), data.attempt && `tent. ${data.attempt}`]
              .filter(Boolean)
              .join(" · ");
            prependFeed({ kind: "info", text: `Jitsi: botão anfitrião / «I am the host» — ${bits}`, ts: data.ts });
          } else {
            prependFeed({ kind: "fail", text: `Jitsi anfitrião: ${String(data.message || "não encontrado").slice(0, 220)}`, ts: data.ts });
          }
        }
        if (data.event === "jitsi_auth_attempt") {
          const phase = data.phase === "google" ? "Google (pós-join) " : data.phase === "in_page" ? "form. na página " : "";
          prependFeed({
            kind: "info",
            text: `Jitsi: a tentar login — ${phase}JITSI_AUTH_* (env)…`,
            ts: data.ts
          });
        }
        if (data.event === "jitsi_auth_result") {
          const ok = Boolean(data.ok);
          prependFeed({
            kind: ok ? "info" : "fail",
            text: `Jitsi login: ${ok ? "ok" : "falhou"}${data.method ? ` (${data.method})` : ""}${data.message ? ` — ${String(data.message).slice(0, 160)}` : ""}`,
            ts: data.ts
          });
        }
        if (data.event === "jitsi_prejoin") {
          prependFeed({
            kind: "info",
            text: `Jitsi pré-sala: botão de entrar ${data.clickedJoin ? "acionado" : "não encontrado (use headful ou aumente tempo)"}`,
            ts: data.ts
          });
        }

        if (data.event === "jitsi_hint" && data.message) {
          prependFeed({ kind: "info", text: data.message, ts: data.ts });
        }

        if (data.event === "zoom_url_normalized" && data.url) {
          prependFeed({ kind: "info", text: `Zoom: URL convertida para web client — ${String(data.url).slice(0, 160)}`, ts: data.ts });
        }
        if (data.event === "zoom_join_mode" && data.message) {
          prependFeed({ kind: "info", text: `Zoom: ${String(data.message).slice(0, 260)}`, ts: data.ts });
        }
        if (data.event === "zoom_join_step" && data.action) {
          prependFeed({ kind: "info", text: `Zoom: ação de entrada — ${String(data.action).slice(0, 140)}`, ts: data.ts });
        }
        if (data.event === "zoom_join_state" && data.state) {
          const st = data.state;
          const buttons = Array.isArray(st.buttons) && st.buttons.length ? ` botões: ${st.buttons.slice(0, 5).join(" | ")}` : "";
          const text = st.text ? ` texto: ${String(st.text).slice(0, 180)}` : "";
          const error = st.error ? ` erro: ${String(st.error).slice(0, 120)}` : "";
          prependFeed({
            kind: "info",
            text: `Zoom estado (${data.label || "check"}): ${st.title || ""}${buttons}${text}${error}`.slice(0, 360),
            ts: data.ts
          });
        }
        if (data.event === "zoom_hint" && data.message) {
          prependFeed({ kind: "info", text: String(data.message).slice(0, 260), ts: data.ts });
        }
        if (data.event === "zoom_blocked" && data.message) {
          prependFeed({ kind: "fail", text: `Zoom bloqueado: ${String(data.message).slice(0, 240)}`, ts: data.ts });
        }
        if (data.event === "whereby_join_mode" && data.message) {
          prependFeed({ kind: "info", text: `Whereby: ${String(data.message).slice(0, 260)}`, ts: data.ts });
        }
        if (data.event === "whereby_join_step" && data.action) {
          prependFeed({ kind: "info", text: `Whereby: ação de entrada — ${String(data.action).slice(0, 140)}`, ts: data.ts });
        }
        if (data.event === "whereby_join_state" && data.state) {
          const st = data.state;
          const buttons = Array.isArray(st.buttons) && st.buttons.length ? ` botões: ${st.buttons.slice(0, 5).join(" | ")}` : "";
          const text = st.text ? ` — ${String(st.text).slice(0, 120)}` : "";
          const error = st.error ? ` ERRO: ${String(st.error).slice(0, 80)}` : "";
          prependFeed({ kind: "info", text: `Whereby estado (${data.label || "check"}): ${st.title || ""}${buttons}${text}${error}`.slice(0, 360), ts: data.ts });
        }
        if (data.event === "whereby_hint" && data.message) {
          prependFeed({ kind: "info", text: `Whereby: ${String(data.message).slice(0, 260)}`, ts: data.ts });
        }
        if (data.event === "whereby_rtc_diag") {
          const d = data;
          const msg = `Whereby diagnóstico (user ${d.userId}): rtcWrapped=${d.rtcWrapped} hookedPCs=${d.hookedPCs} pcInGlobal=${d.pcInGlobal} frames=${d.frameCount} workers=[${(d.workerKeys||[]).join(",")}]${d.error ? " ERRO:"+d.error : ""}`;
          prependFeed({ kind: d.hookedPCs > 0 || d.pcInGlobal > 0 ? "success" : "fail", text: msg, ts: data.ts });
        }
        if (data.event === "whereby_stats_debug") {
          const h = data.hookPCs || {};
          const states = (h.states || []).map((s) => `${s.conn}/${s.ice}`).join(", ") || "—";
          const msg = `Whereby stats-debug (user ${data.userId}) tick=${data.tick}: hookPCs=${h.count ?? "?"} states=[${states}] summaryPCs=${data.summaryPCs}${h.error ? " ERR:"+h.error : ""}`;
          prependFeed({ kind: (h.count || 0) > 0 ? "success" : "warn", text: msg, ts: data.ts });
        }

        if (data.event === "zoom_stats_debug" && data.debug) {
          const types = Object.entries(data.debug.types || {})
            .sort((a, b) => Number(b[1]) - Number(a[1]))
            .slice(0, 8)
            .map(([type, count]) => `${type}:${count}`)
            .join(", ");
          const sample = (data.debug.samples || [])
            .slice(0, 3)
            .map((s) => {
              const fields = ["kind", "mediaType", "jitter", "framesDecoded", "framesReceived", "framesRendered", "framesPerSecond", "bytesReceived", "packetsReceived"]
                .filter((k) => s[k] != null)
                .map((k) => `${k}=${s[k]}`)
                .join(" ");
              return `${s.type}${s.kind ? `/${s.kind}` : ""}${fields ? ` ${fields}` : ""}`;
            })
            .join(" | ");
          const videos = (data.debug.videoElements || [])
            .slice(0, 3)
            .map((v) => `${v.width || 0}x${v.height || 0}/rs${v.readyState}`)
            .join(", ");
          prependFeed({
            kind: "info",
            text: `Zoom stats t${data.tick ?? "?"}: PCs=${data.debug.peerConnections ?? "?"}; tipos ${types || "—"}; vídeos ${videos || "—"}; amostras ${sample || "—"}`,
            ts: data.ts
          });
        }

        /**
         * No modo *pool* o runner incrementa `userId` a cada browser (1,2,3,…). Os workers
         * que já terminam emitem `user_done` — mantemos as últimas métricas para o dashboard
         * mostrar os valores finais; o mapa é limpo pelo resetMetrics() no início do próximo teste.
         * NÃO apagar aqui: zeraria os KPIs imediatamente após o teste terminar.
         */
        if (data.event === "user_joined" && data.userId != null) {
          joinedUserIdsRef.current.add(String(data.userId));
          setJoinedUserCount(joinedUserIdsRef.current.size);
          maybeStartCallTimer(data.ts);
        }

        if ((data.event === 'user_done' || data.event === 'user_error') && data.userId != null) {
          // Marcar como concluído sem apagar — os valores finais ficam visíveis no dashboard
          const uid = String(data.userId);
          if (lastByUserRef.current[uid]) {
            lastByUserRef.current[uid] = { ...lastByUserRef.current[uid], _done: true };
            webrtcDirtyRef.current = true;
          }
        }

        if (data.event === "webrtc_probe" && data.probe) {
          const p = data.probe;
          if (p.error) {
            prependFeed({
              kind: "info",
              text: `WebRTC probe falhou (user ${data.userId ?? "?"}): ${p.message || "erro"}`,
              ts: data.ts
            });
          } else {
          let sumTracked = 0;
          let sumActive = 0;
          let wrappedFrames = 0;
          let protoFrames = 0;
          const frameRows = [];
          if (Array.isArray(p.pages)) {
            for (const pg of p.pages) {
              frameRows.push(...(pg.frames || []));
            }
          } else {
            frameRows.push(...(p.frames || []));
          }
          for (const row of frameRows) {
            if (row && row.tracked >= 0) sumTracked += row.tracked;
            sumActive += row.active || 0;
            if (row.wrapped) wrappedFrames += 1;
            if (row.protoTracked) protoFrames += 1;
          }
          const targets = p.pageTargetCount != null ? `${p.pageTargetCount} target(s) page` : "1 página";
          const frames =
            p.totalFrames != null ? p.totalFrames : p.frameCount != null ? p.frameCount : frameRows.length;
          prependFeed({
            kind: "info",
            text: `WebRTC probe (user ${data.userId ?? "?"}): ${targets}, ${frames} frame(s) no total, construtor wrap em ${wrappedFrames} frame(s), patch prototype em ${protoFrames}, PCs rastreados=${sumTracked}, ativos=${sumActive}`,
            ts: data.ts
          });
          }
        }

        if (data.event === "webrtc_stats" && data.statsNote) {
          const t = Date.now();
          if (t - lastWebrtcStatsNoteAtRef.current > 15000) {
            lastWebrtcStatsNoteAtRef.current = t;
            prependFeed({
              kind: "info",
              text: `WebRTC aviso: ${String(data.statsNote).slice(0, 180)}`,
              ts: data.ts
            });
          }
        }

        if (data.event === "webrtc_stats" && data.summary) {
          const uid = String(data.userId ?? "");
          const prevU = lastByUserRef.current[uid];
          const sampleMs = timestampFromEvent(data);
          const framesDecoded = Number(data.summary?.inboundVideo?.framesDecoded);
          const prevFrames = webrtcFramesByUserRef.current[uid];
          if (
            Number.isFinite(framesDecoded) &&
            data.summary?.inboundVideo &&
            data.summary.inboundVideo.framesPerSecond == null &&
            prevFrames?.ts &&
            sampleMs > prevFrames.ts &&
            framesDecoded >= prevFrames.frames
          ) {
            const fps = (framesDecoded - prevFrames.frames) / ((sampleMs - prevFrames.ts) / 1000);
            if (Number.isFinite(fps) && fps > 0) {
              data.summary = {
                ...data.summary,
                inboundVideo: { ...data.summary.inboundVideo, framesPerSecond: fps }
              };
            }
          }
          if (Number.isFinite(framesDecoded)) {
            webrtcFramesByUserRef.current[uid] = { ts: sampleMs, frames: framesDecoded };
          }
          lastByUserRef.current[uid] = pickWebrtcSummaryForDisplay(prevU, data.summary);
          appendWebrtcSeriesSample(sampleMs);
          webrtcDirtyRef.current = true;
          // Inicia a contagem da "duração da chamada" apenas quando TODOS os VUs já
          // entraram na chamada E estão com métricas WebRTC ativas nos gráficos.
          if (callStartedAtRef.current == null) {
            if (summaryHasWebrtcActivity(data.summary) && !activeStatsUserIdsRef.current.has(uid)) {
              activeStatsUserIdsRef.current.add(uid);
            }
            maybeStartCallTimer(data.ts);
          }
        }
      };
    }

    void (async () => {
      try {
        const r = await fetch(`${apiBaseUrl}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: ac.signal
        });
        if (ac.signal.aborted) return;
        if (r.status === 401) {
          setConnected(false);
          onSessionInvalidRef.current?.();
          return;
        }
        if (!r.ok) {
          setConnected(false);
          return;
        }
        if (ac.signal.aborted) return;
        const url = buildWsUrl(apiBaseUrl, token);
        ws = new WebSocket(url);
        wireWebSocket(ws);
      } catch {
        if (ac.signal.aborted) return;
        setConnected(false);
      }
    })();

    return () => {
      clearInterval(elapsedDurationIv);
      stopFlushInterval();
      ac.abort();
      if (ws) {
        try {
          ws.close();
        } catch {
          /* */
        }
      }
    };
  }, [enabled, token, apiBaseUrl]);

  return {
    connected,
    requestTotal,
    responseTotal,
    failTotal,
    cumulativeSeries,
    rpsSeries,
    statusCounts,
    feed,
    lastEvent,
    webrtcAggregate,
    webrtcSeries,
    webrtcPerUserSeries,
    webrtcLastByUser,
    testElapsedSec,
    elapsedSeries,
    activeSessionId,
    seriesTimeMs,
    testWallStartMs,
    joinedUserCount,
    activeStatsUserCount,
    targetVirtualUsers,
    callStartedAtMs
  };
}
