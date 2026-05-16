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
const { migrateLegacyForUser } = require("./lib/legacy-migration");
const scrapers = require("./scrapers");
const telegram = require("./telegram");

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

// GET /api/products — list products with current prices from DB
app.get("/api/products", requireAuth, async (req, res) => {
  const products = await store.listProducts(req.authUser.id);
  res.json(products);
});

// POST /api/products — add a product and immediately fetch its first price
app.post("/api/products", requireAuth, async (req, res) => {
  const { url, label, targetPrice, priceType, currency } = req.body;

  if (!url || !label || targetPrice == null) {
    return res.status(400).json({ error: "url, label, and targetPrice are required" });
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
  const checkResult = await checkProduct(product, { cfg });
  const latest = await store.getProductBySlug(req.authUser.id, product.id);
  res.status(201).json({ ...latest, check: checkResult });
});

// PUT /api/products/:id — update a product
app.put("/api/products/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  if (updates.targetPrice != null) {
    updates.targetPrice = parseFloat(updates.targetPrice);
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
  const result = await runChecksForUser(req.authUser.id);
  res.json(result);
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
    lastChecked,
    supportedDomains: scrapers.SUPPORTED_DOMAINS,
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

// ─── Start watcher cron ──────────────────────────────────────────────────
async function checkProduct(product, options = {}) {
  const { cfg = null, delay = 0 } = options;
  const label = product.label || product.id;

  process.stdout.write(chalk.gray(`  Checking ${label}... `));

  let result;
  try {
    result = await scrapers.scrape(product.url, {
      priceType: product.priceType || "bonus",
    });
  } catch (err) {
    console.log(chalk.yellow(`⚠ scrape failed: ${err.message}`));
    return { id: product.id, ok: false, error: err.message };
  }

  if (result.price == null) {
    console.log(chalk.yellow("⚠ price not found"));
    return { id: product.id, ok: false, error: "price not found" };
  }

  const entry = product;
  await store.upsertProductState(product.dbId, {
    lastPrice: result.price,
    lastChecked: new Date().toISOString(),
    promotion: result.promotion || null,
  });

  const fmt = (n) => `€${n.toFixed(2).replace(".", ",")}`;
  const promoUnitPrice = result.promotion?.unitPrice ?? null;
  const effectivePrice =
    promoUnitPrice != null ? Math.min(result.price, promoUnitPrice) : result.price;
  const onSale = effectivePrice <= product.targetPrice;

  if (onSale) {
    if (!entry.alertSent) {
      const dealViaPromo = promoUnitPrice != null && promoUnitPrice <= product.targetPrice;
      if (dealViaPromo) {
        console.log(
          chalk.green(
            `✓ ${fmt(promoUnitPrice)}/unit via "${result.promotion.label}" — UNDER TARGET!`
          )
        );
      } else {
        console.log(chalk.green(`✓ ${fmt(result.price)} — UNDER TARGET!`));
      }

      if (cfg?.telegram?.botToken && cfg?.telegram?.chatId) {
        try {
          await telegram.sendPriceAlert(cfg, product, result, { dealViaPromo });
          await store.upsertProductState(product.dbId, { alertSent: true });
          console.log(chalk.green("    ✓ Telegram alert sent"));
        } catch (err) {
          console.log(chalk.red(`    ✗ Telegram send failed: ${err.message}`));
        }
      }
    } else {
      console.log(chalk.green(`✓ ${fmt(result.price)} — still under target`));
    }
  } else {
    if (entry.alertSent) {
      await store.upsertProductState(product.dbId, { alertSent: false });
      console.log(chalk.blue(`↑ ${fmt(result.price)} — price back above target`));
    } else {
      console.log(chalk.gray(`– ${fmt(result.price)} (target: ${fmt(product.targetPrice)})`));
    }
  }

  if (delay) await new Promise((r) => setTimeout(r, delay));

  return {
    id: product.id,
    ok: true,
    price: result.price,
    promotion: result.promotion || null,
    onSale,
  };
}

async function runChecks() {
  const now = new Date().toLocaleString("nl-NL");
  console.log(chalk.bold(`\n[${now}] Running checks...`));
  const users = await store.listUsersWithSettings();
  const results = [];

  for (const u of users) {
    const interval = Math.max(1, u.check_interval_minutes || 60);
    const lastRun = u.last_run_at ? new Date(u.last_run_at).getTime() : 0;
    const due = Date.now() - lastRun >= interval * 60 * 1000;
    if (!due) continue;

    const products = await store.listProducts(u.user_id);
    const cfg = {
      telegram: {
        botToken: u.telegram_bot_token,
        chatId: u.telegram_chat_id,
      },
    };

    for (const product of products) {
      results.push(await checkProduct(product, { cfg, delay: 2000 }));
    }

    await store.touchUserRun(u.user_id);
  }

  console.log(chalk.gray("Done.\n"));
  return {
    ok: true,
    checked: results.length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

async function runChecksForUser(userId) {
  const settings = await store.getSettings(userId);
  const products = await store.listProducts(userId);
  const cfg = {
    telegram: {
      botToken: settings.telegram_bot_token,
      chatId: settings.telegram_chat_id,
    },
  };

  const results = [];
  for (const product of products) {
    results.push(await checkProduct(product, { cfg, delay: 2000 }));
  }

  await store.touchUserRun(userId);
  return {
    ok: true,
    checked: results.length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

// Schedule cron
const cronExpr = "* * * * *";
cron.schedule(cronExpr, runChecks);

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

  const legacyOwnerUserId = process.env.LEGACY_OWNER_USER_ID || null;
  if (legacyOwnerUserId) {
    const migrated = await migrateLegacyForUser(legacyOwnerUserId, env);
    if (migrated.migrated) {
      console.log(chalk.green(`✓ Migrated ${migrated.count} legacy products to user ${legacyOwnerUserId}`));
    }
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(chalk.bold.cyan("\n🛒 Price Watcher"));
    console.log(chalk.gray(`   API + UI running on http://localhost:${PORT}`));
    console.log(chalk.gray("   Cron: every 1 minute (per-user intervals enforced)\n"));

    // Run initial check
    runChecks().catch((err) => console.error(chalk.red("Initial check failed:"), err));
  });
}

start().catch((err) => {
  console.error(chalk.red("Failed to start server:"), err);
  process.exit(1);
});
