const fs = require("fs");
const path = require("path");
const store = require("./store");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");
const STATE_PATH = path.join(__dirname, "..", "state.json");

function readJsonSafe(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

async function migrateLegacyForUser(clerkUserId, env) {
  if (!clerkUserId) return { migrated: false, reason: "no-owner" };

  const user = await store.getOrCreateUser(clerkUserId);
  const existing = await store.listProducts(user.id);
  if (existing.length > 0) return { migrated: false, reason: "already-has-products" };

  const config = readJsonSafe(CONFIG_PATH, { products: [], checkIntervalMinutes: 60 });
  const state = readJsonSafe(STATE_PATH, {});
  const products = Array.isArray(config.products) ? config.products : [];

  if (!products.length) return { migrated: false, reason: "no-legacy-products" };

  await store.updateSettings(user.id, {
    checkIntervalMinutes: config.checkIntervalMinutes || 60,
    botToken: env.get("TELEGRAM_BOT_TOKEN") || undefined,
    chatId: env.get("TELEGRAM_CHAT_ID") || undefined,
  });

  let count = 0;
  for (const p of products) {
    const created = await store.addProduct(user.id, {
      id: p.id,
      url: p.url,
      label: p.label,
      targetPrice: p.targetPrice,
      priceType: p.priceType || "regular",
      currency: p.currency || "EUR",
    });

    const s = state[p.id] || {};
    await store.upsertProductState(created.dbId, {
      lastPrice: s.lastPrice ?? null,
      lastChecked: s.lastChecked ?? null,
      alertSent: s.alertSent ?? false,
      promotion: s.promotion || null,
    });
    count += 1;
  }

  return { migrated: true, count };
}

module.exports = { migrateLegacyForUser };
