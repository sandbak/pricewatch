#!/usr/bin/env node

const cron = require("node-cron");
const chalk = require("chalk");
const fs = require("fs");
const path = require("path");

const scrapers = require("./scrapers");
const telegram = require("./telegram");
const stateManager = require("./state");

const CONFIG_PATH = path.join(__dirname, "config.json");

// ─── Load config ───────────────────────────────────────────────────────────

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(chalk.red("\n✗ config.json not found.\n"));
    console.error("Run the setup wizard first:\n");
    console.error(chalk.cyan("  node setup.js\n"));
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

// ─── Check a single product ────────────────────────────────────────────────

async function checkProduct(product, config, state) {
  const label = product.label || product.id;
  process.stdout.write(chalk.gray(`  Checking ${label}... `));

  let result;
  try {
    result = await scrapers.scrape(product.url, { priceType: product.priceType || "bonus" });
  } catch (err) {
    console.log(chalk.yellow(`⚠ scrape failed: ${err.message}`));
    return;
  }

  if (result.price == null) {
    console.log(chalk.yellow("⚠ price not found (product may be out of stock or page changed)"));
    return;
  }

  const entry = stateManager.get(state, product.id);

  stateManager.set(state, product.id, {
    lastPrice: result.price,
    lastChecked: new Date().toISOString(),
  });

  const fmt = (n) => `€${n.toFixed(2).replace(".", ",")}`;

  // ── Promotion-aware pricing ──────────────────────────────────────────────
  const promoUnitPrice = result.promotion?.unitPrice ?? null;
  const effectivePrice =
    promoUnitPrice != null ? Math.min(result.price, promoUnitPrice) : result.price;
  const onSale = effectivePrice <= product.targetPrice;
  const dealViaPromo = promoUnitPrice != null && promoUnitPrice <= product.targetPrice;

  if (onSale) {
    if (!entry.alertSent) {
      if (dealViaPromo) {
        console.log(
          chalk.green(
            `✓ ${fmt(promoUnitPrice)}/unit via "${result.promotion.label}" — UNDER TARGET! Sending alert...`
          )
        );
      } else {
        console.log(chalk.green(`✓ ${fmt(result.price)} — UNDER TARGET! Sending alert...`));
      }
      try {
        await telegram.sendPriceAlert(config, product, result, { dealViaPromo });
        stateManager.set(state, product.id, { alertSent: true });
        console.log(chalk.green("    ✓ Telegram alert sent"));
      } catch (err) {
        console.log(chalk.red(`    ✗ Telegram send failed: ${err.message}`));
      }
    } else {
      if (dealViaPromo) {
        console.log(
          chalk.green(
            `✓ ${fmt(promoUnitPrice)}/unit via "${result.promotion.label}" — still under target (alert already sent)`
          )
        );
      } else {
        console.log(chalk.green(`✓ ${fmt(result.price)} — still under target (alert already sent)`));
      }
    }
  } else {
    if (entry.alertSent) {
      stateManager.set(state, product.id, { alertSent: false });
      console.log(chalk.blue(`↑ ${fmt(result.price)} — price back above target (alert reset)`));
    } else {
      const priceChanged = entry.lastPrice !== result.price;
      const marker = priceChanged ? chalk.blue("↕") : chalk.gray("–");
      const promoHint =
        promoUnitPrice != null ? ` · promo: ${fmt(promoUnitPrice)}/unit` : "";
      console.log(`${marker} ${fmt(result.price)} (target: ${fmt(product.targetPrice)}${promoHint})`);
    }
  }
}

// ─── Run all checks ────────────────────────────────────────────────────────

async function runChecks(config) {
  const now = new Date().toLocaleString("nl-NL");
  console.log(chalk.bold(`\n[${now}] Running checks...`));

  const state = stateManager.load();

  for (const product of config.products) {
    await checkProduct(product, config, state);
    stateManager.save(state);
    await new Promise((r) => setTimeout(r, 2000)); // 2s between requests
  }

  console.log(chalk.gray("Done.\n"));
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();

  console.log(chalk.bold.cyan("\n🛒 Price Watcher starting up"));
  console.log(chalk.gray(`Tracking ${config.products.length} product(s)`));
  console.log(chalk.gray(`Check interval: every ${config.checkIntervalMinutes} minutes\n`));

  for (const product of config.products) {
    const match = scrapers.detect(product.url);
    if (!match) {
      console.warn(chalk.yellow(`⚠ No scraper for: ${product.url}`));
      console.warn(chalk.yellow(`  Supported: ${scrapers.SUPPORTED_DOMAINS.join(", ")}\n`));
    }
  }

  await runChecks(config);

  const interval = Math.max(1, config.checkIntervalMinutes || 60);
  const cronExpression = interval >= 60
    ? `0 */${Math.floor(interval / 60)} * * *`
    : `*/${interval} * * * *`;

  cron.schedule(cronExpression, () => {
    const freshConfig = loadConfig();
    runChecks(freshConfig);
  });

  console.log(chalk.cyan(`Scheduled — next check in ${interval} minutes.`));
  console.log(chalk.gray("Press Ctrl+C to stop.\n"));
}

main().catch((err) => {
  console.error(chalk.red(`Fatal error: ${err.message}`));
  process.exit(1);
});
