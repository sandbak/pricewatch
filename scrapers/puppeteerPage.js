const puppeteer = require("puppeteer");

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 2000;
const DEFAULT_BACKOFF_FACTOR = 2;
const IDLE_BROWSER_CLOSE_MS = 30_000;

let browserPromise = null;
let activePages = 0;
let idleCloseTimer = null;

function clearIdleCloseTimer() {
  if (idleCloseTimer) {
    clearTimeout(idleCloseTimer);
    idleCloseTimer = null;
  }
}

function scheduleIdleBrowserClose() {
  clearIdleCloseTimer();
  if (activePages > 0 || !browserPromise) return;

  idleCloseTimer = setTimeout(() => {
    closeSharedBrowser().catch((err) => {
      console.warn(`[puppeteer] Failed to close idle browser: ${err.message}`);
    });
  }, IDLE_BROWSER_CLOSE_MS);
  idleCloseTimer.unref?.();
}

async function launchBrowser() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-crash-reporter",
      "--disable-extensions",
      "--no-zygote",
      "--window-size=1365,768",
    ],
  });

  browser.on("disconnected", () => {
    if (browserPromise) {
      browserPromise = null;
    }
  });

  return browser;
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = launchBrowser().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  clearIdleCloseTimer();
  return browserPromise;
}

function isRetryablePuppeteerError(err) {
  const message = err?.message || "";

  if (/captcha/i.test(message)) return false;

  return (
    /timeout/i.test(message) ||
    /navigation/i.test(message) ||
    /net::/i.test(message) ||
    /amazon price not found/i.test(message) ||
    /failed to launch the browser process/i.test(message) ||
    /resource temporarily unavailable/i.test(message) ||
    /target closed/i.test(message) ||
    /browser has disconnected/i.test(message) ||
    /protocol error/i.test(message)
  );
}

async function onceWithPuppeteerPage(userAgent, fn) {
  let page;

  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    activePages += 1;
    await page.setViewport({ width: 1365, height: 768 });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "languages", { get: () => ["nl-NL", "nl", "en-US", "en"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      window.chrome = window.chrome || { runtime: {} };
    });

    if (userAgent) {
      await page.setUserAgent(userAgent);
    }

    return await fn(page);
  } finally {
    if (page) {
      await page.close().catch(() => {});
      activePages = Math.max(0, activePages - 1);
      scheduleIdleBrowserClose();
    }
  }
}

async function withPuppeteerPage(userAgent, fn, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const backoffFactor = opts.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await onceWithPuppeteerPage(userAgent, fn);
    } catch (err) {
      lastError = err;

      if (!isRetryablePuppeteerError(err) || attempt === maxAttempts) {
        throw err;
      }

      if (/target closed|browser has disconnected|protocol error/i.test(err.message || "")) {
        await closeSharedBrowser();
      }

      const delayMs = baseDelayMs * Math.pow(backoffFactor, attempt - 1);
      console.warn(
        `[puppeteer retry] Attempt ${attempt}/${maxAttempts} failed (${err.message}). ` +
          `Retrying with a fresh page in ${delayMs}ms…`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

async function closeSharedBrowser() {
  clearIdleCloseTimer();
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  activePages = 0;
  await browser?.close().catch(() => {});
}

module.exports = { withPuppeteerPage, isRetryablePuppeteerError, closeSharedBrowser };
