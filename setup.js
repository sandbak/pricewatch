#!/usr/bin/env node

const readline = require("readline");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const CONFIG_PATH = path.join(__dirname, "config.json");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => rl.question(question, (ans) => resolve(ans.trim())));
}

function askWithDefault(question, defaultValue) {
  return new Promise((resolve) =>
    rl.question(`${question} [${defaultValue}]: `, (ans) => {
      const val = ans.trim();
      resolve(val === "" ? defaultValue : val);
    })
  );
}

async function sendTestMessage(botToken, chatId) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await axios.post(url, {
    chat_id: chatId,
    text: "✅ <b>Price Watcher is actief!</b>\n\nJe ontvangt een bericht zodra een product de doelprijs bereikt.",
    parse_mode: "HTML",
  });
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function detectPriceType(url) {
  if (url.includes("ah.nl")) return "bonus";
  return "regular";
}

/**
 * Interactive product-adding loop.
 * @param {Array} existingProducts - Already-configured products (for duplicate detection).
 * @returns {Array} Newly added products.
 */
async function promptForProducts(existingProducts = []) {
  const newProducts = [];
  const existingUrls = new Set(existingProducts.map((p) => p.url));

  console.log("\n─── Products ───────────────────────────────────────────────");
  console.log("Supported sites: ah.nl, bol.com, amazon.nl\n");

  let addMore = true;
  while (addMore) {
    console.log(`Product ${existingProducts.length + newProducts.length + 1}:`);

    const url = await ask("  Product URL: ");
    if (!url.startsWith("http")) {
      console.log("  ✗ Invalid URL, skipping.\n");
      continue;
    }

    // ── Duplicate check ──────────────────────────────────────────────────────
    if (existingUrls.has(url)) {
      const existing = existingProducts.find((p) => p.url === url);
      console.log(
        `  ⚠ Duplicate: "${existing.label}" (target: €${existing.targetPrice.toFixed(2)}) is already configured. Skipping.\n`
      );
      const more = await ask("Add another product? (y/N): ");
      addMore = more.toLowerCase() === "y";
      continue;
    }

    const labelDefault = url.includes("ah.nl")
      ? "AH product"
      : url.includes("bol.com")
      ? "Bol.com product"
      : "Amazon product";

    const label = await askWithDefault("  Label (short name)", labelDefault);
    const targetPriceStr = await ask("  Alert me when price drops to or below (€): ");
    const targetPrice = parseFloat(targetPriceStr.replace(",", "."));

    if (isNaN(targetPrice)) {
      console.log("  ✗ Invalid price, skipping.\n");
      continue;
    }

    const priceType = detectPriceType(url);
    if (url.includes("ah.nl")) {
      console.log("  ℹ AH detected — tracking Bonuskaart price by default.");
    }

    const product = {
      id: slugify(label),
      url,
      targetPrice,
      priceType,
      currency: "EUR",
      label,
    };

    newProducts.push(product);
    existingUrls.add(url);

    console.log(`  ✓ Added: ${label} (target: €${targetPrice.toFixed(2)})\n`);

    const more = await ask("Add another product? (y/N): ");
    addMore = more.toLowerCase() === "y";
  }

  return newProducts;
}

async function setupFromScratch() {
  console.log("This wizard creates your config.json.\n");

  // ── Telegram ──────────────────────────────────────────────────────────────
  console.log("─── Telegram Bot ───────────────────────────────────────────");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Send /newbot and follow the prompts");
  console.log("3. Copy the bot token you receive\n");

  const botToken = await ask("Bot token: ");
  if (!botToken.includes(":")) {
    console.error("\n✗ That doesn't look like a valid bot token (should contain a colon).");
    process.exit(1);
  }

  console.log("\nTo get your chat ID:");
  console.log("1. Send any message to your new bot on Telegram");
  console.log(`2. Open this URL in your browser:`);
  console.log(`   https://api.telegram.org/bot${botToken}/getUpdates`);
  console.log('3. Find "chat": { "id": 123456789 } — that number is your chat ID\n');

  const chatId = await ask("Chat ID: ");

  console.log("\nSending test message...");
  try {
    await sendTestMessage(botToken, chatId);
    console.log("✓ Test message sent! Check your Telegram.\n");
  } catch (err) {
    console.error(`✗ Could not send test message: ${err.message}`);
    console.error("  Double-check your bot token and chat ID, then re-run setup.\n");
    process.exit(1);
  }

  // ── Interval ──────────────────────────────────────────────────────────────
  console.log("─── Check Interval ─────────────────────────────────────────");
  const intervalStr = await askWithDefault("How often to check prices (minutes)", "60");
  const checkIntervalMinutes = parseInt(intervalStr, 10) || 60;

  // ── Products ──────────────────────────────────────────────────────────────
  const products = await promptForProducts();

  if (products.length === 0) {
    console.error("✗ No products added. Exiting.");
    process.exit(1);
  }

  // ── Write config ──────────────────────────────────────────────────────────
  const config = {
    telegram: { botToken, chatId },
    checkIntervalMinutes,
    products,
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

  console.log("─────────────────────────────────────────────────────────────");
  console.log(`✓ config.json saved with ${products.length} product(s).\n`);
  printPostSetupInstructions();
}

async function addProductsToExisting() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

  const newProducts = await promptForProducts(config.products);

  if (newProducts.length === 0) {
    console.log("\nNo new products added. Config unchanged.");
    return;
  }

  config.products.push(...newProducts);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

  console.log("─────────────────────────────────────────────────────────────");
  console.log(`✓ config.json updated — ${newProducts.length} new product(s) added.`);
  console.log(`  Total products: ${config.products.length}\n`);
  printPostSetupInstructions();
}

function printPostSetupInstructions() {
  console.log("Start the watcher:\n");
  console.log("  node watcher.js\n");
  console.log("To keep it running in the background:\n");
  console.log("  npx pm2 start watcher.js --name price-watcher");
  console.log("  npx pm2 save\n");
}

async function main() {
  console.log("\n🛒 Price Watcher — Setup\n");

  // ── Existing config? ──────────────────────────────────────────────────────
  if (fs.existsSync(CONFIG_PATH)) {
    const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    const productCount = existing.products ? existing.products.length : 0;
    const interval = existing.checkIntervalMinutes || 60;

    console.log("─── Existing Config Found ───────────────────────────────────");
    console.log(`  Products: ${productCount}`);
    console.log(`  Check interval: every ${interval} minute(s)\n`);

    const choice = await askWithDefault(
      "Config already exists. What do you want to do?\n" +
        "  1 — Add products to existing config\n" +
        "  2 — Start fresh (reconfigure everything)\n" +
        "Choice",
      "1"
    );

    if (choice === "1") {
      await addProductsToExisting();
      rl.close();
      return;
    }

    // choice === "2" (or anything else) → fall through to fresh setup
    console.log("\n");
  }

  await setupFromScratch();
  rl.close();
}

main().catch((err) => {
  console.error(`\nSetup failed: ${err.message}`);
  rl.close();
  process.exit(1);
});
