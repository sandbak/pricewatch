const chalk = require("chalk");

const store = require("../lib/store");
const { getPromotionDeal, getEffectivePrice } = require("../lib/pricing");
const scrapers = require("../scrapers");
const telegram = require("../telegram");

// In-memory run locks per user to avoid duplicate concurrent checks.
const activeUserChecks = new Map();
let lastCronRunAt = null;
let lastCronFinishedAt = null;
let lastCronError = null;
let lastCronSummary = null;

function beginUserCheck(userId, details = {}) {
  if (activeUserChecks.has(userId)) return null;
  const lock = {
    userId,
    source: details.source || "unknown",
    jobId: details.jobId || null,
    startedAt: new Date().toISOString(),
  };
  activeUserChecks.set(userId, lock);
  return lock;
}

function endUserCheck(userId, lock) {
  if (activeUserChecks.get(userId) === lock) {
    activeUserChecks.delete(userId);
  }
}

function getActiveUserCheck(userId) {
  return activeUserChecks.get(userId) || null;
}

function getLastCronRunAt() {
  return lastCronRunAt;
}

function getCronStatus() {
  return {
    lastRunAt: lastCronRunAt,
    lastFinishedAt: lastCronFinishedAt,
    lastError: lastCronError,
    lastSummary: lastCronSummary,
  };
}

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
    return { id: product.id, label, ok: false, error: err.message };
  }

  if (result.price == null) {
    console.log(chalk.yellow("⚠ price not found"));
    return { id: product.id, label, ok: false, error: `price not found for ${label}` };
  }

  const entry = product;
  await store.upsertProductState(product.dbId, {
    lastPrice: result.price,
    lastChecked: new Date().toISOString(),
    promotion: result.promotion || null,
  });

  const fmt = (n) => `€${n.toFixed(2).replace(".", ",")}`;
  const promoDeal = getPromotionDeal(result.promotion);
  const effectivePrice = getEffectivePrice(result);
  const onSale = effectivePrice <= product.targetPrice;

  if (onSale) {
    if (!entry.alertSent) {
      const dealViaPromo = promoDeal?.price != null && promoDeal.price <= product.targetPrice;
      if (dealViaPromo) {
        const unitSuffix = promoDeal.unitLabel ? `/${promoDeal.unitLabel}` : "";
        console.log(
          chalk.green(
            `✓ ${fmt(promoDeal.price)}${unitSuffix} via "${promoDeal.label}" — UNDER TARGET!`
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
    label,
    ok: true,
    price: result.price,
    promotion: result.promotion || null,
    onSale,
  };
}

async function runChecks() {
  lastCronRunAt = new Date().toISOString();
  lastCronFinishedAt = null;
  lastCronError = null;
  const now = new Date().toLocaleString("nl-NL");
  console.log(chalk.bold(`\n[${now}] Running checks...`));
  const results = [];
  const errors = [];

  let users;
  try {
    users = await store.listUsersWithSettings();
  } catch (err) {
    lastCronError = err.message;
    lastCronFinishedAt = new Date().toISOString();
    throw err;
  }

  for (const u of users) {
    const interval = Math.max(360, u.check_interval_minutes || 360);
    const lastRun = u.last_run_at ? new Date(u.last_run_at).getTime() : 0;
    const due = Date.now() - lastRun >= interval * 60 * 1000;
    if (!due) continue;

    const lock = beginUserCheck(u.user_id, { source: "cron" });
    if (!lock) {
      console.log(chalk.gray(`  Skipping user ${u.user_id}: check already running`));
      continue;
    }

    try {
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
    } catch (err) {
      errors.push({ userId: u.user_id, error: err.message });
      console.error(chalk.red(`  User ${u.user_id} check failed:`), err);
    } finally {
      endUserCheck(u.user_id, lock);
    }
  }

  lastCronFinishedAt = new Date().toISOString();
  lastCronSummary = {
    users: users.length,
    checked: results.length,
    failed: results.filter((r) => !r.ok).length,
    errors: errors.length,
  };
  if (errors.length) {
    lastCronError = errors.map((err) => `user ${err.userId}: ${err.error}`).join("; ");
  }

  console.log(chalk.gray("Done.\n"));
  return {
    ok: true,
    checked: results.length,
    failed: results.filter((r) => !r.ok).length,
    errors,
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

  // Keep manual checks sequential on small Railway containers. Most scrapers
  // use Puppeteer, and concurrent Chromium pages can exhaust process limits.
  const concurrency = 1;
  const results = new Array(products.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < products.length) {
      const index = nextIndex++;
      results[index] = await checkProduct(products[index], { cfg });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, products.length) }, () => worker())
  );

  await store.touchUserRun(userId);
  return {
    ok: true,
    checked: results.length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

module.exports = {
  beginUserCheck,
  endUserCheck,
  getActiveUserCheck,
  getLastCronRunAt,
  getCronStatus,
  checkProduct,
  runChecks,
  runChecksForUser,
};
