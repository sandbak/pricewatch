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
const configManager = require("./lib/config");
const stateManager = require("./state");
const scrapers = require("./scrapers");
const telegram = require("./telegram");

// ─── Migrate Telegram secrets from config.json to .env ────────────────────
const CONFIG_PATH = path.join(__dirname, "config.json");
const migrated = env.migrateTelegramFromConfig(CONFIG_PATH);
if (migrated) {
  console.log(chalk.green("✓ Migrated Telegram credentials from config.json to .env"));
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

function requireAuth(req, res, next) {
  try {
    const { userId } = getAuth(req) || {};
    if (!userId) return res.status(401).json({ error: "Unauthenticated" });
    next();
  } catch {
    return res.status(401).json({ error: "Auth unavailable — check Clerk configuration" });
  }
}

// GET /api/products — list products with current prices from state
app.get("/api/products", requireAuth, (req, res) => {
  const products = configManager.getProducts();
  const state = stateManager.load();

  const enriched = products.map((p) => {
    const s = stateManager.get(state, p.id);
    return {
      ...p,
      lastPrice: s.lastPrice,
      lastChecked: s.lastChecked,
      alertSent: s.alertSent,
      promotion: s.promotion || null,
    };
  });

  res.json(enriched);
});

// POST /api/products — add a product
app.post("/api/products", requireAuth, (req, res) => {
  const { url, label, targetPrice, priceType, currency } = req.body;

  if (!url || !label || targetPrice == null) {
    return res.status(400).json({ error: "url, label, and targetPrice are required" });
  }

  const product = configManager.addProduct({
    url,
    label,
    targetPrice: parseFloat(targetPrice),
    priceType: priceType || (url.includes("ah.nl") ? "bonus" : "regular"),
    currency: currency || "EUR",
  });

  res.status(201).json(product);
});

// PUT /api/products/:id — update a product
app.put("/api/products/:id", requireAuth, (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  if (updates.targetPrice != null) {
    updates.targetPrice = parseFloat(updates.targetPrice);
  }

  const product = configManager.updateProduct(id, updates);
  if (!product) return res.status(404).json({ error: "Product not found" });

  res.json(product);
});

// DELETE /api/products/:id — remove a product
app.delete("/api/products/:id", requireAuth, (req, res) => {
  const { id } = req.params;
  const deleted = configManager.deleteProduct(id);
  if (!deleted) return res.status(404).json({ error: "Product not found" });
  res.json({ ok: true });
});

// GET /api/config — get settings (Telegram creds masked)
app.get("/api/config", requireAuth, (req, res) => {
  const settings = configManager.getSettings();
  const botToken = env.get("TELEGRAM_BOT_TOKEN");
  const chatId = env.get("TELEGRAM_CHAT_ID");

  res.json({
    checkIntervalMinutes: settings.checkIntervalMinutes,
    telegram: {
      botToken: botToken ? "***" : null,
      chatId: chatId ? "***" : null,
    },
  });
});

// PUT /api/config — update settings and/or Telegram creds
app.put("/api/config", requireAuth, (req, res) => {
  const { checkIntervalMinutes, botToken, chatId } = req.body;

  if (checkIntervalMinutes != null) {
    configManager.updateSettings({ checkIntervalMinutes });
  }

  if (botToken) env.set("TELEGRAM_BOT_TOKEN", botToken);
  if (chatId) env.set("TELEGRAM_CHAT_ID", chatId);

  res.json({ ok: true });
});

// POST /api/config/test — send a test Telegram message
app.post("/api/config/test", requireAuth, async (req, res) => {
  const botToken = env.get("TELEGRAM_BOT_TOKEN");
  const chatId = env.get("TELEGRAM_CHAT_ID");

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
app.get("/api/status", requireAuth, (req, res) => {
  const settings = configManager.getSettings();
  const products = configManager.getProducts();
  const state = stateManager.load();

  const lastChecked = products.reduce((latest, p) => {
    const s = stateManager.get(state, p.id);
    return s.lastChecked && s.lastChecked > latest ? s.lastChecked : latest;
  }, null);

  res.json({
    productCount: products.length,
    checkIntervalMinutes: settings.checkIntervalMinutes,
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
function runChecks() {
  const config = configManager.load();
  const botToken = env.get("TELEGRAM_BOT_TOKEN");
  const chatId = env.get("TELEGRAM_CHAT_ID");

  if (!botToken || !chatId) {
    console.log(chalk.yellow("⚠ Telegram not configured — skipping checks"));
    return;
  }

  const cfg = { ...config, telegram: { botToken, chatId } };
  const now = new Date().toLocaleString("nl-NL");
  console.log(chalk.bold(`\n[${now}] Running checks...`));

  const state = stateManager.load();

  (async () => {
    for (const product of cfg.products) {
      const label = product.label || product.id;
      process.stdout.write(chalk.gray(`  Checking ${label}... `));

      let result;
      try {
        result = await scrapers.scrape(product.url, {
          priceType: product.priceType || "bonus",
        });
      } catch (err) {
        console.log(chalk.yellow(`⚠ scrape failed: ${err.message}`));
        continue;
      }

      if (result.price == null) {
        console.log(chalk.yellow("⚠ price not found"));
        continue;
      }

      const entry = stateManager.get(state, product.id);
      stateManager.set(state, product.id, {
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
          try {
            await telegram.sendPriceAlert(cfg, product, result, { dealViaPromo });
            stateManager.set(state, product.id, { alertSent: true });
            console.log(chalk.green("    ✓ Telegram alert sent"));
          } catch (err) {
            console.log(chalk.red(`    ✗ Telegram send failed: ${err.message}`));
          }
        } else {
          console.log(chalk.green(`✓ ${fmt(result.price)} — still under target`));
        }
      } else {
        if (entry.alertSent) {
          stateManager.set(state, product.id, { alertSent: false });
          console.log(chalk.blue(`↑ ${fmt(result.price)} — price back above target`));
        } else {
          console.log(chalk.gray(`– ${fmt(result.price)} (target: ${fmt(product.targetPrice)})`));
        }
      }

      stateManager.save(state);
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log(chalk.gray("Done.\n"));
  })();
}

// Schedule cron
const interval = Math.max(1, configManager.load().checkIntervalMinutes || 60);
const cronExpr =
  interval >= 60
    ? `0 */${Math.floor(interval / 60)} * * *`
    : `*/${interval} * * * *`;

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

app.listen(PORT, "0.0.0.0", () => {
  console.log(chalk.bold.cyan("\n🛒 Price Watcher"));
  console.log(chalk.gray(`   API + UI running on http://localhost:${PORT}`));
  console.log(chalk.gray(`   Check interval: every ${interval} minutes`));
  console.log(chalk.gray(`   Products: ${configManager.getProducts().length}\n`));

  // Run initial check
  runChecks();
});
