import { useEffect, useRef, useState } from "react";

function buildWsUrl(apiBaseUrl, token) {
  const base = apiBaseUrl.replace(/^http/, "ws").replace(/\/$/, "");
  return `${base}/ws/telemetry?token=${encodeURIComponent(token)}`;
}

function avg(nums) {
  const n = nums.filter((x) => x != null && Number.isFinite(x));
  if (!n.length) return null;
  return n.reduce((a, b) => a + b, 0) / n.length;
}

function aggregateWebRTC(lastByUser) {
  const rows = Object.values(lastByUser).filter((s) => s && s.peerConnections > 0);
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
    bin += (r.inboundVideo?.bytesReceived || 0) + (r.inboundAudio?.bytesReceived || 0);
    bout += (r.outboundVideo?.bytesSent || 0) + (r.outboundAudio?.bytesSent || 0);
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

export function useTelemetryWS(apiBaseUrl, token, enabled) {
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
  const lastByUserRef = useRef({});
  const webrtcPrevRef = useRef({ ts: 0, bytesIn: 0 });

  const [webrtcAggregate, setWebrtcAggregate] = useState(() => aggregateWebRTC({}));
  const [webrtcSeries, setWebrtcSeries] = useState({
    rttMs: [],
    jitterVideo: [],
    downlinkKbps: [],
    fpsIn: []
  });
  const [webrtcLastByUser, setWebrtcLastByUser] = useState({});

  useEffect(() => {
    if (!enabled || !token) {
      setConnected(false);
      return undefined;
    }

    const url = buildWsUrl(apiBaseUrl, token);
    const ws = new WebSocket(url);

    const resetMetrics = () => {
      setRequestTotal(0);
      setResponseTotal(0);
      setFailTotal(0);
      setCumulativeSeries([]);
      setRpsSeries([]);
      setStatusCounts({});
      setFeed([]);
      setLastEvent("");
      secondBucketRef.current = { second: 0, count: 0 };
      rpsHistoryRef.current = [];
      lastByUserRef.current = {};
      webrtcPrevRef.current = { ts: 0, bytesIn: 0 };
      setWebrtcAggregate(aggregateWebRTC({}));
      setWebrtcSeries({ rttMs: [], jitterVideo: [], downlinkKbps: [], fpsIn: [] });
      setWebrtcLastByUser({});
    };

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    ws.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data.type !== "telemetry") {
        return;
      }

      setLastEvent(data.event || "");

      if (data.event === "test_start") {
        resetMetrics();
        setLastEvent("test_start");
        return;
      }

      if (data.event === "request") {
        setRequestTotal((c) => c + 1);
        setCumulativeSeries((s) => {
          const next = [...s, s.length ? s[s.length - 1] + 1 : 1];
          return next.slice(-80);
        });
        const nowSec = Math.floor(Date.now() / 1000);
        const bucket = secondBucketRef.current;
        if (bucket.second !== nowSec) {
          rpsHistoryRef.current.push(bucket.count);
          rpsHistoryRef.current = rpsHistoryRef.current.slice(-40);
          bucket.second = nowSec;
          bucket.count = 1;
        } else {
          bucket.count += 1;
        }
        setRpsSeries([...rpsHistoryRef.current, bucket.count]);
        setFeed((f) =>
          [{ kind: "req", text: `${data.method} ${(data.url || "").slice(0, 72)}`, ts: data.ts }, ...f].slice(0, 40)
        );
      }

      if (data.event === "response") {
        setResponseTotal((c) => c + 1);
        const st = String(data.status ?? "?");
        setStatusCounts((m) => ({ ...m, [st]: (m[st] || 0) + 1 }));
      }

      if (data.event === "request_failed") {
        setFailTotal((c) => c + 1);
        setFeed((f) =>
          [{ kind: "fail", text: data.errorText || "fail", ts: data.ts }, ...f].slice(0, 40)
        );
      }

      if (data.event === "jitsi_prejoin") {
        setFeed((f) =>
          [
            {
              kind: "info",
              text: `Jitsi pré-sala: botão de entrar ${data.clickedJoin ? "acionado" : "não encontrado (use headful ou aumente tempo)"}`,
              ts: data.ts
            },
            ...f
          ].slice(0, 40)
        );
      }

      if (data.event === "jitsi_hint" && data.message) {
        setFeed((f) => [{ kind: "info", text: data.message, ts: data.ts }, ...f].slice(0, 40));
      }

      if (data.event === "webrtc_probe" && data.probe) {
        const p = data.probe;
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
        const targets =
          p.pageTargetCount != null ? `${p.pageTargetCount} target(s) page` : "1 página";
        const frames =
          p.totalFrames != null ? p.totalFrames : p.frameCount != null ? p.frameCount : frameRows.length;
        setFeed((f) =>
          [
            {
              kind: "info",
              text: `WebRTC probe (user ${data.userId ?? "?"}): ${targets}, ${frames} frame(s) no total, construtor wrap em ${wrappedFrames} frame(s), patch prototype em ${protoFrames}, PCs rastreados=${sumTracked}, ativos=${sumActive}`,
              ts: data.ts
            },
            ...f
          ].slice(0, 40)
        );
      }

      if (data.event === "webrtc_stats" && data.summary) {
        const uid = data.userId;
        lastByUserRef.current[uid] = data.summary;
        const agg = aggregateWebRTC(lastByUserRef.current);
        setWebrtcAggregate(agg);
        setWebrtcLastByUser({ ...lastByUserRef.current });

        const s = data.summary;
        const now = Date.now();
        const bytesIn =
          (s.inboundVideo?.bytesReceived || 0) + (s.inboundAudio?.bytesReceived || 0);
        const prev = webrtcPrevRef.current;
        let downKbps = 0;
        if (prev.ts && now > prev.ts && bytesIn >= prev.bytesIn) {
          const dt = (now - prev.ts) / 1000;
          downKbps = ((bytesIn - prev.bytesIn) * 8) / 1000 / Math.max(dt, 0.001);
        }
        webrtcPrevRef.current = { ts: now, bytesIn };

        const rtt =
          s.candidatePair?.currentRoundTripTimeMs ??
          s.remoteInbound?.videoRoundTripTimeMs ??
          s.remoteInbound?.audioRoundTripTimeMs;
        const jv = s.inboundVideo?.jitter != null ? s.inboundVideo.jitter * 1000 : null;
        const fps = s.inboundVideo?.framesPerSecond;

        setWebrtcSeries((prevSeries) => {
          const cap = 60;
          const push = (arr, v) => {
            const x = v != null && Number.isFinite(v) ? v : 0;
            return [...arr, x].slice(-cap);
          };
          return {
            rttMs: push(prevSeries.rttMs, rtt != null && Number.isFinite(rtt) ? rtt : 0),
            jitterVideo: push(prevSeries.jitterVideo, jv != null && Number.isFinite(jv) ? jv : 0),
            downlinkKbps: push(prevSeries.downlinkKbps, downKbps),
            fpsIn: push(prevSeries.fpsIn, fps != null && Number.isFinite(fps) ? fps : 0)
          };
        });
      }
    };

    return () => {
      ws.close();
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
    webrtcLastByUser
  };
}
