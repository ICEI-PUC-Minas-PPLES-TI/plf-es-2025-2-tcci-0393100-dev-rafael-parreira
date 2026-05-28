import puppeteer from "puppeteer";
import { createCursor } from "ghost-cursor";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const runtimeConfig = isMainThread
  ? {
      apiUrl: process.argv[2],
      accessToken: process.argv[3],
      virtualUsers: process.argv[4]
    }
  : workerData || {};
const apiUrl = runtimeConfig.apiUrl;
const accessToken = runtimeConfig.accessToken;
const virtualUsersArg = runtimeConfig.virtualUsers;
const virtualUsers = Number.parseInt(virtualUsersArg || "1", 10);
const shouldOpenBrowser = process.env.PUPPETEER_HEADFUL === "1";
const ignoreHttpsErrors = process.env.PUPPETEER_IGNORE_HTTPS_ERRORS === "1";
const disableQuic = process.env.PUPPETEER_DISABLE_QUIC === "1";
const slowMo = Number.parseInt(process.env.PUPPETEER_SLOW_MO || "0", 10);
const statsIntervalMs = Number.parseInt(process.env.WEBRTC_STATS_INTERVAL_MS || "2000", 10);
/** Com vários VUs, só inject em 1 de cada N *ticks* (1 = nunca pular) — alivia CDP. */
const webrtcInjectEveryNTicks = Math.max(1, Number.parseInt(process.env.WEBRTC_INJECT_EVERY_N_TICKS || "1", 10) || 1);
const dwellMs = Number.parseInt(process.env.AUDIT_PAGE_DWELL_MS || "8000", 10);
const jitsiUseGhostCursor =
  process.env.JITSI_USE_GHOST_CURSOR === undefined || process.env.JITSI_USE_GHOST_CURSOR !== "0";

/**
 * Login automático (Google / formulário) — **opção opt-in** (`JITSI_AUTH_ENABLED=1`).
 * No `meet.jit.si` como convidado normalmente *não* há botão "Sign in" visível; com credenciais
 * no .env e sem ativar, o runner **não** tenta login (evita o aviso "falhou (none)").
 */
const jitsiAuthEnabled = process.env.JITSI_AUTH_ENABLED === "1" || process.env.JITSI_AUTH_ENABLED === "true";
const jitsiAuthEmail = (process.env.JITSI_AUTH_EMAIL || "").trim();
const jitsiAuthPassword = (process.env.JITSI_AUTH_PASSWORD || "").trim();
/** Só usado com `1` — no meet.jit.si o formulário in-page quase nunca é login; o default evita tocar em campos errados. */
const jitsiAuthInPageEnabled = process.env.JITSI_AUTH_IN_PAGE === "1";
/** Com `PUPPETEER_HEADFUL=1`, tenta abrir painel Sign in / conta e pausa para inspecionares a UI. */
const jitsiDebugLoginUI =
  process.env.JITSI_DEBUG_LOGIN_UI === "1" || process.env.JITSI_DEBUG_LOGIN_UI === "true";
const jitsiDebugPauseMsEnv = process.env.JITSI_DEBUG_PAUSE_MS;
const jitsiDebugPauseMsExplicit =
  jitsiDebugPauseMsEnv !== undefined && String(jitsiDebugPauseMsEnv).trim() !== ""
    ? Math.max(0, Number.parseInt(String(jitsiDebugPauseMsEnv), 10) || 0)
    : null;

/** Após "Entrar": espera o diálogo "Sou o anfitrião" / "I am the host" (abre o Google). `0` = não esperar. */
const jitsiHostButtonWaitSecEnv = process.env.JITSI_HOST_BUTTON_WAIT_SEC;
const jitsiHostButtonSkip =
  jitsiHostButtonWaitSecEnv !== undefined && String(jitsiHostButtonWaitSecEnv).trim() === "0";
const jitsiHostButtonWaitSec = jitsiHostButtonSkip
  ? 0
  : Math.min(
      180,
      Math.max(
        5,
        Number.parseInt(
          jitsiHostButtonWaitSecEnv !== undefined && String(jitsiHostButtonWaitSecEnv).trim() !== ""
            ? String(jitsiHostButtonWaitSecEnv)
            : jitsiAuthEnabled && jitsiAuthEmail && jitsiAuthPassword
              ? "90"
              : "25",
          10
        ) || 25
      )
    );
/** Subcadeia opcional (ex.: "anfitri" ou "host") se o teu Jitsi usar texto diferente. */
const jitsiHostButtonContains = (process.env.JITSI_HOST_BUTTON_CONTAINS || "").trim();

/**
 * Após clicar em «Sou o anfitrião» (abre o Google) e/ou após o runner preencher o Google:
 * a conferência e os RTCPeerConnection só existem *depois* de o Meet voltar à sala.
 */
const jitsiPostHostAuthDelayMs = Math.max(0, Number.parseInt(process.env.JITSI_POST_HOST_AUTH_DELAY_MS || "5000", 10) || 5000);
const zoomDisplayName = (process.env.ZOOM_DISPLAY_NAME || "Stream Sentry Bot").trim();
const zoomPasscode = (process.env.ZOOM_PASSCODE || "").trim();
const zoomUseAccessTokenAsPasscode = process.env.ZOOM_USE_ACCESS_TOKEN_AS_PASSCODE === "1";
const wherebyDisplayName = (process.env.WHEREBY_DISPLAY_NAME || "Stream Sentry Bot").trim();

/**
 * Clicar em «Eu sou o anfitrião» abre o Google; sem completar o login ficas bloqueado.
 * Por omissão: reivindica anfitrião **só** se `JITSI_AUTH_*` e `JITSI_AUTH_ENABLED=1` (fluxo anfitrião+Google).
 * Forçar: `JITSI_CLAIM_HOST=1` (sempre tenta o botão) ou `=0` (nunca, perfil convidado).
 * `JITSI_GUEST_MODE=1` é equivalente a `JITSI_CLAIM_HOST=0` + tentar convidado/dispensar o diálogo.
 */
const jitsiClaimHostExplicit = process.env.JITSI_CLAIM_HOST;
const jitsiGuestModeFlag =
  process.env.JITSI_GUEST_MODE === "1" || process.env.JITSI_SKIP_I_AM_HOST === "1" || jitsiClaimHostExplicit === "0";
const jitsiClaimHost = jitsiGuestModeFlag
  ? false
  : jitsiClaimHostExplicit === "1" || jitsiClaimHostExplicit === "true"
    ? true
    : jitsiAuthEnabled && jitsiAuthEmail && jitsiAuthPassword;

const poolSpawnGapMs = Number.parseInt(process.env.POOL_SPAWN_GAP_MS || "600", 10);
const poolStateDebugMs = Number.parseInt(process.env.POOL_STATE_DEBUG_MS || "0", 10);
const muteAudioForLoad = process.env.PUPPETEER_MUTE_AUDIO === "1";
const disableDevShm = process.env.PUPPETEER_DISABLE_DEV_SHM === "1";
const extraChromeArgs = (process.env.PUPPETEER_EXTRA_CHROME_ARGS || "")
  .split(/[,\n]+/)
  .map((s) => s.trim())
  .filter(Boolean);

/** Se `1`, não desliga o *site isolation* (por omissão desligamos para o hook alcançar iframes Jitsi). */
const preserveSiteIsolation = process.env.PUPPETEER_PRESERVE_SITE_ISOLATION === "1";
/** Teto de `Page` alvo a inspecionar por browser (muitos targets CDP = ticks lentos / timeouts). */
const maxJitsiHookPages = Math.min(16, Math.max(2, Number.parseInt(process.env.JITSI_MAX_HOOK_PAGES || "10", 10) || 10));

function buildChromiumArgs() {
  return [
    "--no-sandbox",
    "--disable-extensions",
    "--disable-extensions-file-access-check",
    // Reduz iframes em processo separado (Jitsi + hook RTCPeerConnection). Opcional: PUPPETEER_PRESERVE_SITE_ISOLATION=1
    ...(preserveSiteIsolation
      ? []
      : [
          "--disable-features=IsolateOrigins,site-per-process",
          "--disable-site-isolation-trials"
        ]),
    ...(disableQuic ? ["--disable-quic"] : []),
    ...(disableDevShm ? ["--disable-dev-shm-usage"] : []),
    ...(muteAudioForLoad ? ["--mute-audio"] : []),
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    ...extraChromeArgs
  ];
}

/** Concorrência dinâmica (pool): ativar com STREAM_SENTRY_POOL=1 — mantém N utilizadores até parar o teste. */
const streamSentryPool =
  process.env.STREAM_SENTRY_POOL === "1" || process.env.STREAM_SENTRY_POOL === "true";
/** Isola cada VU em uma Worker Thread; desligar com STREAM_SENTRY_WORKER_THREADS=0. */
const useWorkerThreads =
  isMainThread && process.env.STREAM_SENTRY_WORKER_THREADS !== "0" && process.env.STREAM_SENTRY_WORKER_THREADS !== "false";

const sessionIdEnv = runtimeConfig.sessionId || process.env.TEST_SESSION_ID || "";
const testStartedAtMs = (() => {
  const raw = runtimeConfig.testStartedAt || process.env.TEST_STARTED_AT;
  if (!raw) return Date.now();
  const d = Date.parse(raw);
  return Number.isNaN(d) ? Date.now() : d;
})();

function controlFilePath() {
  return path.join(process.cwd(), "puppeteer", "control.json");
}

function readControlSync() {
  try {
    const raw = fs.readFileSync(controlFilePath(), "utf8");
    const j = JSON.parse(raw);
    return {
      paused: Boolean(j.paused),
      targetVirtualUsers: Number.isFinite(Number(j.targetVirtualUsers))
        ? Math.min(50, Math.max(1, Number(j.targetVirtualUsers)))
        : virtualUsers,
      chaos: { profile: typeof j.chaos?.profile === "string" ? j.chaos.profile : "off" }
    };
  } catch {
    return {
      paused: false,
      targetVirtualUsers: virtualUsers,
      chaos: { profile: "off" }
    };
  }
}

function elapsedSec() {
  return (Date.now() - testStartedAtMs) / 1000;
}

const lastChaosByBrowser = new WeakMap();
let flakyToggle = false;

function normalizeProfileKey(profileRaw) {
  let k = String(profileRaw || "off")
    .toLowerCase()
    .replace(/-/g, "_");
  if (k === "slow3g") return "slow_3g";
  if (k === "fast3g") return "fast_3g";
  return k;
}

/** Uma decisão de toggle por *tick* (todos os browsers partilham o mesmo estado em flaky). */
function resolveEffectivePresetKey(profileRaw) {
  const k = normalizeProfileKey(profileRaw);
  if (k === "flaky") {
    flakyToggle = !flakyToggle;
    return flakyToggle ? "offline" : "fast_3g";
  }
  return k;
}

function networkPresets() {
  return {
    off: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
    none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
    slow_3g: { offline: false, latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 },
    fast_3g: { offline: false, latency: 150, downloadThroughput: (1800 * 1024) / 8, uploadThroughput: (850 * 1024) / 8 },
    high_latency: {
      offline: false,
      latency: 850,
      downloadThroughput: (350 * 1024) / 8,
      uploadThroughput: (350 * 1024) / 8
    },
    offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
    dns_failure: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }
  };
}

async function applyPresetToBrowser(browser, profileRaw, effectiveKey) {
  const mapKey = `${String(profileRaw)}:${effectiveKey}`;
  if (lastChaosByBrowser.get(browser) === mapKey) return;
  lastChaosByBrowser.set(browser, mapKey);

  const presets = networkPresets();
  const p = presets[effectiveKey] || presets.off;
  try {
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    const client = await page.createCDPSession();
    await client.send("Network.enable");
    await client.send("Network.emulateNetworkConditions", {
      offline: p.offline,
      latency: p.latency,
      downloadThroughput: p.downloadThroughput,
      uploadThroughput: p.uploadThroughput,
      connectionType: "ethernet"
    });
  } catch {
    /* CDP indisponível */
  }
}

const activeBrowsers = new Set();

async function applyChaosToAllBrowsers(profileRaw) {
  const eff = resolveEffectivePresetKey(profileRaw);
  const raw = String(profileRaw || "off");
  for (const b of activeBrowsers) {
    try {
      if (b.isConnected()) await applyPresetToBrowser(b, raw, eff);
    } catch {
      activeBrowsers.delete(b);
    }
  }
}

async function dwellWithControls(ms, opts) {
  const signal = opts?.signal;
  const getControl = typeof opts?.getControl === "function" ? opts.getControl : readControlSync;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (signal?.aborted) return;
    let c = getControl();
    while (c.paused && !signal?.aborted) {
      await delay(400);
      c = getControl();
    }
    if (signal?.aborted) return;
    const step = Math.min(400, end - Date.now());
    if (step <= 0) break;
    await delay(step);
  }
}

const accessTokenRequired = !isWhereby(apiUrl || "");
if (!apiUrl || (accessTokenRequired && !accessToken) || Number.isNaN(virtualUsers)) {
  console.error("Missing required arguments: apiUrl accessToken virtualUsers");
  process.exit(1);
}

function writeTelemetryPayload(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function emit(obj) {
  const payload = {
    ...obj,
    ...(sessionIdEnv ? { sessionId: sessionIdEnv } : {}),
    elapsedSec: elapsedSec(),
    ts: obj.ts || new Date().toISOString()
  };
  if (!isMainThread && parentPort) {
    parentPort.postMessage({ kind: "telemetry", payload });
    return;
  }
  writeTelemetryPayload(payload);
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
        if (pc.connectionState === "closed") {
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
      wrap("getStats");
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

/**
 * Em alguns alvos OOPIF / segundo `Page`, `page.frames()` vem vazio; o `mainFrame()` ainda permite inject + getStats.
 */
function getFramesForPage(page) {
  const list = page.frames();
  if (list && list.length > 0) return list;
  try {
    const mf = page.mainFrame();
    return mf ? [mf] : [];
  } catch {
    return [];
  }
}

/** Reaplica o hook em todos os frames já carregados (lib-jitsi pode carregar depois do CDP inicial). */
async function injectRtcHookIntoAllFrames(page) {
  for (const frame of getFramesForPage(page)) {
    try {
      await frame.evaluate(installStreamSentryRtcHook);
    } catch {
      /* frame destacado / cross-origin sem execução */
    }
  }
}

/** Conta PCs e frames numa única Page (vários Frame no mesmo processo). */
async function probeWebRtcFrames(page) {
  const frames = getFramesForPage(page);
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
 * Todas as `Page` do browser (Jitsi em OOPIF / targets variados: não filtrar por
 * `target.type()` — nalguns builds o alvo do iframe não é exactamente "iframe"/"page"
 * e deixaríamos de amostrar a frame onde ocorre o WebRTC.
 */
async function allPageTargets(browser) {
  const out = [];
  const seenPage = new Set();
  for (const target of browser.targets()) {
    try {
      const p = await target.page();
      if (!p || seenPage.has(p)) continue;
      seenPage.add(p);
      out.push(p);
    } catch {
      /* worker, service_worker, etc. */
    }
  }
  return out.length > maxJitsiHookPages ? out.slice(0, maxJitsiHookPages) : out;
}

async function injectRtcHookEverywhere(browser) {
  try {
    const pages = await allPageTargets(browser);
    for (const p of pages) {
      try {
        await injectRtcHookIntoAllFrames(p);
      } catch {
        /* página a fechar / corrida */
      }
    }
  } catch {
    /* browser a encerrar */
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

/**
 * Clique com movimento de rato “humano” (ghost-cursor) — ajuda em UIs que ignoram el.click() síncrono.
 */
async function tryGhostCursorClickJitsiJoin(page) {
  if (!jitsiUseGhostCursor) return false;
  try {
    const cursor = createCursor(page);
    const selectors = [
      '[data-testid="prejoin.joinButton"]',
      '[data-testid="lobby.joinButton"]',
      '[data-testid="prejoin.joinMeeting"]',
      'button[aria-label="Join meeting"]',
      'button[aria-label*="Join meeting" i]',
      'button[aria-label*="Entrar" i]',
      "#jitsi_prejoin_join_button",
      "button.join-meeting"
    ];
    for (const sel of selectors) {
      const h = await page.$(sel);
      if (!h) continue;
      const box = await h.boundingBox();
      if (box && box.width > 2 && box.height > 2) {
        await cursor.click(h);
        await h.dispose();
        return true;
      }
      await h.dispose();
    }
  } catch {
    /* elemento destacado / navegação */
  }
  return false;
}

/**
 * Diálogo pós-join (sala com autenticação de moderador / meet.jit.si): "I am the host" / "Sou o anfitrião" → abre o login.
 */
async function tryGhostCursorClickJitsiHostButton(page) {
  if (!jitsiUseGhostCursor) return false;
  if (jitsiHostButtonContains) {
    try {
      const clicked = await page.evaluate((hint) => {
        if (!hint) return false;
        const s = String(hint).toLowerCase();
        const inDialog = document.querySelectorAll(
          "div[role=dialog] button, [role=dialog] button, [role=dialog] [role=button], .jitsi-dialog button"
        );
        for (const b of inDialog) {
          const t = (b.textContent || "").toLowerCase();
          const a = (b.getAttribute("aria-label") || "").toLowerCase();
          if (t.includes(s) || a.includes(s)) {
            b.scrollIntoView({ block: "center" });
            b.click();
            return true;
          }
        }
        return false;
      }, jitsiHostButtonContains);
      if (clicked) return true;
    } catch {
      /* */
    }
  }
  try {
    const cursor = createCursor(page);
    const selectors = [
      '[data-testid="modal-dialog-ok-button"]',
      '[data-testid="ok-button"]',
      "button[aria-label=\"I am the host\" i]",
      "button[aria-label*=\"I’m the host\" i]",
      "button[aria-label*=\"anfitri\" i]",
      "button[aria-label*=\"the host\" i]",
      "div[role=dialog] button.jitsi-button--primary"
    ];
    for (const sel of selectors) {
      const h = await page.$(sel);
      if (!h) continue;
      const box = await h.boundingBox();
      if (box && box.width > 2 && box.height > 2) {
        await cursor.click(h);
        await h.dispose();
        return true;
      }
      await h.dispose();
    }
  } catch {
    /* */
  }
  return false;
}

/**
 * Clica o botão de anfitrião/moderador após o join, quando a UI carrega o diálogo (≈1–90s).
 * Deve ser chamado *depois* de tryJitsiEnterConference, *antes* do login Google.
 */
async function tryJitsiClickAfterJoinHostButton(page, userId) {
  if (jitsiHostButtonWaitSec <= 0) {
    emit({
      type: "telemetry",
      event: "jitsi_host_button",
      userId,
      skipped: true,
      message: "JITSI_HOST_BUTTON_WAIT_SEC=0 — a saltar a espera pelo botão de anfitrião."
    });
    return false;
  }
  const gapMs = 600;
  const maxAttempts = Math.max(8, Math.ceil((jitsiHostButtonWaitSec * 1000) / gapMs));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const r = await page
      .evaluate((hint) => {
        const seen = new Set();
        const clickIfVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none")
            return false;
          const r0 = el.getBoundingClientRect();
          if (r0.width < 2 || r0.height < 2) return false;
          el.scrollIntoView({ block: "center", inline: "center" });
          el.click();
          return true;
        };

        function isHostOrModeratorLabel(h) {
          const s = h.toLowerCase();
          if (s.length > 200) return false;
          if (/\b(leave|hang up|sair|cancel|voltar|back)\b/i.test(s) && s.length < 36 && !/host|anfitri|moderad/.test(s))
            return false;
          if (/\bjoin meeting\b|\bentrar na reuni(n|ã)o\b|\bentrar agora\b/.test(s) && !/host|anfitri|moderad/.test(s))
            return false;
          if (hint) {
            const h2 = String(hint).toLowerCase();
            if (s.includes(h2)) return true;
          }
          return (
            /\b(i['\u2019]m\s+the\s+host|i\s+am\s+the\s+host|i['\u2019]m\s+the\s+moderator|i\s+am\s+the\s+moderator)\b/i.test(
              s
            ) ||
            /\b(sou\s+o\s+anfitri|eu\s+sou\s+o\s+anfitri|sou\s+o\s+moderador|sou\s+anfitri)\b/i.test(s) ||
            /\b(soy\s+el\s+anfitr|soy\s+el\s+moderador|soy\s+el\s+anfitr)\b/i.test(s) ||
            /\b(claim|reivindic).{0,24}(moderat|host|anfitr)/i.test(s) ||
            /\blog\s+in\s+as\s+host\b/i.test(s)
          );
        }

        function walk(doc, depth) {
          if (!doc || depth > 12) return null;
          if (seen.has(doc)) return null;
          seen.add(doc);
          const candidates = doc.querySelectorAll(
            "button, [role=button], input[type=submit], a[role=button], a.jitsi-button"
          );
          for (const b of candidates) {
            const t = (b.innerText || b.textContent || b.value || "").trim();
            const al = (b.getAttribute("aria-label") || "").trim();
            const title = (b.getAttribute("title") || "").trim();
            const hay = `${t} ${al} ${title}`.replace(/\s+/g, " ");
            if (isHostOrModeratorLabel(hay) && t.length < 200) {
              if (clickIfVisible(b)) return { clicked: true, how: "text", label: t.slice(0, 60) || al.slice(0, 60) };
            }
          }
          const iframes = doc.querySelectorAll("iframe");
          for (const iframe of iframes) {
            try {
              const ch = iframe.contentDocument;
              if (ch) {
                const w = walk(ch, depth + 1);
                if (w) return w;
              }
            } catch {
              /* cross-origin */
            }
          }
          return null;
        }

        return walk(document, 0) || { clicked: false };
      }, jitsiHostButtonContains)
      .catch((e) => ({ clicked: false, error: String(e?.message || e) }));

    if (r && r.clicked) {
      await delay(900);
      emit({
        type: "telemetry",
        event: "jitsi_host_button",
        userId,
        ok: true,
        method: r.how || "text",
        label: r.label,
        attempt: attempt + 1
      });
      return true;
    }
    if (attempt % 3 === 2) {
      if (await tryGhostCursorClickJitsiHostButton(page)) {
        await delay(900);
        emit({
          type: "telemetry",
          event: "jitsi_host_button",
          userId,
          ok: true,
          method: "ghost",
          attempt: attempt + 1
        });
        return true;
      }
    }
    await delay(gapMs);
  }
  emit({
    type: "telemetry",
    event: "jitsi_host_button",
    userId,
    ok: false,
    attempts: maxAttempts,
    message: "Não encontrou o botão de anfitrião/moderador. Defina JITSI_HOST_BUTTON_CONTAINS ou aumente JITSI_HOST_BUTTON_WAIT_SEC (headful se necessário)."
  });
  return false;
}

/**
 * Quando `JITSI_CLAIM_HOST=0` (ou sem `JITSI_AUTH_*`): **não** clica em «Sou o anfitrião».
 * Tenta «continuar como convidado» / equivalente, ou **Cancel/Voltar** no diálogo de anfitrião (UI dependente).
 */
async function tryJitsiGuestOrDismissHostDialog(page, userId) {
  const gapMs = 600;
  const maxAttempts = 40;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const r = await page
      .evaluate(() => {
        const inDialog = (el) => el && el.closest && (el.closest("[role=dialog]") || el.closest(".jitsi-dialog"));

        const clickIfVisible = (el) => {
          if (!el) return false;
          const st = window.getComputedStyle(el);
          if (st.display === "none" || st.visibility === "hidden" || st.pointerEvents === "none")
            return false;
          const r0 = el.getBoundingClientRect();
          if (r0.width < 2 || r0.height < 2) return false;
          el.scrollIntoView({ block: "center", inline: "center" });
          el.click();
          return true;
        };

        const candidates = document.querySelectorAll("button, [role=button], a[role=button], .jitsi-button");
        for (const b of candidates) {
          if (!inDialog(b)) continue;
          const t = (b.innerText || b.textContent || "").trim();
          const al = (b.getAttribute("aria-label") || "").trim();
          const hay = `${t} ${al}`.toLowerCase();
          if (hay.length > 180) continue;
          if (
            /\b(continue|join)\s+as\s+guest\b/i.test(hay) ||
            /continu.*(como|com)\s*convidad|entrar como convid|como convid|participar.*convid|sem (fazer|iniciar) sess(ã|a)o|without signing/i.test(
              hay
            ) ||
            /^convidad(o|a)?$/i.test(t)
          ) {
            if (clickIfVisible(b)) return { how: "guest", label: t.slice(0, 80) || al.slice(0, 80) };
          }
        }
        for (const b of candidates) {
          if (!inDialog(b)) continue;
          const t = (b.innerText || b.textContent || "").trim();
          const d = b.closest("[role=dialog], .jitsi-dialog, [role=alertdialog]");
          if (!d) continue;
          const dialogText = (d.textContent || "").toLowerCase();
          if (!/(anfitri|host|moderat|dono|owner|sign in|iniciar sess|google)/i.test(dialogText)) continue;
          if (
            t.length < 40 &&
            /^(cancel|voltar|back|not now|no thanks|fechar|close|mais tarde|later)$/i.test(t)
          ) {
            if (clickIfVisible(b)) return { how: "dismiss", label: t };
          }
        }
        return null;
      })
      .catch((e) => ({ error: String(e?.message || e) }));

    if (r && r.how) {
      await delay(900);
      emit({
        type: "telemetry",
        event: "jitsi_guest_path",
        userId,
        ok: true,
        method: r.how,
        label: r.label,
        attempt: attempt + 1
      });
      return true;
    }
    await delay(gapMs);
  }
  emit({
    type: "telemetry",
    event: "jitsi_guest_path",
    userId,
    ok: false,
    message:
      "Perfil sem reivindicar anfitrião: não encontrei convidado/cancel. Se a política da sala exigir anfitrião, use JITSI_CLAIM_HOST=1 e JITSI_AUTH_*, ou PUPPETEER_HEADFUL=1."
  });
  return false;
}

/**
 * Formulário e-mail+senha na *welcome* (self-hosted), antes de entrar — só com JITSI_AUTH_IN_PAGE=1.
 */
async function tryJitsiInPagePasswordLogin(page, userId) {
  if (!jitsiAuthEnabled || !jitsiAuthEmail || !jitsiAuthPassword) {
    return;
  }
  if (!jitsiAuthInPageEnabled) {
    return;
  }
  emit({ type: "telemetry", event: "jitsi_auth_attempt", userId, provider: "env", phase: "in_page" });
  try {
    if (await tryInPageEmailPasswordForm(page, jitsiAuthEmail, jitsiAuthPassword)) {
      emit({ type: "telemetry", event: "jitsi_auth_result", userId, ok: true, method: "in_page_form" });
    } else {
      emit({
        type: "telemetry",
        event: "jitsi_auth_result",
        userId,
        ok: false,
        method: "in_page_form",
        message: "sem campos e-mail+senha visíveis (normal no meet.jit.si; use login pós-join com Google)"
      });
    }
  } catch (e) {
    emit({
      type: "telemetry",
      event: "jitsi_auth_result",
      userId,
      ok: false,
      method: "in_page_form",
      message: String(e?.message || e).slice(0, 200)
    });
  }
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

function isZoomHost(urlStr) {
  try {
    const h = new URL(urlStr).hostname.toLowerCase();
    return h === "zoom.us" || h.endsWith(".zoom.us") || h === "zoom.com" || h.endsWith(".zoom.com");
  } catch {
    return false;
  }
}

function isWhereby(urlStr) {
  try {
    const h = new URL(urlStr).hostname.toLowerCase();
    return h === "whereby.com" || h.endsWith(".whereby.com");
  } catch {
    return false;
  }
}

function isMultiPageRtcHost(urlStr) {
  return isJitsiHost(urlStr) || isZoomHost(urlStr) || isWhereby(urlStr);
}

function normalizeZoomJoinUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!isZoomHost(urlStr)) return urlStr;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "j" && parts[1]) {
      u.pathname = `/wc/join/${parts[1]}`;
      return u.toString();
    }
    return urlStr;
  } catch {
    return urlStr;
  }
}

async function tryInPageEmailPasswordForm(page, email, password) {
  try {
    const emailField =
      (await page.$('input[type="email"]')) ||
      (await page.$('input[autocomplete="username"]')) ||
      (await page.$('input[name="username"]')) ||
      (await page.$('input[name="email"]'));
    const passField = await page.$('input[type="password"]');
    if (!emailField || !passField) return false;
    await emailField.click({ clickCount: 3 });
    await emailField.type(email, { delay: 12 });
    await passField.type(password, { delay: 12 });
    const submit = await page.$("button[type='submit'], input[type='submit']");
    if (submit) await submit.click();
    else await page.keyboard.press("Enter");
    await delay(2500);
    return true;
  } catch {
    return false;
  }
}

function tryClickGoogleOrSignInOpenerInDocument() {
  const g = document.querySelector('a[href*="accounts.google.com"]');
  if (g) {
    g.click();
    return "google_href";
  }
  const candidates = [...document.querySelectorAll("a, button, [role='button']")];
  for (const el of candidates) {
    const t = (el.textContent || "").trim().toLowerCase();
    const al = (el.getAttribute("aria-label") || "").toLowerCase();
    const hay = `${t} ${al}`;
    if (/\b(google|gmail)\b/.test(hay) && (/\bsign in\b/.test(hay) || /\blog in\b/.test(hay))) {
      el.click();
      return "google_cta";
    }
    if ((t === "sign in" || t === "log in" || al === "sign in" || al === "log in") && t.length < 40) {
      el.click();
      return "sign_in";
    }
  }
  return "";
}

async function tryOpenJitsiSignInEntry(page) {
  return page.evaluate(tryClickGoogleOrSignInOpenerInDocument);
}

async function getGoogleSignInPage(browser, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = await browser.pages();
    for (const p of pages) {
      try {
        const u = p.url();
        if (
          (u.includes("accounts.google.com") || u.includes("id.google.com")) &&
          (u.includes("signin") || u.includes("ServiceLogin") || u.includes("oauth") || u.includes("o/oauth2") || u.includes("challenge"))
        ) {
          return p;
        }
      } catch {
        /* */
      }
    }
    await delay(200);
  }
  return null;
}

async function fillGoogleSignInPage(googlePage, email, password) {
  await googlePage.bringToFront().catch(() => {});
  await googlePage
    .waitForSelector("#identifierId, input[name='identifierId'], input[type='email']", { timeout: 25000, visible: true })
    .catch(() => null);
  const idInput =
    (await googlePage.$("#identifierId")) ||
    (await googlePage.$('input[name="identifierId"]')) ||
    (await googlePage.$('input[type="email"]'));
  if (!idInput) return "no_email_field";
  await idInput.type(email, { delay: 15 });
  await delay(400);
  const idNext = await googlePage.$("#identifierNext");
  if (idNext) await idNext.click();
  else await googlePage.keyboard.press("Enter");
  await delay(2500);
  const u = googlePage.url();
  if (u.includes("challenge/") && !u.includes("password")) {
    return "2fa_or_challenge";
  }
  const passInput =
    (await googlePage.$("input[name='Passwd']")) || (await googlePage.$('input[name="password"]')) || (await googlePage.$("input[type='password']"));
  if (!passInput) {
    if (u.includes("myaccount.google.com") || u.includes("signin/chooser")) {
      return "ok_maybe_already";
    }
    return "no_password_field";
  }
  await passInput.type(password, { delay: 15 });
  await delay(400);
  const passNext = (await googlePage.$("#passwordNext")) || (await googlePage.$("button[type='submit']"));
  if (passNext) await passNext.click();
  else await googlePage.keyboard.press("Enter");
  await delay(5000);
  if (googlePage.url().includes("challenge/")) {
    return "2fa_or_challenge";
  }
  return "ok";
}

/**
 * Após o join (e idealmente após "Sou o anfitrião"), abre Sign in e preenche o Google.
 * O formulário e-mail+senha na welcome usa tryJitsiInPagePasswordLogin (antes do join) com JITSI_AUTH_IN_PAGE=1.
 */
async function tryJitsiServiceLogin(page, browser, userId) {
  if (!jitsiAuthEnabled) {
    return { ok: false, reason: "auth_disabled" };
  }
  if (!jitsiAuthEmail || !jitsiAuthPassword) {
    return { ok: false, reason: "not_configured" };
  }
  emit({ type: "telemetry", event: "jitsi_auth_attempt", userId, provider: "env", phase: "google" });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await delay(2000);
    const clicked = await tryOpenJitsiSignInEntry(page);
    if (!clicked) {
      if (attempt === 0) continue;
      break;
    }
    await delay(1000);
    const gPage = await getGoogleSignInPage(browser, 20000);
    if (!gPage) {
      if (attempt === 1) {
        emit({
          type: "telemetry",
          event: "jitsi_auth_result",
          userId,
          ok: false,
          method: "google",
          message: "A página de login Google não abriu a tempo (use headful e confira a UI)."
        });
        return { ok: false, reason: "no_google_page" };
      }
      continue;
    }
    const r = await fillGoogleSignInPage(gPage, jitsiAuthEmail, jitsiAuthPassword);
    if (r === "2fa_or_challenge" || r === "no_email_field" || r === "no_password_field") {
      emit({
        type: "telemetry",
        event: "jitsi_auth_result",
        userId,
        ok: false,
        method: "google",
        message:
          r === "2fa_or_challenge"
            ? "Google pediu confirmação/2FA — use PUPPETEER_HEADFUL=1 e conclua manualmente."
            : "Não foi possível preencher o formulário Google (seletor ou ecrã inesperado)."
      });
      return { ok: false, reason: r };
    }
    for (let w = 0; w < 30; w++) {
      await delay(500);
      for (const p of await browser.pages()) {
        try {
          if (isJitsiHost(p.url())) {
            await p.bringToFront();
            emit({ type: "telemetry", event: "jitsi_auth_result", userId, ok: true, method: "google" });
            return { ok: true, reason: "google" };
          }
        } catch {
          /* */
        }
      }
    }
    emit({
      type: "telemetry",
      event: "jitsi_auth_result",
      userId,
      ok: r === "ok" || r === "ok_maybe_already",
      method: "google",
      message: "Login Google concluído; confira se a aba do Jitsi voltou a ficar ativa (headful se necessário)."
    });
    return { ok: r === "ok" || r === "ok_maybe_already", reason: "google" };
  }
  emit({
    type: "telemetry",
    event: "jitsi_auth_result",
    userId,
    ok: false,
    method: "none",
    message: "Não encontrei botão/linha de Sign in ou página Google. Ajuste a UI ou use headful."
  });
  return { ok: false, reason: "no_entry" };
}

/** Depois de abrir o Google, o alvo a clicar "Entrar" pode ser outra aba; preferir a URL da sala. */
async function pickJitsiPageForConference(browser, apiUrl) {
  let roomKey = "";
  try {
    const u = new URL(apiUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    roomKey = (parts[0] || "").toLowerCase();
  } catch {
    /* */
  }
  const list = await browser.pages();
  const jitsiPages = [];
  for (const p of list) {
    try {
      if (isJitsiHost(p.url())) jitsiPages.push(p);
    } catch {
      /* */
    }
  }
  if (jitsiPages.length === 0) return null;
  if (roomKey) {
    const hit = jitsiPages.find((p) => p.url().toLowerCase().includes(roomKey));
    if (hit) return hit;
  }
  return jitsiPages[0];
}

/**
 * Tenta pôr no ecrã opções de Sign in / anfitrião / conta (útil com headful).
 * A UI do Jitsi muda; isto é best-effort. Emite `jitsi_login_ui_reveal` com o que encontrou.
 */
async function tryRevealJitsiLoginUIFromPage(page, userId) {
  const result = await page
    .evaluate(() => {
      const clicks = [];
      const click = (el, label) => {
        if (!el) return false;
        try {
          const r = el.getBoundingClientRect();
          const st = window.getComputedStyle(el);
          if (st.display === "none" || st.visibility === "hidden" || r.width < 2 || r.height < 2) {
            return false;
          }
          el.scrollIntoView({ block: "center", inline: "center" });
          el.click();
          clicks.push(label);
          return true;
        } catch {
          return false;
        }
      };

      for (const sel of [
        'a[href*="accounts.google.com"]',
        'a[href*="auth"]',
        'a[href*="signin" i]',
        "a#openLogin",
        "button#openLogin"
      ]) {
        if (click(document.querySelector(sel), sel)) {
          return { ok: true, clicks };
        }
      }
      for (const sel of [
        '[data-testid="prejoin.login"]',
        '[data-testid="lobby.authenticateAndJoinButton"]',
        ".welcome-page-header .sign-in a",
        ".welcome-card-column a[href]"
      ]) {
        if (click(document.querySelector(sel), sel)) {
          return { ok: true, clicks };
        }
      }
      const all = document.querySelectorAll("a, button, [role=button], div[role=button], span[role=button]");
      for (const el of all) {
        const tx = (el.textContent || "").trim();
        const t = tx.toLowerCase();
        const al = (el.getAttribute("aria-label") || "").toLowerCase();
        const h = `${t} ${al}`;
        if (t.length > 120) continue;
        if (
          /^(sign in|log in|entrar|iniciar sess[ãa]o|account|conta)$/.test(t) ||
          (/\bsign in\b/.test(h) && !/\bjoin meeting\b/.test(h)) ||
          (/\bhost\b.*\b(only|key)\b/i.test(t) && h.length < 100) ||
          /\b(anfitrião|moderad|sou o anfit|claim moderator|i\s*'?m\s*the\s*host|host\s*only|admin)\b/i.test(
            t + " " + al
          ) ||
          (/\badmin(istrator|istrador)?\b/i.test(t) && t.length < 80)
        ) {
          if (click(el, `text:${tx.slice(0, 48)}`)) {
            return { ok: true, clicks };
          }
        }
      }
      for (const sel of [".toolbox .toolbox-button", ".toolbox-content button", ".profile-button", "header a"]) {
        if (click(document.querySelector(sel), sel)) {
          return { ok: true, clicks };
        }
      }
      return { ok: false, clicks, note: "nenhum seletor conhecido" };
    })
    .catch((e) => ({ ok: false, clicks: [], error: String(e?.message || e) }));

  emit({ type: "telemetry", event: "jitsi_login_ui_reveal", userId, result });
  return result;
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
          'button[aria-label*="Entrar na reunião" i]',
          'button[aria-label*="Entrar" i]',
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

    let resolved = action;
    if (!resolved && jitsiUseGhostCursor) {
      if (await tryGhostCursorClickJitsiJoin(page)) {
        resolved = "ghost-cursor";
      }
    }

    if (resolved === "cookie") {
      await delay(600);
      continue;
    }
    if (resolved) {
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

async function tryZoomEnterConference(page, userId) {
  const passcode = zoomPasscode || (zoomUseAccessTokenAsPasscode ? accessToken : "");
  const emitZoomState = async (label) => {
    const state = await page
      .evaluate(() => {
        const buttons = [...document.querySelectorAll("button, a, [role='button'], input[type='submit']")]
          .map((el) => (el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || "").trim())
          .filter(Boolean)
          .slice(0, 12);
        const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 500);
        return { title: document.title, url: location.href, buttons, text };
      })
      .catch((e) => ({ error: String(e?.message || e).slice(0, 180) }));
    emit({ type: "telemetry", event: "zoom_join_state", userId, label, state });
  };

  await emitZoomState("initial");
  for (let attempt = 0; attempt < 70; attempt++) {
    if (attempt > 0 && attempt % 10 === 0) {
      await emitZoomState(`attempt-${attempt}`);
    }
    const action = await page
      .evaluate(
        ({ displayName, passcode }) => {
          const clickIfVisible = (el) => {
            if (!el) return false;
            const st = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            if (st.display === "none" || st.visibility === "hidden" || st.pointerEvents === "none") return false;
            if (r.width < 2 || r.height < 2) return false;
            el.scrollIntoView({ block: "center", inline: "center" });
            el.click();
            return true;
          };

          const typeIfEmpty = (el, value) => {
            if (!el || !value) return false;
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) return false;
            if (String(el.value || "").trim()) return false;
            el.focus();
            el.value = value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          };

          const selectors = [
            "#onetrust-accept-btn-handler",
            "button#onetrust-accept-btn-handler",
            'button[aria-label*="Accept" i]',
            'button[aria-label*="Aceitar" i]',
            'a[href*="/wc/join/"]',
            'a[href*="/wc/"][href*="/join"]',
            'a[href*="join-from-browser"]',
            'button[aria-label*="Join from" i]',
            'button[aria-label*="Entrar pelo navegador" i]',
            'button[aria-label*="I agree" i]',
            'button[aria-label*="Agree" i]',
            'button[aria-label*="Aceito" i]',
            'button[aria-label*="Concordo" i]',
            'button[aria-label*="Continue" i]',
            'button[aria-label*="Continuar" i]',
            'button[aria-label*="Join Audio" i]',
            'button[aria-label*="Join with Computer Audio" i]',
            'button[aria-label*="Join without Video" i]',
            'button[aria-label*="Join with Video" i]'
          ];
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (clickIfVisible(el)) return `selector:${sel}`;
          }

          const inputs = [...document.querySelectorAll("input")];
          for (const input of inputs) {
            const hay = `${input.name || ""} ${input.id || ""} ${input.placeholder || ""} ${input.getAttribute("aria-label") || ""}`.toLowerCase();
            if (/\b(name|nome|display)\b/.test(hay)) {
              if (typeIfEmpty(input, displayName)) return "filled-name";
            }
            if (/\b(passcode|password|senha|code|código|codigo)\b/.test(hay)) {
              if (typeIfEmpty(input, passcode)) return "filled-passcode";
            }
          }

          const candidates = [...document.querySelectorAll("button, a, [role='button'], input[type='submit']")];
          for (const el of candidates) {
            const text = (el.innerText || el.textContent || el.value || "").trim();
            const hay = `${text} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`.toLowerCase();
            if (
              /(join from (your )?browser|join meeting|join|enter|continue|i agree|agree|join audio|computer audio|join without video|join with video|entrar pelo navegador|ingressar pelo navegador|entrar|participar|continuar|aceito|concordo|áudio do computador|audio do computador)/.test(
                hay
              ) &&
              !/(leave|sair|cancel|cancelar|sign in|login|log in)/.test(hay) &&
              text.length < 120
            ) {
              if (clickIfVisible(el)) return `text:${text.slice(0, 60)}`;
            }
          }

          return "";
        },
        { displayName: zoomDisplayName, passcode }
      )
      .catch((e) => `error:${String(e?.message || e).slice(0, 120)}`);

    if (action) {
      emit({ type: "telemetry", event: "zoom_join_step", userId, action });
      await delay(1300);
      if (action.startsWith("text:") || action.includes("join") || action === "filled-passcode") {
        await delay(2200);
      }
      continue;
    }

    if (attempt % 8 === 7) {
      await page.keyboard.press("Enter").catch(() => {});
      await delay(300);
    }
    await delay(600);
  }
  await emitZoomState("final");
  return true;
}

async function tryWherebyEnterConference(page, userId) {
  const emitWherebyState = async (label) => {
    const state = await page
      .evaluate(() => {
        const buttons = [...document.querySelectorAll("button, a, [role='button'], input[type='submit']")]
          .map((el) => (el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || "").trim())
          .filter(Boolean)
          .slice(0, 12);
        const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 500);
        return { title: document.title, url: location.href, buttons, text };
      })
      .catch((e) => ({ error: String(e?.message || e).slice(0, 180) }));
    emit({ type: "telemetry", event: "whereby_join_state", userId, label, state });
  };

  const tryClickVisible = async (selector) => {
    try {
      const el = await page.$(selector);
      if (!el) return false;
      const box = await el.boundingBox();
      if (!box || box.width < 2 || box.height < 2) return false;
      await el.click();
      return true;
    } catch {
      return false;
    }
  };

  const tryFillName = async () => {
    // Excluir inputs de e-mail ou password que estejam num painel de login
    const nameSelectors = [
      'input[data-testid="name-input"]',
      'input[data-testid="precall-name-input"]',
      'input[placeholder*="seu nome" i]',
      'input[placeholder*="your name" i]',
      'input[name="displayName"]',
      'input[name="name"]',
      'input[autocomplete="name"]'
    ];
    for (const sel of nameSelectors) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        // Verificar que não é input de email/password pelo tipo
        const inputType = await el.evaluate((e) => (e.type || "text").toLowerCase());
        if (inputType === "email" || inputType === "password") continue;
        const box = await el.boundingBox();
        if (!box || box.width < 2 || box.height < 2) continue;
        await el.click({ clickCount: 3 });
        await el.press("Backspace");
        await el.type(wherebyDisplayName, { delay: 40 });
        return sel;
      } catch {
        continue;
      }
    }
    return null;
  };

  const tryClickJoin = async () => {
    // Selectores específicos do Whereby
    const joinSelectors = [
      '[data-testid="join-button"]',
      '[data-testid="precall-join-button"]',
      '[data-testid="enter-room-button"]',
      '[data-testid="knock-button"]'
    ];
    for (const sel of joinSelectors) {
      if (await tryClickVisible(sel)) return `sel:${sel}`;
    }
    // Procurar "Juntar-se" ou "Join" de forma explícita — ANTES da busca genérica por área
    try {
      const clicked = await page.evaluate(() => {
        // 1ª passagem: texto exacto de "juntar-se" / "join meeting" — maior prioridade
        const primaryRe = /(juntar-se|juntar se|join meeting|join the meeting|join now)/i;
        // 2ª passagem: "entrar na sala" ou "entrar" apenas se NÃO estiver no cabeçalho/nav
        const secondaryRe = /^entrar na sala$|^enter room$|^enter meeting$/i;
        // Qualquer "entrar"/"enter" simples — último recurso (pode ser botão de login)
        const tertiaryRe = /^entrar$|^enter$|^participar$|^ingressar$|^continuar$|^continue$/i;
        const avoidRe = /(leave|sair|cancel|cancelar|sign in|log in|sign up|criar conta|política|privacy|language|idioma)/i;

        const isInNav = (el) => !!(el.closest("nav, header, [role='navigation'], [role='banner']"));

        const tryBest = (re, excludeNav) => {
          let best = null; let bestArea = 0;
          for (const el of document.querySelectorAll("button, [role='button'], input[type='submit']")) {
            const txt = (el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || "").trim();
            if (!txt || txt.length > 80) continue;
            if (!re.test(txt)) continue;
            if (avoidRe.test(txt)) continue;
            if (excludeNav && isInNav(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            const st = window.getComputedStyle(el);
            if (st.display === "none" || st.visibility === "hidden") continue;
            const area = r.width * r.height;
            if (area > bestArea) { bestArea = area; best = { el, txt }; }
          }
          if (best) { best.el.scrollIntoView({ block: "center" }); best.el.click(); return best.txt.slice(0, 60); }
          return null;
        };

        return tryBest(primaryRe, false)
          || tryBest(secondaryRe, false)
          || tryBest(tertiaryRe, true); // exclui nav/header para "entrar" simples
      });
      if (clicked) return `text:${clicked}`;
    } catch {}
    return null;
  };

  await emitWherebyState("initial");

  // Detecta se o bot já entrou na sala.
  // NÃO usa vídeo/câmera como sinal — a pré-sala também tem preview de vídeo.
  const isInRoom = async () => {
    return page.evaluate(() => {
      // Se ainda existir o botão de juntar visível → NÃO estamos na sala
      const joinRe = /(juntar-se|juntar se|join meeting|join the meeting|join now)/i;
      for (const el of document.querySelectorAll("button, [role='button'], input[type='submit']")) {
        const txt = (el.innerText || el.textContent || el.value || "").trim();
        if (!joinRe.test(txt)) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 2 && r.height > 2) return false; // pré-sala ainda visível
      }

      // Sinal positivo 1: botão leave/sair (regex alargada — "sair da reunião", "leave", etc.)
      const leaveRe = /\bleave\b|sair da reuni|sair da sala|\bend call\b|encerrar|hang up|desligar/i;
      for (const el of document.querySelectorAll("button, [role='button']")) {
        const txt = (el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "").trim();
        if (!leaveRe.test(txt)) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 2) return true;
      }

      // Sinal positivo 2: contador de participantes "X/Y" na barra de ferramentas da sala
      for (const el of document.querySelectorAll("button, [role='button'], [aria-label]")) {
        const txt = (el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim();
        if (!/^\d+\s*\/\s*\d+$/.test(txt)) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 2) return true;
      }

      return false;
    }).catch(() => false);
  };

  let nameFilled = false;

  for (let attempt = 0; attempt < 70; attempt++) {
    if (attempt > 0 && attempt % 10 === 0) {
      await emitWherebyState(`attempt-${attempt}`);
    }

    // 0) Verificar se já entrou na sala
    if (await isInRoom()) {
      emit({ type: "telemetry", event: "whereby_join_step", userId, action: "entered-room" });
      break;
    }

    // 1) Fechar painel de login lateral (X / chevron) — antes de qualquer outra ação
    const loginPanelClosed = await page.evaluate(() => {
      // O painel de login tem um botão X/fechar no canto superior direito
      const closeRe = /^[×✕✗✖>›»]$|^close$|^fechar$|^dismiss$/i;
      for (const el of document.querySelectorAll("button, [role='button'], a")) {
        const txt = (el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "").trim();
        if (!closeRe.test(txt) && !txt.match(/^[×✕✗✖]$/)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        // Deve estar no lado direito da janela
        if (r.left < window.innerWidth * 0.45) continue;
        el.click();
        return true;
      }
      return false;
    }).catch(() => false);
    if (loginPanelClosed) {
      emit({ type: "telemetry", event: "whereby_join_step", userId, action: "closed-login-panel" });
      await delay(800);
      continue;
    }

    // 2) Aceitar política de privacidade / cookies
    const privacyAccepted = await page.evaluate(() => {
      const acceptRe = /(eu aceito|aceitar|i accept|accept all|acepto|accept)/i;
      for (const el of document.querySelectorAll("button, [role='button'], input[type='submit']")) {
        const txt = (el.innerText || el.textContent || el.value || "").trim();
        if (!acceptRe.test(txt)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const st = window.getComputedStyle(el);
        if (st.display === "none" || st.visibility === "hidden") continue;
        el.click();
        return txt.slice(0, 40);
      }
      return null;
    }).catch(() => null);
    if (privacyAccepted) {
      emit({ type: "telemetry", event: "whereby_join_step", userId, action: `privacy:${privacyAccepted}` });
      await delay(1200);
      continue;
    }

    // 3) Preencher nome — APENAS em inputs de pré-sala (excluir inputs de email)
    if (!nameFilled) {
      const filled = await tryFillName();
      if (filled) {
        nameFilled = true;
        emit({ type: "telemetry", event: "whereby_join_step", userId, action: `filled-name:${filled}` });
        await delay(800);
        continue;
      }
    }

    // 4) Clicar no botão de entrar
    const joined = await tryClickJoin();
    if (joined) {
      emit({ type: "telemetry", event: "whereby_join_step", userId, action: `join:${joined}` });
      await delay(3000);
      if (await isInRoom()) {
        emit({ type: "telemetry", event: "whereby_join_step", userId, action: "entered-room" });
        break;
      }
      nameFilled = false;
    }

    await delay(800);
  }

  await emitWherebyState("final");
  return true;
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
  return frame.evaluate(
    async (hookSource) => {
      try {
        (0, eval)(hookSource);
      } catch {
        /* contexto sem eval / isolado */
      }
      const G = typeof globalThis !== "undefined" ? globalThis : self;
      function findPcsFromJitsiGlobals() {
        const Ctor = G.RTCPeerConnection;
        if (typeof Ctor !== "function") return [];
        const found = [];
        const add = (x) => {
          try {
            if (x && x instanceof Ctor && !found.includes(x)) found.push(x);
          } catch {
            /* */
          }
        };
        const walk = (obj, depth) => {
          if (!obj || typeof obj !== "object" || depth > 2) return;
          add(obj);
          let keys;
          try {
            keys = Object.keys(obj);
          } catch {
            return;
          }
          for (let i = 0; i < keys.length && i < 60; i++) {
            const k = keys[i];
            let v;
            try {
              v = obj[k];
            } catch {
              continue;
            }
            add(v);
            if (v && typeof v === "object" && depth < 2) {
              let k2s;
              try {
                k2s = Object.keys(v);
              } catch {
                continue;
              }
              for (let j = 0; j < k2s.length && j < 40; j++) {
                let w;
                try {
                  w = v[k2s[j]];
                } catch {
                  continue;
                }
                add(w);
              }
            }
          }
        };
        try {
          if (G.APP) walk(G.APP, 0);
        } catch {
          /* */
        }
        try {
          if (G.JitsiMeetJS) walk(G.JitsiMeetJS, 0);
        } catch {
          /* */
        }
        return found;
      }
      const fromHook = G.__streamSentryPCs || [];
      const fromJitsi = findPcsFromJitsiGlobals();

      // Varredura agressiva para apps que guardam RTCPeerConnection em módulos privados (ex: Whereby)
      const findPcsFromGlobalScan = () => {
        const Native = (G.RTCPeerConnection && G.RTCPeerConnection.__streamSentryNative) || G.RTCPeerConnection;
        if (!Native) return [];
        const found = [];
        const seen = new Set();
        const tryAdd = (v) => {
          if (!v || seen.has(v)) return;
          seen.add(v);
          try { if (v instanceof Native && v.connectionState !== "closed") found.push(v); } catch {}
        };
        // Varrer propriedades do global até profundidade 3
        const scan = (obj, depth) => {
          if (!obj || depth > 3) return;
          let keys;
          try { keys = Object.keys(obj); } catch { return; }
          for (let i = 0; i < Math.min(keys.length, 200); i++) {
            let val;
            try { val = obj[keys[i]]; } catch { continue; }
            tryAdd(val);
            if (val && typeof val === "object" && depth < 3) scan(val, depth + 1);
          }
        };
        scan(G, 0);
        return found;
      };

      const dedup = new Set();
      const pcs = [];
      for (const p of [...fromHook, ...fromJitsi, ...findPcsFromGlobalScan()]) {
        if (!p || p.connectionState === "closed") continue;
        if (dedup.has(p)) continue;
        dedup.add(p);
        pcs.push(p);
      }
      const summary = {
        peerConnections: pcs.length,
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
        transport: { bytesSent: 0, bytesReceived: 0, dtlsState: null },
        statsDebug: { peerConnections: pcs.length, types: {}, samples: [] }
      };

      function collectVideoElementFallback() {
        try {
          const videos = [...document.querySelectorAll("video")].filter((v) => {
            const r = v.getBoundingClientRect();
            return (v.videoWidth || v.videoHeight || r.width || r.height) && !v.paused;
          });
          for (const v of videos) {
            let totalFrames = 0;
            let droppedFrames = 0;
            try {
              const q = typeof v.getVideoPlaybackQuality === "function" ? v.getVideoPlaybackQuality() : null;
              totalFrames = q?.totalVideoFrames || v.webkitDecodedFrameCount || 0;
              droppedFrames = q?.droppedVideoFrames || v.webkitDroppedFrameCount || 0;
            } catch {
              totalFrames = v.webkitDecodedFrameCount || 0;
              droppedFrames = v.webkitDroppedFrameCount || 0;
            }
            summary.inboundVideo.framesDecoded += totalFrames || 0;
            summary.inboundVideo.framesDropped += droppedFrames || 0;
            if (v.videoWidth) summary.inboundVideo.frameWidth = v.videoWidth;
            if (v.videoHeight) summary.inboundVideo.frameHeight = v.videoHeight;
          }
          if (videos.length) {
            summary.statsDebug.videoElements = videos.map((v) => ({
              width: v.videoWidth || 0,
              height: v.videoHeight || 0,
              paused: Boolean(v.paused),
              readyState: v.readyState
            })).slice(0, 8);
          }
        } catch {
          /* sem acesso ao DOM de vídeo */
        }
      }

      collectVideoElementFallback();

    const rtts = [];

    for (const pc of pcs) {
      if (pc.connectionState === "closed") continue;
      let report;
      try {
        report = await pc.getStats();
      } catch {
        continue;
      }

      const statKind = (s) => {
        const raw = `${s.kind || ""} ${s.mediaType || ""} ${s.trackIdentifier || ""} ${s.id || ""}`.toLowerCase();
        if (
          raw.includes("video") ||
          s.framesDecoded != null ||
          s.framesReceived != null ||
          s.framesRendered != null ||
          s.framesEncoded != null ||
          s.framesSent != null ||
          s.frameWidth != null ||
          s.frameHeight != null
        ) {
          return "video";
        }
        if (raw.includes("audio") || s.audioLevel != null || s.totalAudioEnergy != null) {
          return "audio";
        }
        return "";
      };

      report.forEach((s) => {
        const t = s.type;
        const k = statKind(s);
        summary.statsDebug.types[t] = (summary.statsDebug.types[t] || 0) + 1;
        if (
          summary.statsDebug.samples.length < 12 &&
          ["inbound-rtp", "outbound-rtp", "remote-inbound-rtp", "candidate-pair", "transport"].includes(t)
        ) {
          const interestingKeys = Object.keys(s)
            .filter((key) =>
              /kind|media|track|jitter|frame|packet|byte|round|bitrate|width|height|state|nominated|timestamp/i.test(key)
            )
            .slice(0, 18);
          const sample = { type: t, kind: k || s.kind || s.mediaType || "", keys: interestingKeys };
          for (const key of interestingKeys) {
            const value = s[key];
            if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
              sample[key] = value;
            }
          }
          summary.statsDebug.samples.push(sample);
        }
        if (t === "inbound-rtp" && k === "audio") {
          summary.inboundAudio.packetsReceived += s.packetsReceived || 0;
          summary.inboundAudio.packetsLost += s.packetsLost || 0;
          summary.inboundAudio.bytesReceived += s.bytesReceived || 0;
          if (s.jitter != null) summary.inboundAudio.jitter = s.jitter;
          if (s.audioLevel != null) summary.inboundAudio.audioLevel = s.audioLevel;
        }
        if (t === "inbound-rtp" && k === "video") {
          summary.inboundVideo.packetsReceived += s.packetsReceived || 0;
          summary.inboundVideo.packetsLost += s.packetsLost || 0;
          summary.inboundVideo.bytesReceived += s.bytesReceived || 0;
          if (s.jitter != null) summary.inboundVideo.jitter = s.jitter;
          summary.inboundVideo.framesDecoded += s.framesDecoded || s.framesReceived || s.framesRendered || 0;
          summary.inboundVideo.framesDropped += s.framesDropped || 0;
          if (s.frameWidth) summary.inboundVideo.frameWidth = s.frameWidth;
          if (s.frameHeight) summary.inboundVideo.frameHeight = s.frameHeight;
          if (s.framesPerSecond != null) summary.inboundVideo.framesPerSecond = s.framesPerSecond;
          if (s.totalDecodeTime != null) summary.inboundVideo.totalDecodeTime = s.totalDecodeTime;
          if (s.qpSum != null) summary.inboundVideo.qpSum = s.qpSum;
        }
        if (t === "outbound-rtp" && k === "audio") {
          summary.outboundAudio.packetsSent += s.packetsSent || 0;
          summary.outboundAudio.bytesSent += s.bytesSent || 0;
        }
        if (t === "outbound-rtp" && k === "video") {
          summary.outboundVideo.packetsSent += s.packetsSent || 0;
          summary.outboundVideo.bytesSent += s.bytesSent || 0;
          summary.outboundVideo.framesEncoded += s.framesEncoded || s.framesSent || 0;
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
          if (k === "audio" && rtt != null) summary.remoteInbound.audioRoundTripTimeMs = rtt;
          if (k === "video" && rtt != null) summary.remoteInbound.videoRoundTripTimeMs = rtt;
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
    },
    RTC_HOOK_SOURCE
  );
}

function mergeWebRtcSummaries(parts) {
  const base = emptyWebRtcSummary();
  base.statsDebug = { peerConnections: 0, types: {}, samples: [] };
  const rttList = [];
  const aobList = [];

  for (const s of parts) {
    if (!s) continue;
    base.peerConnections += s.peerConnections || 0;
    base.statsDebug.peerConnections += s.statsDebug?.peerConnections || s.peerConnections || 0;
    for (const [type, count] of Object.entries(s.statsDebug?.types || {})) {
      base.statsDebug.types[type] = (base.statsDebug.types[type] || 0) + count;
    }
    for (const sample of s.statsDebug?.samples || []) {
      if (base.statsDebug.samples.length < 16) base.statsDebug.samples.push(sample);
    }
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
  const frames = getFramesForPage(page);
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

async function runVirtualUser(userId, opts = {}) {
  const { signal, onBrowser, getControl } = opts;

  emit({
    type: "telemetry",
    event: "user_start",
    userId
  });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: shouldOpenBrowser ? false : "new",
      acceptInsecureCerts: ignoreHttpsErrors,
      slowMo: Number.isFinite(slowMo) ? Math.max(slowMo, 0) : 0,
      args: buildChromiumArgs()
    });
  } catch (err) {
    emit({
      type: "telemetry",
      event: "browser_launch_failed",
      userId,
      message: err?.message || String(err)
    });
    return;
  }

  activeBrowsers.add(browser);
  browser.on("disconnected", () => {
    activeBrowsers.delete(browser);
  });
  onBrowser?.(browser);
  await applyChaosToAllBrowsers(readControlSync().chaos?.profile || "off");

  browser.on("targetcreated", (target) => {
    void (async () => {
      try {
        if (isMultiPageRtcHost(apiUrl)) {
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
    emit({
      type: "telemetry",
      event: "browser_ready",
      userId
    });
    await page.setViewport({ width: 1280, height: 720 });
    if (isMultiPageRtcHost(apiUrl) && page.setBypassCSP) {
      await page.setBypassCSP(true).catch(() => {});
    }

    await attachRtcHookViaCDP(page);

    page.on("request", (request) => {
      if (isZoomHost(apiUrl) && /recaptcha|captcha/i.test(request.url())) {
        emit({
          type: "telemetry",
          event: "zoom_blocked",
          userId,
          reason: "captcha",
          message:
            "O web client público do Zoom carregou reCAPTCHA/CAPTCHA. A automação não consegue entrar na reunião sem intervenção humana."
        });
      }
      emit({
        type: "telemetry",
        event: "request",
        userId,
        method: request.method(),
        url: request.url().slice(0, 800),
        resourceType: request.resourceType()
      });
    });

    page.on("response", (response) => {
      emit({
        type: "telemetry",
        event: "response",
        userId,
        status: response.status(),
        url: response.url().slice(0, 800)
      });
    });

    page.on("requestfailed", (request) => {
      emit({
        type: "telemetry",
        event: "request_failed",
        userId,
        url: request.url().slice(0, 800),
        errorText: request.failure()?.errorText || "unknown"
      });
    });

    // Meet/Zoom públicos não usam este header; enviá-lo pode estragar fluxos de pré-sala/login.
    if (!isMultiPageRtcHost(apiUrl)) {
      await page.setExtraHTTPHeaders({
        Authorization: `Bearer ${accessToken}`
      });
    }

    let targetUrl = isZoomHost(apiUrl) ? normalizeZoomJoinUrl(apiUrl) : apiUrl;
    if (targetUrl !== apiUrl) {
      emit({ type: "telemetry", event: "zoom_url_normalized", userId, url: targetUrl.slice(0, 800) });
    }
    // Pré-preenche o nome na URL do Whereby para ajudar o fluxo de pré-sala
    if (isWhereby(targetUrl)) {
      try {
        const u = new URL(targetUrl);
        if (!u.searchParams.has("displayName")) {
          u.searchParams.set("displayName", wherebyDisplayName);
          targetUrl = u.toString();
        }
      } catch {}
      // Injectar o hook ANTES de qualquer JS da página para apanhar as RTCPeerConnections
      // que o Whereby cria logo no carregamento (antes do injectRtcHookEverywhere pós-entrada).
      await page.evaluateOnNewDocument(installStreamSentryRtcHook).catch(() => {});
    }
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 90000
    });

    await delay(isMultiPageRtcHost(apiUrl) ? 2500 : 1500);

    if (isJitsiHost(apiUrl)) {
      if (jitsiDebugLoginUI) {
        if (!shouldOpenBrowser) {
          emit({
            type: "telemetry",
            event: "jitsi_debug_hint",
            userId,
            message:
              "JITSI_DEBUG_LOGIN_UI: defina PUPPETEER_HEADFUL=1 no .env e reinicie o backend para abrir a janela do Chromium e ver a UI (Sign in / anfitrião)."
          });
        } else {
          await page.bringToFront();
        }
        await tryRevealJitsiLoginUIFromPage(page, userId);
        await delay(1500);
        await tryRevealJitsiLoginUIFromPage(page, userId);
        const pauseAfterReveal =
          jitsiDebugPauseMsExplicit != null
            ? jitsiDebugPauseMsExplicit
            : shouldOpenBrowser
              ? 90000
              : 0;
        if (pauseAfterReveal > 0) {
          emit({
            type: "telemetry",
            event: "jitsi_debug_pause",
            userId,
            pauseMs: pauseAfterReveal,
            message: `Pausa ${Math.round(
              pauseAfterReveal / 1000
            )}s — use a janela do browser para abrir Conta/Sign in/anfitrião. Ajuste JITSI_DEBUG_PAUSE_MS (0=sem pausa) ou deixe omisso (90s em headful).`
          });
          await delay(pauseAfterReveal);
        }
      }
      const jitsiTab = (await pickJitsiPageForConference(browser, apiUrl)) || page;
      await jitsiTab.bringToFront().catch(() => {});

      if (jitsiAuthEnabled && jitsiAuthEmail && jitsiAuthPassword) {
        try {
          await tryJitsiInPagePasswordLogin(jitsiTab, userId);
        } catch (e) {
          emit({
            type: "telemetry",
            event: "jitsi_auth_result",
            userId,
            ok: false,
            method: "in_page_form",
            message: String(e?.message || e).slice(0, 200)
          });
        }
        await delay(800);
      }

      const entered = await tryJitsiEnterConference(jitsiTab);
      emit({
        type: "telemetry",
        event: "jitsi_prejoin",
        userId,
        clickedJoin: entered
      });
      if (!entered) {
        emit({
          type: "telemetry",
          event: "jitsi_hint",
          userId,
          message:
            "Não foi possível clicar em Entrar automaticamente. Use PUPPETEER_HEADFUL=1 ou abra a sala no navegador e confira o nome do botão na pré-sala."
        });
      } else {
        emit({
          type: "telemetry",
          event: "jitsi_join_mode",
          userId,
          claimHost: jitsiClaimHost,
          message: jitsiClaimHost
            ? "A tentar reivindicar anfitrião (e login Google com JITSI_AUTH_*, se ativo)"
            : "Sem reivindicar «Sou o anfitrião» (evita abrir o Google) — a procurar convidado / dispensar diálogo. Para anfitrião automático, use JITSI_CLAIM_HOST=1 e JITSI_AUTH_ENABLED=1 com credenciais"
        });
        let hostAnfitriaoClicado = false;
        if (jitsiClaimHost) {
          hostAnfitriaoClicado = await tryJitsiClickAfterJoinHostButton(jitsiTab, userId);
        } else {
          await tryJitsiGuestOrDismissHostDialog(jitsiTab, userId);
        }
        if (hostAnfitriaoClicado && (!jitsiAuthEnabled || !jitsiAuthEmail || !jitsiAuthPassword)) {
          emit({
            type: "telemetry",
            event: "jitsi_hint",
            userId,
            message:
              "Clicou em «Eu sou o anfitrião» — a seguir o Meet abre o Google. Enquanto o login Google não for concluído, a chamada WebRTC não começa (PeerConnections=0). Use PUPPETEER_HEADFUL=1 e termine o Google à mão, ou ative JITSI_AUTH_ENABLED=1 e credenciais. AUDIT_PAGE_DWELL_MS=45000 dá mais tempo após a sala carregar."
          });
        }
        if (jitsiAuthEnabled && jitsiAuthEmail && jitsiAuthPassword && jitsiClaimHost) {
          if (hostAnfitriaoClicado) {
            await delay(jitsiPostHostAuthDelayMs);
          }
          try {
            const authPage = (await pickJitsiPageForConference(browser, apiUrl)) || jitsiTab;
            await authPage.bringToFront().catch(() => {});
            await tryJitsiServiceLogin(authPage, browser, userId);
          } catch (e) {
            emit({
              type: "telemetry",
              event: "jitsi_auth_result",
              userId,
              ok: false,
              method: "error",
              message: String(e?.message || e).slice(0, 200)
            });
          }
          await delay(Math.max(1500, jitsiPostHostAuthDelayMs));
        } else if (hostAnfitriaoClicado) {
          await delay(2000);
        } else if (!jitsiClaimHost) {
          await delay(2000);
        }
        for (let wave = 0; wave < 7; wave++) {
          await delay(2000);
          await injectRtcHookEverywhere(browser);
        }
        emit({
          type: "telemetry",
          event: "jitsi_hint",
          userId,
          message:
            "Com PeerConnections=0: veja se o Meet entrou de facto na reunião (não deixou a aba de login). Aumente AUDIT_PAGE_DWELL_MS (Jitsi: 20000–45000). Pode juntar outro browser à mesma sala. net::ERR_FAILED em .wasm, blob ou chrome-extension://invalid costuma ser ruído se a UI do Meet tiver aberto."
        });
      }
    }

    if (isZoomHost(apiUrl)) {
      emit({
        type: "telemetry",
        event: "zoom_join_mode",
        userId,
        message:
          "Zoom detectado. A entrada automática é best-effort: links públicos podem exigir login, CAPTCHA ou confirmação humana; páginas com Zoom Meeting SDK tendem a funcionar melhor."
      });
      await tryZoomEnterConference(page, userId);
      for (let wave = 0; wave < 7; wave++) {
        await delay(2000);
        await injectRtcHookEverywhere(browser);
      }
      emit({
        type: "telemetry",
        event: "zoom_hint",
        userId,
        message:
          "Se PeerConnections=0, abra em PUPPETEER_HEADFUL=1 para conferir se o Zoom bloqueou automação/login. Para senha, use ?pwd= no link ou ZOOM_PASSCODE no .env."
      });
    }

    if (isWhereby(apiUrl)) {
      emit({
        type: "telemetry",
        event: "whereby_join_mode",
        userId,
        message:
          "Whereby detectado. A entrar na sala automaticamente via pré-sala. Se necessário, defina WHEREBY_DISPLAY_NAME no .env."
      });

      // Injectar hook em workers que o Whereby cria (o RTCPeerConnection pode correr num DedicatedWorker)
      const injectIntoWherebyWorkers = async () => {
        for (const target of browser.targets()) {
          try {
            const type = target.type();
            if (type !== "worker" && type !== "shared_worker") continue;
            const worker = await target.worker();
            if (!worker) continue;
            await worker.evaluate(installStreamSentryRtcHook).catch(() => {});
          } catch {}
        }
      };

      // Ouvir workers criados durante a sessão
      browser.on("targetcreated", async (target) => {
        try {
          const type = target.type();
          if (type !== "worker" && type !== "shared_worker") return;
          const worker = await target.worker();
          if (!worker) return;
          await worker.evaluate(installStreamSentryRtcHook).catch(() => {});
        } catch {}
      });

      await tryWherebyEnterConference(page, userId);
      for (let wave = 0; wave < 7; wave++) {
        await delay(2000);
        await injectRtcHookEverywhere(browser);
        await injectIntoWherebyWorkers();
      }
      // Diagnóstico: verificar o que está acessível no contexto JS da página
      const wherebyDiag = await page.evaluate(async () => {
        const G = globalThis;
        const C = G.RTCPeerConnection;
        const Native = C?.__streamSentryNative || C;
        const hookedPCs = G.__streamSentryPCs?.length ?? -1;

        // Listar workers ativos acessíveis
        const workerKeys = [];
        for (const k of Object.getOwnPropertyNames(G)) {
          try {
            const v = G[k];
            if (v instanceof Worker || v instanceof SharedWorker) workerKeys.push(k);
          } catch {}
        }

        // Verificar se algum global tem connectionState (sinal de RTCPeerConnection)
        let pcInGlobal = 0;
        if (Native) {
          for (const k of Object.getOwnPropertyNames(G)) {
            try { if (G[k] instanceof Native) pcInGlobal++; } catch {}
          }
        }

        // Contar targets/frames
        const frameCount = window.frames?.length ?? 0;

        return {
          rtcWrapped: !!(C?.__streamSentryWrapped),
          hookedPCs,
          pcInGlobal,
          frameCount,
          workerKeys: workerKeys.slice(0, 5),
          url: location.href.slice(0, 120)
        };
      }).catch((e) => ({ error: String(e?.message || e).slice(0, 100) }));

      emit({ type: "telemetry", event: "whereby_rtc_diag", userId, ...wherebyDiag });

      emit({
        type: "telemetry",
        event: "whereby_hint",
        userId,
        message:
          "Se PeerConnections=0: confirme que a sala está activa e acessível. Use PUPPETEER_HEADFUL=1 para depurar visualmente. Salas trancadas (knock) podem necessitar de aprovação manual do anfitrião."
      });
    }

    const tick = Math.max(1000, statsIntervalMs);
    let probeTicks = 0;
    /**
     * Muitos VUs: todos em `setInterval` com o mesmo T criam pico (10× CDP + getStats
     * ao mesmo tempo) e a telemetria devolve vazio — Jitsi continua. Espalha o 1.º
     * tick por `userId` (ou `WEBRTC_STATS_STAGGER_MS` fixo).
     */
    const staggerEnv = process.env.WEBRTC_STATS_STAGGER_MS;
    const customStagger =
      staggerEnv !== undefined && String(staggerEnv).trim() !== ""
        ? Math.max(0, Number.parseInt(String(staggerEnv), 10) || 0)
        : null;
    const defaultStagger = Math.min(
      Math.max(tick - 1, 0),
      (Math.abs(Number(userId)) % 32) * 150
    );
    const firstDelayMs = customStagger !== null ? customStagger : defaultStagger;
    let webrtcStatsTickIndex = 0;
    let statsTimerChain = { active: true };
    const runWebrtcStatsTick = async () => {
      if (!statsTimerChain.active) return;
      webrtcStatsTickIndex += 1;
      const doInject =
        isMultiPageRtcHost(apiUrl) && webrtcStatsTickIndex % webrtcInjectEveryNTicks === 0;
      let summary = emptyWebRtcSummary();
      let statsNote = "";
      try {
        if (doInject) {
          try {
            await injectRtcHookEverywhere(browser);
          } catch (e) {
            statsNote += `inject ${String(e?.message || e).slice(0, 200)}; `;
          }
        }
        try {
          if (isMultiPageRtcHost(apiUrl)) {
            summary = (await collectWebRTCSummaryFromBrowser(browser)) || emptyWebRtcSummary();
          } else {
            summary = (await collectWebRTCSummary(page)) || emptyWebRtcSummary();
          }
        } catch (e) {
          statsNote += `collect ${String(e?.message || e).slice(0, 200)}; `;
        }
      } catch (e) {
        statsNote += `tick ${String(e?.message || e).slice(0, 200)}; `;
      }
      if (isWhereby(apiUrl) && webrtcStatsTickIndex <= 4) {
        const dbg = await page.evaluate(() => {
          const G = globalThis;
          const pcs = G.__streamSentryPCs || [];
          return {
            count: pcs.length,
            states: pcs.slice(0, 6).map((p) => ({
              conn: p?.connectionState,
              ice: p?.iceConnectionState,
              sig: p?.signalingState
            }))
          };
        }).catch((e) => ({ error: String(e?.message || e).slice(0, 80) }));
        emit({
          type: "telemetry",
          event: "whereby_stats_debug",
          userId,
          tick: webrtcStatsTickIndex,
          hookPCs: dbg,
          summaryPCs: summary.peerConnections
        });
      }
      emit({
        type: "telemetry",
        event: "webrtc_stats",
        userId,
        summary,
        ...(statsNote.trim() ? { statsNote: statsNote.trim().slice(0, 500) } : {})
      });
      if (isZoomHost(apiUrl) && (webrtcStatsTickIndex <= 6 || webrtcStatsTickIndex % 10 === 0)) {
        emit({
          type: "telemetry",
          event: "zoom_stats_debug",
          userId,
          tick: webrtcStatsTickIndex,
          debug: summary?.statsDebug || null
        });
      }
      if (isMultiPageRtcHost(apiUrl) && probeTicks < 8 && (summary?.peerConnections || 0) === 0) {
        probeTicks += 1;
        try {
          const probe = await probeWebRtcBrowser(browser);
          emit({
            type: "telemetry",
            event: "webrtc_probe",
            userId,
            probe
          });
        } catch (e) {
          emit({
            type: "telemetry",
            event: "webrtc_probe",
            userId,
            probe: {
              error: true,
              message: String(e?.message || e),
              pageTargetCount: 0,
              totalFrames: 0,
              pages: []
            }
          });
        }
      }
    };
    let webrtcNextTimeout = null;
    const scheduleWebrtcStats = (delayMs) => {
      if (!statsTimerChain.active) return;
      webrtcNextTimeout = setTimeout(() => {
        if (!statsTimerChain.active) return;
        webrtcNextTimeout = null;
        void (async () => {
          try {
            await runWebrtcStatsTick();
          } finally {
            if (statsTimerChain.active) scheduleWebrtcStats(tick);
          }
        })();
      }, delayMs);
    };
    /* Intercalado por userId + encadeado pós-tick (evita picos 10× CDP a cada T). */
    scheduleWebrtcStats(firstDelayMs);
    statsTimer = {
      close: () => {
        statsTimerChain.active = false;
        if (webrtcNextTimeout != null) {
          try {
            clearTimeout(webrtcNextTimeout);
          } catch {
            /* */
          }
          webrtcNextTimeout = null;
        }
      }
    };

    // Whereby precisa de mais tempo para coletar stats WebRTC significativas (ICE + SFU + media)
    const rtcMeetMinDwell = isWhereby(apiUrl) ? 120000 : 28000;
    const stay = Math.max(2000, isMultiPageRtcHost(apiUrl) ? Math.max(dwellMs, rtcMeetMinDwell) : dwellMs);
    await dwellWithControls(stay, { signal, getControl });

    emit({
      type: "telemetry",
      event: "user_done",
      userId
    });
  } catch (err) {
    emit({
      type: "telemetry",
      event: "user_error",
      userId,
      message: err?.message || String(err)
    });
  } finally {
    if (statsTimer && typeof statsTimer.close === "function") {
      statsTimer.close();
    } else if (statsTimer) {
      clearInterval(statsTimer);
    }
    activeBrowsers.delete(browser);
    await browser.close().catch(() => {});
  }
}

const batchSize = Math.min(4, Math.max(1, virtualUsers));

/** Lê control.json frequentemente para aplicar mudanças de chaos durante o teste (API /test/control). */
let lastChaosProfileSeen = readControlSync().chaos?.profile || "off";
const chaosPollMs = Number.parseInt(process.env.CHAOS_APPLY_INTERVAL_MS || "700", 10);
const chaosTicker = setInterval(() => {
  try {
    const prof = readControlSync().chaos?.profile || "off";
    if (prof !== lastChaosProfileSeen) {
      lastChaosProfileSeen = prof;
      emit({
        type: "telemetry",
        event: "chaos_profile_changed",
        profile: prof
      });
    }
    void applyChaosToAllBrowsers(prof);
  } catch {
    /* */
  }
}, Math.max(250, chaosPollMs));

let poolShuttingDown = false;
function requestPoolShutdown() {
  poolShuttingDown = true;
}
process.on("SIGTERM", requestPoolShutdown);
process.on("SIGINT", requestPoolShutdown);

function startVirtualUserWorker(userId) {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: {
      apiUrl,
      accessToken,
      virtualUsers,
      userId,
      sessionId: sessionIdEnv,
      testStartedAt: new Date(testStartedAtMs).toISOString()
    }
  });

  let settled = false;
  let requestedStop = false;
  const done = new Promise((resolve) => {
    worker.on("message", (msg) => {
      if (msg?.kind === "telemetry" && msg.payload) {
        writeTelemetryPayload(msg.payload);
      }
    });
    worker.on("error", (err) => {
      emit({
        type: "telemetry",
        event: "user_worker_unhandled",
        userId,
        message: err?.message || String(err)
      });
    });
    worker.on("exit", (code) => {
      settled = true;
      if (code !== 0 && !requestedStop) {
        emit({
          type: "telemetry",
          event: "user_worker_unhandled",
          userId,
          message: `worker exited with code ${code}`
        });
      }
      resolve();
    });
  });

  const stop = () => {
    if (settled) return;
    requestedStop = true;
    worker.postMessage({ type: "shutdown" });
    const killTimer = setTimeout(() => {
      if (!settled) worker.terminate().catch(() => {});
    }, 5000);
    if (typeof killTimer.unref === "function") killTimer.unref();
  };

  return { worker, done, stop };
}

async function runVirtualUserInWorkerThread() {
  const userId = Number.parseInt(String(runtimeConfig.userId || "1"), 10);
  const ac = new AbortController();
  let browser = null;

  parentPort?.on("message", (msg) => {
    if (msg?.type === "shutdown") {
      ac.abort();
      void browser?.close().catch(() => {});
    }
  });

  await runVirtualUser(Number.isFinite(userId) ? userId : 1, {
    signal: ac.signal,
    getControl: readControlSync,
    onBrowser: (b) => {
      browser = b;
    }
  });
}

async function runPoolSupervisor() {
  const inflight = new Map();
  let nextId = 0;
  let lastPoolStateEmit = 0;
  const spawnGap = Math.max(0, Number.isFinite(poolSpawnGapMs) ? poolSpawnGapMs : 600);

  while (true) {
    if (poolShuttingDown) {
      for (const [, w] of inflight) {
        w.stop?.();
        w.ac?.abort();
        await w.browser?.close().catch(() => {});
      }
      inflight.clear();
      break;
    }

    const ctrl = readControlSync();
    const want = ctrl.targetVirtualUsers;
    const now = Date.now();
    if (poolStateDebugMs > 0 && now - lastPoolStateEmit >= poolStateDebugMs) {
      lastPoolStateEmit = now;
      emit({
        type: "telemetry",
        event: "pool_state",
        want,
        inflight: inflight.size
      });
    }

    const ids = [...inflight.keys()].sort((a, b) => b - a);
    while (inflight.size > want && ids.length) {
      const id = ids.shift();
      const w = id !== undefined ? inflight.get(id) : null;
      if (!w) continue;
      w.stop?.();
      w.ac?.abort();
      await w.browser?.close().catch(() => {});
      inflight.delete(id);
    }

    while (inflight.size < want && !poolShuttingDown) {
      nextId += 1;
      const id = nextId;
      if (useWorkerThreads) {
        const entry = startVirtualUserWorker(id);
        inflight.set(id, entry);
        void entry.done.finally(() => {
          inflight.delete(id);
        });
      } else {
        const ac = new AbortController();
        const entry = { ac, browser: null };
        inflight.set(id, entry);
        void runVirtualUser(id, {
          signal: ac.signal,
          getControl: readControlSync,
          onBrowser: (b) => {
            entry.browser = b;
          }
        })
          .catch((err) => {
            console.error("runVirtualUser", id, err);
            emit({
              type: "telemetry",
              event: "user_worker_unhandled",
              userId: id,
              message: err?.message || String(err)
            });
          })
          .finally(() => {
            inflight.delete(id);
          });
      }
      await delay(spawnGap);
    }

    await delay(500);
  }
}

async function main() {
  emit({
    type: "telemetry",
    event: "test_start",
    ...(sessionIdEnv ? { sessionId: sessionIdEnv } : {}),
    startedAtISO: new Date(testStartedAtMs).toISOString(),
    virtualUsers,
    batchSize,
    poolMode: streamSentryPool,
    workerThreads: useWorkerThreads,
    targetUrl: apiUrl
  });

  if (streamSentryPool) {
    await runPoolSupervisor();
  } else {
    for (let start = 1; start <= virtualUsers; start += batchSize) {
      const end = Math.min(start + batchSize - 1, virtualUsers);
      const tasks = [];
      for (let userId = start; userId <= end; userId++) {
        if (useWorkerThreads) {
          tasks.push(startVirtualUserWorker(userId).done);
        } else {
          tasks.push(runVirtualUser(userId, { getControl: readControlSync }));
        }
      }
      await Promise.all(tasks);
    }
  }

  emit({
    type: "telemetry",
    event: "test_complete",
    virtualUsers,
    poolMode: streamSentryPool,
    workerThreads: useWorkerThreads
  });
  clearInterval(chaosTicker);
}

if (isMainThread) {
  await main();
} else {
  await runVirtualUserInWorkerThread();
  clearInterval(chaosTicker);
}
