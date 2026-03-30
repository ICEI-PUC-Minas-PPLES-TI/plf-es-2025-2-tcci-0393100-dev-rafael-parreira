import puppeteer from "puppeteer";
import { setTimeout as delay } from "node:timers/promises";

const [, , apiUrl, accessToken, virtualUsersArg] = process.argv;
const virtualUsers = Number.parseInt(virtualUsersArg || "1", 10);
const shouldOpenBrowser = process.env.PUPPETEER_HEADFUL === "1";
const ignoreHttpsErrors = process.env.PUPPETEER_IGNORE_HTTPS_ERRORS === "1";
const disableQuic = process.env.PUPPETEER_DISABLE_QUIC === "1";
const slowMo = Number.parseInt(process.env.PUPPETEER_SLOW_MO || "0", 10);
const statsIntervalMs = Number.parseInt(process.env.WEBRTC_STATS_INTERVAL_MS || "2000", 10);
const dwellMs = Number.parseInt(process.env.AUDIT_PAGE_DWELL_MS || "8000", 10);

if (!apiUrl || !accessToken || Number.isNaN(virtualUsers)) {
  console.error("Missing required arguments: apiUrl accessToken virtualUsers");
  process.exit(1);
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

/**
 * Instalado no contexto da página (CDP + evaluate). Além de substituir o construtor,
 * faz patch em métodos do prototype da classe nativa — o Jitsi (e bundlers) podem
 * guardar `const PC = RTCPeerConnection` antes do wrapper; `new PC()` ainda usa o
 * prototype partilhado, e addTrack / setLocalDescription passam a registar o `pc`.
 */
function installStreamSentryRtcHook() {
  try {
    const G = typeof globalThis !== "undefined" ? globalThis : self;
    G.__streamSentryPCs = G.__streamSentryPCs || [];
    const arr = G.__streamSentryPCs;

    function track(pc) {
      if (!pc || arr.includes(pc)) return;
      arr.push(pc);
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "closed" || pc.connectionState === "failed") {
          const i = arr.indexOf(pc);
          if (i >= 0) arr.splice(i, 1);
        }
      });
    }

    function patchProto(Native) {
      if (!Native || !Native.prototype || Native.__streamSentryProtoTrack) return;
      Native.__streamSentryProtoTrack = true;
      const proto = Native.prototype;
      const wrap = (name) => {
        const orig = proto[name];
        if (typeof orig !== "function") return;
        proto[name] = function (...args) {
          track(this);
          return orig.apply(this, args);
        };
      };
      wrap("addTrack");
      wrap("addTransceiver");
      wrap("createDataChannel");
      wrap("createOffer");
      wrap("setLocalDescription");
      wrap("setRemoteDescription");
    }

    const Current = G.RTCPeerConnection;
    if (!Current) return;

    if (Current.__streamSentryWrapped) {
      patchProto(Current.__streamSentryNative || Current);
      return;
    }

    const Orig = Current;
    patchProto(Orig);

    function Wrapped(...args) {
      const pc = new Orig(...args);
      track(pc);
      return pc;
    }
    Wrapped.prototype = Orig.prototype;
    Wrapped.__streamSentryWrapped = true;
    Wrapped.__streamSentryNative = Orig;
    Object.defineProperty(Wrapped, "name", { value: "RTCPeerConnection" });
    G.RTCPeerConnection = Wrapped;
  } catch {
    /* CSP / ambientes restritos */
  }
}

const RTC_HOOK_SOURCE = `(${installStreamSentryRtcHook.toString()})();`;

async function attachRtcHookViaCDP(page) {
  const session = await page.createCDPSession();
  await session.send("Page.enable");
  try {
    await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: RTC_HOOK_SOURCE,
      runImmediately: true
    });
  } catch {
    await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: RTC_HOOK_SOURCE
    });
  }
}

/** CDP em qualquer novo target (ex.: iframe OOPIF do Jitsi). */
async function attachRtcHookToTarget(target) {
  try {
    const p = await target.page();
    if (!p) return;
    const session = await p.createCDPSession();
    await session.send("Page.enable");
    try {
      await session.send("Page.addScriptToEvaluateOnNewDocument", {
        source: RTC_HOOK_SOURCE,
        runImmediately: true
      });
    } catch {
      await session.send("Page.addScriptToEvaluateOnNewDocument", { source: RTC_HOOK_SOURCE });
    }
  } catch {
    /* target sem Page (ex.: worker) */
  }
}

/** Reaplica o hook em todos os frames já carregados (lib-jitsi pode carregar depois do CDP inicial). */
async function injectRtcHookIntoAllFrames(page) {
  for (const frame of page.frames()) {
    try {
      await frame.evaluate(installStreamSentryRtcHook);
    } catch {
      /* frame destacado / cross-origin sem execução */
    }
  }
}

/** Conta PCs e frames numa única Page (vários Frame no mesmo processo). */
async function probeWebRtcFrames(page) {
  const frames = page.frames();
  const rows = [];
  for (const frame of frames) {
    try {
      const row = await frame.evaluate(() => {
        const G = typeof globalThis !== "undefined" ? globalThis : self;
        const pcs = G.__streamSentryPCs || [];
        const active = pcs.filter((p) => p && p.connectionState !== "closed").length;
        const C = G.RTCPeerConnection;
        const Nat = C && (C.__streamSentryNative || C);
        return {
          href: (typeof location !== "undefined" && location.href) || "",
          hasRTC: typeof G.RTCPeerConnection === "function",
          wrapped: !!(C && C.__streamSentryWrapped),
          protoTracked: !!(Nat && Nat.__streamSentryProtoTrack),
          tracked: pcs.length,
          active
        };
      });
      rows.push(row);
    } catch {
      rows.push({
        href: "",
        hasRTC: false,
        wrapped: false,
        protoTracked: false,
        tracked: -1,
        active: 0
      });
    }
  }
  return { frameCount: frames.length, frames: rows };
}

/**
 * Todas as `Page` do browser (inclui iframes OOPIF).
 * No Chromium recente o tipo CDP pode ser `page` ou `iframe`; usamos qualquer target com `.page()`.
 */
async function allPageTargets(browser) {
  const out = [];
  const seen = new Set();
  for (const target of browser.targets()) {
    try {
      const p = await target.page();
      if (!p || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    } catch {
      /* worker, service_worker, etc. */
    }
  }
  return out;
}

async function injectRtcHookEverywhere(browser) {
  const pages = await allPageTargets(browser);
  for (const p of pages) {
    await injectRtcHookIntoAllFrames(p);
  }
}

/** Probe agregado: Jitsi Meet usa OOPIF; `page.frames()` da aba principal fica em 1. */
async function probeWebRtcBrowser(browser) {
  const pages = await allPageTargets(browser);
  const pageInfos = [];
  let totalFrames = 0;
  for (const p of pages) {
    let url = "";
    try {
      url = p.url().slice(0, 220);
    } catch {
      url = "";
    }
    const pr = await probeWebRtcFrames(p);
    totalFrames += pr.frameCount;
    pageInfos.push({ pageUrl: url, frameCount: pr.frameCount, frames: pr.frames });
  }
  return {
    pageTargetCount: pages.length,
    totalFrames,
    pages: pageInfos
  };
}

function isJitsiHost(urlStr) {
  try {
    const h = new URL(urlStr).hostname.toLowerCase();
    return (
      h === "meet.jit.si" ||
      h.endsWith(".jit.si") ||
      h.includes("8x8.vc") ||
      (h.includes("jitsi") && !h.includes("zoom"))
    );
  } catch {
    return false;
  }
}

/** Pré-sala / cookies: percorre documento + iframes same-origin e tenta vários seletores da UI atual do Jitsi. */
async function tryJitsiEnterConference(page) {
  for (let attempt = 0; attempt < 55; attempt++) {
    const action = await page.evaluate(() => {
      const seen = new Set();

      const clickIfVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none")
          return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        el.click();
        return true;
      };

      function walk(doc, depth) {
        if (!doc || depth > 10) return "";
        if (seen.has(doc)) return "";
        seen.add(doc);

        const cookieSelectors = [
          ".iubenda-cs-accept-btn",
          ".iubenda-cs-btn-primary",
          '[id="cookiebanner.button.agreeAll"]',
          'button[aria-label="Accept"]',
          'button[aria-label*="Accept"]'
        ];
        for (const sel of cookieSelectors) {
          const el = doc.querySelector(sel);
          if (clickIfVisible(el)) return "cookie";
        }

        const joinSelectors = [
          '[data-testid="prejoin.joinButton"]',
          '[data-testid="lobby.joinButton"]',
          '[data-testid="prejoin.joinMeeting"]',
          'button[aria-label="Join meeting"]',
          'button[aria-label*="Join meeting"]',
          '[role="button"][aria-label*="Join meeting"]',
          "#jitsi_prejoin_join_button",
          "button.join-meeting",
          ".join-meeting-container button",
          "input[type='submit'][value*='Join' i]",
          "input[type='submit'][value*='Entrar' i]"
        ];
        for (const sel of joinSelectors) {
          const els = doc.querySelectorAll(sel);
          for (const el of els) {
            if (clickIfVisible(el)) return "join-sel";
          }
        }

        const candidates = doc.querySelectorAll(
          "button, [role='button'], input[type='submit'], a[role='button'], a.jitsi-button"
        );
        for (const b of candidates) {
          const t = (b.innerText || b.textContent || b.value || "").trim().toLowerCase();
          const al = (b.getAttribute("aria-label") || "").toLowerCase();
          const title = (b.getAttribute("title") || "").toLowerCase();
          const haystack = `${t} ${al} ${title}`;
          const joinish =
            /\bjoin meeting\b|\bjoin now\b|\bjoin\b.*\bmeeting\b|\bknock\b|\bentrar\b|\bparticipar\b|\biniciar\b/.test(
              haystack
            ) || (al.includes("join") && al.includes("meeting"));
          const avoid = /\bleave\b|\bhang up\b|\bsair\b|\bcancel\b/.test(haystack);
          if (joinish && !avoid && t.length < 80 && clickIfVisible(b)) return "join-text";
        }

        const iframes = doc.querySelectorAll("iframe");
        for (const iframe of iframes) {
          try {
            const child = iframe.contentDocument;
            if (child) {
              const r = walk(child, depth + 1);
              if (r) return r;
            }
          } catch {
            /* cross-origin */
          }
        }
        return "";
      }

      return walk(document, 0);
    });

    if (action === "cookie") {
      await delay(600);
      continue;
    }
    if (action) {
      await delay(1500);
      return true;
    }

    if (attempt % 6 === 5) {
      await page.keyboard.press("Enter").catch(() => {});
      await delay(250);
    }
    await delay(550);
  }
  return false;
}

function emptyWebRtcSummary() {
  return {
    peerConnections: 0,
    inboundAudio: {
      packetsReceived: 0,
      packetsLost: 0,
      jitter: null,
      bytesReceived: 0,
      audioLevel: null
    },
    inboundVideo: {
      packetsReceived: 0,
      packetsLost: 0,
      jitter: null,
      bytesReceived: 0,
      framesDecoded: 0,
      framesDropped: 0,
      frameWidth: null,
      frameHeight: null,
      framesPerSecond: null,
      totalDecodeTime: null,
      qpSum: null
    },
    outboundAudio: { packetsSent: 0, bytesSent: 0 },
    outboundVideo: {
      packetsSent: 0,
      bytesSent: 0,
      framesEncoded: 0,
      framesPerSecond: null,
      qualityLimitationReason: null,
      totalEncodeTime: null,
      qpSum: null
    },
    candidatePair: {
      currentRoundTripTimeMs: null,
      availableOutgoingBitrate: null,
      nominated: false
    },
    remoteInbound: { audioRoundTripTimeMs: null, videoRoundTripTimeMs: null },
    transport: { bytesSent: 0, bytesReceived: 0, dtlsState: null }
  };
}

async function collectStatsFromSingleFrame(frame) {
  return frame.evaluate(async () => {
    const G = typeof globalThis !== "undefined" ? globalThis : self;
    const pcs = G.__streamSentryPCs || [];
    const summary = {
      peerConnections: pcs.filter((p) => p.connectionState !== "closed").length,
      inboundAudio: {
        packetsReceived: 0,
        packetsLost: 0,
        jitter: null,
        bytesReceived: 0,
        audioLevel: null
      },
      inboundVideo: {
        packetsReceived: 0,
        packetsLost: 0,
        jitter: null,
        bytesReceived: 0,
        framesDecoded: 0,
        framesDropped: 0,
        frameWidth: null,
        frameHeight: null,
        framesPerSecond: null,
        totalDecodeTime: null,
        qpSum: null
      },
      outboundAudio: { packetsSent: 0, bytesSent: 0 },
      outboundVideo: {
        packetsSent: 0,
        bytesSent: 0,
        framesEncoded: 0,
        framesPerSecond: null,
        qualityLimitationReason: null,
        totalEncodeTime: null,
        qpSum: null
      },
      candidatePair: {
        currentRoundTripTimeMs: null,
        availableOutgoingBitrate: null,
        nominated: false
      },
      remoteInbound: { audioRoundTripTimeMs: null, videoRoundTripTimeMs: null },
      transport: { bytesSent: 0, bytesReceived: 0, dtlsState: null }
    };

    const rtts = [];

    for (const pc of pcs) {
      if (pc.connectionState === "closed") continue;
      let report;
      try {
        report = await pc.getStats();
      } catch {
        continue;
      }

      report.forEach((s) => {
        const t = s.type;
        if (t === "inbound-rtp" && s.kind === "audio") {
          summary.inboundAudio.packetsReceived += s.packetsReceived || 0;
          summary.inboundAudio.packetsLost += s.packetsLost || 0;
          summary.inboundAudio.bytesReceived += s.bytesReceived || 0;
          if (s.jitter != null) summary.inboundAudio.jitter = s.jitter;
          if (s.audioLevel != null) summary.inboundAudio.audioLevel = s.audioLevel;
        }
        if (t === "inbound-rtp" && s.kind === "video") {
          summary.inboundVideo.packetsReceived += s.packetsReceived || 0;
          summary.inboundVideo.packetsLost += s.packetsLost || 0;
          summary.inboundVideo.bytesReceived += s.bytesReceived || 0;
          if (s.jitter != null) summary.inboundVideo.jitter = s.jitter;
          summary.inboundVideo.framesDecoded += s.framesDecoded || 0;
          summary.inboundVideo.framesDropped += s.framesDropped || 0;
          if (s.frameWidth) summary.inboundVideo.frameWidth = s.frameWidth;
          if (s.frameHeight) summary.inboundVideo.frameHeight = s.frameHeight;
          if (s.framesPerSecond != null) summary.inboundVideo.framesPerSecond = s.framesPerSecond;
          if (s.totalDecodeTime != null) summary.inboundVideo.totalDecodeTime = s.totalDecodeTime;
          if (s.qpSum != null) summary.inboundVideo.qpSum = s.qpSum;
        }
        if (t === "outbound-rtp" && s.kind === "audio") {
          summary.outboundAudio.packetsSent += s.packetsSent || 0;
          summary.outboundAudio.bytesSent += s.bytesSent || 0;
        }
        if (t === "outbound-rtp" && s.kind === "video") {
          summary.outboundVideo.packetsSent += s.packetsSent || 0;
          summary.outboundVideo.bytesSent += s.bytesSent || 0;
          summary.outboundVideo.framesEncoded += s.framesEncoded || 0;
          if (s.framesPerSecond != null) summary.outboundVideo.framesPerSecond = s.framesPerSecond;
          if (s.qualityLimitationReason)
            summary.outboundVideo.qualityLimitationReason = s.qualityLimitationReason;
          if (s.totalEncodeTime != null) summary.outboundVideo.totalEncodeTime = s.totalEncodeTime;
          if (s.qpSum != null) summary.outboundVideo.qpSum = s.qpSum;
        }
        if (t === "candidate-pair" && s.state === "succeeded" && s.nominated) {
          if (s.currentRoundTripTime != null) {
            rtts.push(s.currentRoundTripTime * 1000);
            summary.candidatePair.currentRoundTripTimeMs = s.currentRoundTripTime * 1000;
          }
          if (s.availableOutgoingBitrate != null)
            summary.candidatePair.availableOutgoingBitrate = s.availableOutgoingBitrate;
          summary.candidatePair.nominated = true;
        }
        if (t === "remote-inbound-rtp") {
          const rtt = s.roundTripTime != null ? s.roundTripTime * 1000 : null;
          if (s.kind === "audio" && rtt != null) summary.remoteInbound.audioRoundTripTimeMs = rtt;
          if (s.kind === "video" && rtt != null) summary.remoteInbound.videoRoundTripTimeMs = rtt;
        }
        if (t === "transport") {
          summary.transport.bytesSent += s.bytesSent || 0;
          summary.transport.bytesReceived += s.bytesReceived || 0;
          if (s.dtlsState) summary.transport.dtlsState = s.dtlsState;
        }
      });
    }

    if (rtts.length > 0) {
      summary.candidatePair.currentRoundTripTimeMs =
        rtts.reduce((a, b) => a + b, 0) / rtts.length;
    }

    return summary;
  });
}

function mergeWebRtcSummaries(parts) {
  const base = emptyWebRtcSummary();
  const rttList = [];
  const aobList = [];

  for (const s of parts) {
    if (!s) continue;
    base.peerConnections += s.peerConnections || 0;
    base.inboundAudio.packetsReceived += s.inboundAudio?.packetsReceived || 0;
    base.inboundAudio.packetsLost += s.inboundAudio?.packetsLost || 0;
    base.inboundAudio.bytesReceived += s.inboundAudio?.bytesReceived || 0;
    if (s.inboundAudio?.jitter != null) base.inboundAudio.jitter = s.inboundAudio.jitter;
    if (s.inboundAudio?.audioLevel != null) base.inboundAudio.audioLevel = s.inboundAudio.audioLevel;

    base.inboundVideo.packetsReceived += s.inboundVideo?.packetsReceived || 0;
    base.inboundVideo.packetsLost += s.inboundVideo?.packetsLost || 0;
    base.inboundVideo.bytesReceived += s.inboundVideo?.bytesReceived || 0;
    base.inboundVideo.framesDecoded += s.inboundVideo?.framesDecoded || 0;
    base.inboundVideo.framesDropped += s.inboundVideo?.framesDropped || 0;
    if (s.inboundVideo?.jitter != null) base.inboundVideo.jitter = s.inboundVideo.jitter;
    if (s.inboundVideo?.frameWidth) base.inboundVideo.frameWidth = s.inboundVideo.frameWidth;
    if (s.inboundVideo?.frameHeight) base.inboundVideo.frameHeight = s.inboundVideo.frameHeight;
    if (s.inboundVideo?.framesPerSecond != null)
      base.inboundVideo.framesPerSecond = s.inboundVideo.framesPerSecond;
    if (s.inboundVideo?.totalDecodeTime != null)
      base.inboundVideo.totalDecodeTime = s.inboundVideo.totalDecodeTime;
    if (s.inboundVideo?.qpSum != null) base.inboundVideo.qpSum = s.inboundVideo.qpSum;

    base.outboundAudio.packetsSent += s.outboundAudio?.packetsSent || 0;
    base.outboundAudio.bytesSent += s.outboundAudio?.bytesSent || 0;
    base.outboundVideo.packetsSent += s.outboundVideo?.packetsSent || 0;
    base.outboundVideo.bytesSent += s.outboundVideo?.bytesSent || 0;
    base.outboundVideo.framesEncoded += s.outboundVideo?.framesEncoded || 0;
    if (s.outboundVideo?.framesPerSecond != null)
      base.outboundVideo.framesPerSecond = s.outboundVideo.framesPerSecond;
    if (s.outboundVideo?.qualityLimitationReason)
      base.outboundVideo.qualityLimitationReason = s.outboundVideo.qualityLimitationReason;
    if (s.outboundVideo?.totalEncodeTime != null)
      base.outboundVideo.totalEncodeTime = s.outboundVideo.totalEncodeTime;
    if (s.outboundVideo?.qpSum != null) base.outboundVideo.qpSum = s.outboundVideo.qpSum;

    if (s.candidatePair?.currentRoundTripTimeMs != null)
      rttList.push(s.candidatePair.currentRoundTripTimeMs);
    if (s.candidatePair?.availableOutgoingBitrate != null)
      aobList.push(s.candidatePair.availableOutgoingBitrate);
    if (s.candidatePair?.nominated) base.candidatePair.nominated = true;

    if (s.remoteInbound?.audioRoundTripTimeMs != null)
      base.remoteInbound.audioRoundTripTimeMs = s.remoteInbound.audioRoundTripTimeMs;
    if (s.remoteInbound?.videoRoundTripTimeMs != null)
      base.remoteInbound.videoRoundTripTimeMs = s.remoteInbound.videoRoundTripTimeMs;

    base.transport.bytesSent += s.transport?.bytesSent || 0;
    base.transport.bytesReceived += s.transport?.bytesReceived || 0;
    if (s.transport?.dtlsState) base.transport.dtlsState = s.transport.dtlsState;
  }

  if (rttList.length > 0) {
    base.candidatePair.currentRoundTripTimeMs =
      rttList.reduce((a, b) => a + b, 0) / rttList.length;
  }
  if (aobList.length > 0) {
    base.candidatePair.availableOutgoingBitrate =
      aobList.reduce((a, b) => a + b, 0) / aobList.length;
  }

  return base;
}

async function collectWebRTCSummary(page) {
  const frames = page.frames();
  const parts = [];
  for (const frame of frames) {
    try {
      const one = await collectStatsFromSingleFrame(frame);
      if (one) parts.push(one);
    } catch {
      /* detached frame */
    }
  }
  if (!parts.length) return emptyWebRtcSummary();
  return mergeWebRtcSummaries(parts);
}

async function collectWebRTCSummaryFromBrowser(browser) {
  const pages = await allPageTargets(browser);
  const parts = [];
  for (const p of pages) {
    try {
      const s = await collectWebRTCSummary(p);
      if (s) parts.push(s);
    } catch {
      /* página fechada / race */
    }
  }
  if (!parts.length) return emptyWebRtcSummary();
  return mergeWebRtcSummaries(parts);
}

async function runVirtualUser(userId) {
  emit({
    type: "telemetry",
    event: "user_start",
    userId,
    ts: new Date().toISOString()
  });

  const browser = await puppeteer.launch({
    headless: shouldOpenBrowser ? false : "new",
    acceptInsecureCerts: ignoreHttpsErrors,
    slowMo: Number.isFinite(slowMo) ? Math.max(slowMo, 0) : 0,
    args: [
      "--no-sandbox",
      "--disable-extensions",
      "--disable-extensions-file-access-check",
      // Reduz iframes em processo separado (Jitsi + hook RTCPeerConnection).
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-site-isolation-trials",
      ...(disableQuic ? ["--disable-quic"] : []),
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream"
    ]
  });

  browser.on("targetcreated", (target) => {
    void (async () => {
      try {
        if (isJitsiHost(apiUrl)) {
          const p = await target.page();
          if (p?.setBypassCSP) await p.setBypassCSP(true).catch(() => {});
        }
      } catch {
        /* */
      }
      await attachRtcHookToTarget(target);
    })();
  });

  let statsTimer = null;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    if (isJitsiHost(apiUrl) && page.setBypassCSP) {
      await page.setBypassCSP(true).catch(() => {});
    }

    await attachRtcHookViaCDP(page);

    page.on("request", (request) => {
      emit({
        type: "telemetry",
        event: "request",
        userId,
        method: request.method(),
        url: request.url().slice(0, 800),
        resourceType: request.resourceType(),
        ts: new Date().toISOString()
      });
    });

    page.on("response", (response) => {
      emit({
        type: "telemetry",
        event: "response",
        userId,
        status: response.status(),
        url: response.url().slice(0, 800),
        ts: new Date().toISOString()
      });
    });

    page.on("requestfailed", (request) => {
      emit({
        type: "telemetry",
        event: "request_failed",
        userId,
        url: request.url().slice(0, 800),
        errorText: request.failure()?.errorText || "unknown",
        ts: new Date().toISOString()
      });
    });

    // Meet público não usa este header; enviá-lo em todos os pedidos pode estragar fluxos do Jitsi.
    if (!isJitsiHost(apiUrl)) {
      await page.setExtraHTTPHeaders({
        Authorization: `Bearer ${accessToken}`
      });
    }

    const tick = Math.max(1000, statsIntervalMs);
    let probeTicks = 0;
    statsTimer = setInterval(async () => {
      try {
        if (isJitsiHost(apiUrl)) {
          await injectRtcHookEverywhere(browser);
        }
        const summary = isJitsiHost(apiUrl)
          ? await collectWebRTCSummaryFromBrowser(browser)
          : await collectWebRTCSummary(page);
        emit({
          type: "telemetry",
          event: "webrtc_stats",
          userId,
          ts: new Date().toISOString(),
          summary: summary || emptyWebRtcSummary()
        });
        if (isJitsiHost(apiUrl) && probeTicks < 8 && (summary?.peerConnections || 0) === 0) {
          probeTicks += 1;
          const probe = await probeWebRtcBrowser(browser);
          emit({
            type: "telemetry",
            event: "webrtc_probe",
            userId,
            ts: new Date().toISOString(),
            probe
          });
        }
      } catch {
        /* page may be navigating */
      }
    }, tick);

    await page.goto(apiUrl, {
      waitUntil: "domcontentloaded",
      timeout: 90000
    });

    await delay(isJitsiHost(apiUrl) ? 2500 : 1500);

    if (isJitsiHost(apiUrl)) {
      const entered = await tryJitsiEnterConference(page);
      emit({
        type: "telemetry",
        event: "jitsi_prejoin",
        userId,
        clickedJoin: entered,
        ts: new Date().toISOString()
      });
      if (!entered) {
        emit({
          type: "telemetry",
          event: "jitsi_hint",
          userId,
          message:
            "Não foi possível clicar em Entrar automaticamente. Use PUPPETEER_HEADFUL=1 ou abra a sala no navegador e confira o nome do botão na pré-sala.",
          ts: new Date().toISOString()
        });
      } else {
        for (let wave = 0; wave < 5; wave++) {
          await delay(2000);
          await injectRtcHookEverywhere(browser);
        }
        emit({
          type: "telemetry",
          event: "jitsi_hint",
          userId,
          message:
            "Se WebRTC no dashboard continuar zerado: use PUPPETEER_HEADFUL=1, entre com outro navegador na mesma sala e ignore net::ERR_FAILED em ficheiros .wasm/e2ee se o áudio/vídeo subir.",
          ts: new Date().toISOString()
        });
      }
    }

    const jitsiMinDwell = 28000;
    const stay = Math.max(2000, isJitsiHost(apiUrl) ? Math.max(dwellMs, jitsiMinDwell) : dwellMs);
    await delay(stay);

    emit({
      type: "telemetry",
      event: "user_done",
      userId,
      ts: new Date().toISOString()
    });
  } finally {
    if (statsTimer) clearInterval(statsTimer);
    await browser.close();
  }
}

const batchSize = Math.min(4, Math.max(1, virtualUsers));

emit({
  type: "telemetry",
  event: "test_start",
  virtualUsers,
  batchSize,
  targetUrl: apiUrl,
  ts: new Date().toISOString()
});

for (let start = 1; start <= virtualUsers; start += batchSize) {
  const end = Math.min(start + batchSize - 1, virtualUsers);
  const tasks = [];
  for (let userId = start; userId <= end; userId++) {
    tasks.push(runVirtualUser(userId));
  }
  await Promise.all(tasks);
}

emit({
  type: "telemetry",
  event: "test_complete",
  virtualUsers,
  ts: new Date().toISOString()
});
