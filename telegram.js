const axios = require("axios");
const { getPromotionDeal } = require("./lib/pricing");

/**
 * Send a Telegram message.
 * @param {string} botToken
 * @param {string} chatId
 * @param {string} text  — plain text or Markdown
 */
async function sendMessage(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await axios.post(url, {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false,
  });
}

/**
 * Build and send a price alert.
 */
function esc(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildPriceAlertMessage(product, scrapeResult, opts = {}) {
  const { price, regularPrice, unitPrice, opIsOp, title, promotion } = scrapeResult;
  const { dealViaPromo = false } = opts;

  const fmt = (n) =>
    n != null ? `€${n.toFixed(2).replace(".", ",")}` : "—";

  const savings =
    regularPrice != null && price != null ? regularPrice - price : null;

  const label = esc(product.label || title);
  const promoLabel = promotion ? esc(promotion.label) : null;
  const promoDeal = getPromotionDeal(promotion);
  const promoPrice = promoDeal?.price ?? null;
  const promoUnitSuffix = promoDeal?.unitLabel ? ` / ${promoDeal.unitLabel}` : "";

  let lines = [`🛒 <b>Prijsalert: ${label}</b>`, ""];

  if (dealViaPromo && promotion && promoDeal) {
    // Deal is via the promotion — lead with the effective promo price
    lines.push(`💶 Prijs:         ${fmt(promoPrice)}${promoUnitSuffix}`);
    lines.push(`📦 Normaal:       ${fmt(price)}${promoUnitSuffix}`);
    lines.push(`🏷️ Actie:         ${promoLabel}`);
  } else if (regularPrice != null && regularPrice !== price) {
    // Regular sale price (not promo)
    lines.push(`💶 Prijs:         ${fmt(price)}`);
    lines.push(`📦 Normaal:       ${fmt(regularPrice)}`);
    if (savings > 0) lines.push(`💰 Besparing:    ${fmt(savings)}`);
    // Show promo as additional info if present
    if (promotion && promoDeal) {
      lines.push(`🏷️ Actie:         ${promoLabel} (${fmt(promoPrice)}${promoUnitSuffix})`);
    }
  } else {
    lines.push(`💶 Prijs:         ${fmt(price)}`);
    if (promotion && promoDeal) {
      lines.push(`🏷️ Actie:         ${promoLabel} (${fmt(promoPrice)}${promoUnitSuffix})`);
    }
  }

  lines.push(`🎯 Jouw limiet:   ${fmt(product.targetPrice)}`);

  if (unitPrice) lines.push(`📏 Per eenheid:   ${unitPrice}`);
  if (opIsOp) lines.push(`\n⚡️ <b>Op=Op deal — zolang de voorraad strekt!</b>`);

  lines.push("", `🔗 ${product.url}`);

  return lines.join("\n");
}

async function sendPriceAlert(config, product, scrapeResult, opts = {}) {
  const message = buildPriceAlertMessage(product, scrapeResult, opts);

  await sendMessage(config.telegram.botToken, config.telegram.chatId, message);
}

/**
 * Send a plain test message.
 */
async function sendTestMessage(botToken, chatId) {
  await sendMessage(
    botToken,
    chatId,
    "✅ <b>Price Watcher is actief!</b>\n\nJe ontvangt een bericht zodra een product de doelprijs bereikt."
  );
}

async function discoverChat(botToken) {
  const url = `https://api.telegram.org/bot${botToken}/getUpdates`;
  const { data } = await axios.get(url);

  if (!data.ok) {
    throw new Error(data.description || "Telegram getUpdates failed");
  }

  const updates = [...(data.result || [])].reverse();
  const update = updates.find((u) => u.message?.chat?.id || u.channel_post?.chat?.id);

  if (!update) {
    throw new Error("No chat found. Open your bot in Telegram and send /start, then try again.");
  }

  const chat = update.message?.chat || update.channel_post?.chat;
  return {
    chatId: String(chat.id),
    type: chat.type,
    title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || "Telegram chat",
  };
}

module.exports = { sendMessage, buildPriceAlertMessage, sendPriceAlert, sendTestMessage, discoverChat };
