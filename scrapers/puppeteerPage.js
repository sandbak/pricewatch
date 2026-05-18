const puppeteer = require("puppeteer");

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 2000;
const DEFAULT_BACKOFF_FACTOR = 2;

function isRetryablePuppeteerError(err) {
  const message = err?.message || "";

  if (/captcha/i.test(message)) return false;

  return (
    /timeout/i.test(message) ||
    /navigation/i.test(message) ||
    /net::/i.test(message) ||
    /amazon price not found/i.test(message) ||
    /target closed/i.test(message) ||
    /browser has disconnected/i.test(message) ||
    /protocol error/i.test(message)
  );
}

async function onceWithPuppeteerPage(userAgent, fn) {
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1365,768",
      ],
    });

    const page = await browser.newPage();
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
    if (browser) {
      await browser.close();
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

module.exports = { withPuppeteerPage, isRetryablePuppeteerError };
