#!/usr/bin/env node

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const cron = require("node-cron");
const chalk = require("chalk");
const { Readable } = require("stream");
const { clerkMiddleware, getAuth } = (() => {
  try {
    return require("@clerk/express");
  } catch (err) {
    console.error("Failed to load Clerk:", err.message);
    return { clerkMiddleware: () => (req, res, next) => next(), getAuth: () => ({}) };
  }
})();
const { clerkFrontendApiProxy } = require("@clerk/backend/proxy");

const env = require("./lib/env");
const db = require("./lib/db");
const store = require("./lib/store");
const scrapers = require("./scrapers");
const telegram = require("./telegram");
const checkRunner = require("./services/check-runner");

const checkJobs = new Map();
const CHECK_JOB_TTL_MS = 30 * 60 * 1000;
const PROCESS_STARTED_AT = new Date();

function cleanupFinishedJobs(now = Date.now()) {
  for (const [id, job] of checkJobs.entries()) {
    if (!job.finishedAt) continue;
    if (now - new Date(job.finishedAt).getTime() > CHECK_JOB_TTL_MS) {
      checkJobs.delete(id);
    }
  }
}

function createJob(userId) {
  cleanupFinishedJobs();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    userId,
    status: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
  };
  checkJobs.set(id, job);
  return job;
}

function finishJob(job, patch) {
  Object.assign(job, patch, { finishedAt: new Date().toISOString() });
  cleanupFinishedJobs();
}

// ─── Express app ──────────────────────────────────────────────────────────
const app = express();

// Railway terminates TLS before requests reach Express. Trust forwarded
// headers so Clerk sees the public https:// origin during proxy/auth flows.
app.set("trust proxy", 1);

app.use(cors());

// Clerk auth middleware — only enable if keys are present
const clerkKey = env.get("CLERK_PUBLISHABLE_KEY");
const clerkSecret = env.get("CLERK_SECRET_KEY");
if (clerkKey && clerkSecret) {
  app.use("/__clerk", async (req, res, next) => {
    try {
      const headers = new Headers();
      Object.entries(req.headers).forEach(([key, value]) => {
        if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      });

      const protocol = req.protocol || (req.secure ? "https" : "http");
      const host = req.get("host") || "localhost";
      const url = new URL(req.originalUrl || req.url, `${protocol}://${host}`);
      const hasBody = ["POST", "PUT", "PATCH"].includes(req.method);

      const proxyResponse = await clerkFrontendApiProxy(
        new Request(url.toString(), {
          method: req.method,
          headers,
          body: hasBody ? Readable.toWeb(req) : undefined,
          duplex: hasBody ? "half" : undefined,
        }),
        {
          proxyPath: "/__clerk",
          publishableKey: clerkKey,
          secretKey: clerkSecret,
        }
      );

      res.status(proxyResponse.status);

      proxyResponse.headers.forEach((value, key) => {
        if (key.toLowerCase() !== "set-cookie") res.setHeader(key, value);
      });

      const setCookies = proxyResponse.headers.getSetCookie?.();
      if (setCookies?.length) {
        res.setHeader("set-cookie", setCookies);
      } else {
        const setCookie = proxyResponse.headers.get("set-cookie");
        if (setCookie) res.setHeader("set-cookie", setCookie);
      }

      if (!proxyResponse.body) return res.end();
      Readable.fromWeb(proxyResponse.body).pipe(res);
    } catch (err) {
      next(err);
    }
  });

  app.use(
    clerkMiddleware({
      publishableKey: clerkKey,
      secretKey: clerkSecret,
    })
  );
  console.log(chalk.gray("✓ Clerk auth enabled (proxy at /__clerk)"));
} else {
  console.log(chalk.yellow("⚠ Clerk not configured — auth disabled"));
}

// Body parsing must run after Clerk's frontend API proxy. The proxy forwards
// POST bodies for OAuth/sign-up verification and needs the raw request stream.
app.use(express.json());

// ─── API routes (all require auth) ───────────────────────────────────────

async function requireAuth(req, res, next) {
  try {
    const { userId } = getAuth(req) || {};
    if (!userId) return res.status(401).json({ error: "Unauthenticated" });
    req.authUser = await store.getOrCreateUser(userId);
    next();
  } catch {
    return res.status(401).json({ error: "Auth unavailable — check Clerk configuration" });
  }
}

function unsupportedUrlResponse(res) {
  return res.status(400).json({
    error: `This shop is not supported yet. Please add a product URL from ${scrapers.SUPPORTED_DOMAINS.join(", ")}.`,
  });
}

// GET /api/products — list products with current prices from DB
app.get("/api/products", requireAuth, async (req, res) => {
  const products = await store.listProducts(req.authUser.id);
  res.json(products);
});

// POST /api/products — add a product and kick off first check in background
app.post("/api/products", requireAuth, async (req, res) => {
  const { url, label, targetPrice, priceType, currency } = req.body;

  if (!url || !label || targetPrice == null) {
    return res.status(400).json({ error: "url, label, and targetPrice are required" });
  }

  if (!scrapers.detect(url)) {
    return unsupportedUrlResponse(res);
  }

  const product = await store.addProduct(req.authUser.id, {
    url,
    label,
    targetPrice: parseFloat(targetPrice),
    priceType: priceType || (url.includes("ah.nl") ? "bonus" : "regular"),
    currency: currency || "EUR",
  });

  const settings = await store.getSettings(req.authUser.id);
  const cfg = {
    telegram: {
      botToken: settings.telegram_bot_token,
      chatId: settings.telegram_chat_id,
    },
  };
  // Return immediately for responsive UX; run first scrape asynchronously.
  const latest = await store.getProductBySlug(req.authUser.id, product.id);
  res.status(201).json(latest);

  checkRunner.checkProduct(product, { cfg })
    .then(() => {})
    .catch((err) => {
      console.log(chalk.yellow(`⚠ initial background check failed for ${product.label}: ${err.message}`));
    });
});

// PUT /api/products/:id — update a product
app.put("/api/products/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  if (updates.targetPrice != null) {
    updates.targetPrice = parseFloat(updates.targetPrice);
  }

  if (updates.url && !scrapers.detect(updates.url)) {
    return unsupportedUrlResponse(res);
  }

  const product = await store.updateProduct(req.authUser.id, id, updates);
  if (!product) return res.status(404).json({ error: "Product not found" });

  res.json(product);
});

// DELETE /api/products/:id — remove a product
app.delete("/api/products/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  const deleted = await store.deleteProduct(req.authUser.id, id);
  if (!deleted) return res.status(404).json({ error: "Product not found" });
  res.json({ ok: true });
});

// POST /api/check-now — manually run a full price check
app.post("/api/check-now", requireAuth, async (req, res) => {
  const userId = req.authUser.id;
  const activeCheck = checkRunner.getActiveUserCheck(userId);
  if (activeCheck) {
    const running = activeCheck.jobId ? checkJobs.get(activeCheck.jobId) : null;

    return res.json({
      ok: true,
      queued: false,
      running: true,
      message: "Check already running",
      source: activeCheck.source,
      jobId: running?.id || null,
    });
  }

  const job = createJob(userId);
  const lock = checkRunner.beginUserCheck(userId, { source: "manual", jobId: job.id });

  checkRunner.runChecksForUser(userId)
    .then((result) => {
      finishJob(job, {
        status: "done",
        result,
      });
    })
    .catch((err) => {
      console.error(chalk.red("Manual check failed:"), err);
      finishJob(job, {
        status: "failed",
        error: err.message,
      });
    })
    .finally(() => {
      checkRunner.endUserCheck(userId, lock);
    });

  Object.assign(job, {
    status: "running",
    startedAt: new Date().toISOString(),
  });

  res.json({ ok: true, queued: true, running: true, jobId: job.id });
});

// GET /api/check-now/:jobId — get manual check job status
app.get("/api/check-now/:jobId", requireAuth, async (req, res) => {
  cleanupFinishedJobs();
  const { jobId } = req.params;
  const job = checkJobs.get(jobId);
  if (!job || job.userId !== req.authUser.id) {
    return res.status(404).json({ error: "Job not found" });
  }

  res.json({
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result: job.result,
    error: job.error,
  });
});

// GET /api/config — get settings (Telegram creds masked)
app.get("/api/config", requireAuth, async (req, res) => {
  const settings = await store.getSettings(req.authUser.id);

  res.json({
    checkIntervalMinutes: settings.check_interval_minutes,
    telegram: {
      botToken: settings.telegram_bot_token ? "***" : null,
      chatId: settings.telegram_chat_id ? "***" : null,
    },
  });
});

// PUT /api/config — update settings and/or Telegram creds
app.put("/api/config", requireAuth, async (req, res) => {
  const { checkIntervalMinutes, botToken, chatId } = req.body;

  await store.updateSettings(req.authUser.id, {
    checkIntervalMinutes,
    botToken,
    chatId,
  });

  res.json({ ok: true });
});

// POST /api/config/discover-chat — discover Telegram chat ID after user messages bot
app.post("/api/config/discover-chat", requireAuth, async (req, res) => {
  const { botToken } = req.body;
  const settings = await store.getSettings(req.authUser.id);
  const token = (botToken || settings.telegram_bot_token || "").trim();

  if (!token) {
    return res.status(400).json({ error: "Bot token is required" });
  }

  try {
    const chat = await telegram.discoverChat(token);
    await store.updateSettings(req.authUser.id, {
      botToken: token,
      chatId: chat.chatId,
    });

    res.json({ ok: true, chat });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/config/test — send a test Telegram message
app.post("/api/config/test", requireAuth, async (req, res) => {
  const settings = await store.getSettings(req.authUser.id);
  const botToken = settings.telegram_bot_token;
  const chatId = settings.telegram_chat_id;

  if (!botToken || !chatId) {
    return res.status(400).json({ error: "Telegram not configured" });
  }

  try {
    await telegram.sendTestMessage(botToken, chatId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/status — watcher status
app.get("/api/status", requireAuth, async (req, res) => {
  const settings = await store.getSettings(req.authUser.id);
  const products = await store.listProducts(req.authUser.id);
  const lastChecked = products.reduce((latest, p) => {
    return p.lastChecked && p.lastChecked > latest ? p.lastChecked : latest;
  }, null);

  res.json({
    productCount: products.length,
    checkIntervalMinutes: settings.check_interval_minutes,
    lastRunAt: settings.last_run_at || null,
    lastChecked,
    supportedDomains: scrapers.SUPPORTED_DOMAINS,
  });
});

// GET /api/health — lightweight runtime diagnostics
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    startedAt: PROCESS_STARTED_AT.toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    lastCronRunAt: checkRunner.getLastCronRunAt(),
  });
});

// ─── Serve React frontend ────────────────────────────────────────────────
const clientDist = path.join(__dirname, "client", "dist");
app.use(express.static(clientDist, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) {
      res.set("Cache-Control", "no-cache");
    }
  },
}));

// SPA fallback — serve index.html for any unmatched route
app.get("*", (req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(chalk.red("Server error:"), err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

// Schedule cron
const cronExpr = "* * * * *";
cron.schedule(cronExpr, checkRunner.runChecks);

// ─── Start server ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

process.on("uncaughtException", (err) => {
  console.error(chalk.red("Uncaught exception:"), err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error(chalk.red("Unhandled rejection:"), reason);
});

async function start() {
  await db.initSchema();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(chalk.bold.cyan("\n🛒 Price Watcher"));
    console.log(chalk.gray(`   API + UI running on http://localhost:${PORT}`));
    console.log(chalk.gray("   Cron: every 1 minute (per-user intervals enforced)\n"));

    // Run initial check
    checkRunner.runChecks().catch((err) => console.error(chalk.red("Initial check failed:"), err));
  });
}

start().catch((err) => {
  console.error(chalk.red("Failed to start server:"), err);
  process.exit(1);
});
