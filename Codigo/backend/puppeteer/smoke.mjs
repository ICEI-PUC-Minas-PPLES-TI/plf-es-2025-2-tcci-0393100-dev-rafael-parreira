import puppeteer from "puppeteer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [, , apiUrl, accessToken, virtualUsersArg] = process.argv;
const virtualUsers = Number.parseInt(virtualUsersArg || "1", 10);
const shouldOpenBrowser = process.env.PUPPETEER_HEADFUL === "1";
const slowMo = Number.parseInt(process.env.PUPPETEER_SLOW_MO || "0", 10);

if (!apiUrl || !accessToken || Number.isNaN(virtualUsers)) {
  console.error("Missing required arguments: apiUrl accessToken virtualUsers");
  process.exit(1);
}

const now = new Date();
const timestamp = now.toISOString().replace(/[:.]/g, "-");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const artifactDir = path.join(scriptDir, "artifacts", timestamp);

const requestEvents = [];
const responseEvents = [];
const failureEvents = [];
const browserConsole = [];

const browser = await puppeteer.launch({
  headless: shouldOpenBrowser ? false : "new",
  slowMo: Number.isFinite(slowMo) ? Math.max(slowMo, 0) : 0,
  args: ["--no-sandbox"]
});

try {
  await fs.mkdir(artifactDir, { recursive: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  page.on("request", (request) => {
    requestEvents.push({
      timestamp: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType()
    });
  });

  page.on("response", (response) => {
    responseEvents.push({
      timestamp: new Date().toISOString(),
      status: response.status(),
      url: response.url()
    });
  });

  page.on("requestfailed", (request) => {
    failureEvents.push({
      timestamp: new Date().toISOString(),
      url: request.url(),
      method: request.method(),
      errorText: request.failure()?.errorText || "unknown"
    });
  });

  page.on("console", (message) => {
    browserConsole.push({
      timestamp: new Date().toISOString(),
      type: message.type(),
      text: message.text()
    });
  });

  await page.setExtraHTTPHeaders({
    Authorization: `Bearer ${accessToken}`
  });

  const response = await page.goto(apiUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });

  const screenshotPath = path.join(artifactDir, "final-page.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const accessLog = {
    executedAt: new Date().toISOString(),
    target: apiUrl,
    virtualUsers,
    requestEvents,
    responseEvents,
    failureEvents,
    browserConsole
  };
  const logPath = path.join(artifactDir, "access-log.json");
  await fs.writeFile(logPath, `${JSON.stringify(accessLog, null, 2)}\n`, "utf-8");

  const result = {
    finalUrl: page.url(),
    statusCode: response ? response.status() : null,
    title: await page.title(),
    virtualUsers,
    executedAt: new Date().toISOString(),
    mode: shouldOpenBrowser ? "headful-demo" : "provisional-smoke",
    requestCount: requestEvents.length,
    responseCount: responseEvents.length,
    failedRequestCount: failureEvents.length,
    artifactDir,
    screenshotPath,
    accessLogPath: logPath
  };

  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await browser.close();
}
