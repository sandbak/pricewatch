const { parsePrice } = require("./parsePrice");
const { withPuppeteerPage } = require("./puppeteerPage");

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

/**
 * Navigate and extract product data from Amazon.nl using Puppeteer.
 */
async function navigateAndExtract(page, url) {
  await page.setExtraHTTPHeaders({
    "Accept-Language": HEADERS["Accept-Language"],
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 5000)); // wait for JS rendering

  // Wait for product title or price area
  await page
    .waitForSelector("#productTitle, h1, #apex_desktop", { timeout: 10000 })
    .catch(() => {});

  return await page.evaluate(() => {
    const q = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.textContent.trim() : null;
    };

    // ── Title ──
    const title =
      q("#productTitle") ||
      q("h1.a-size-large") ||
      q("h1") ||
      document.title.split(" - ")[0].trim() ||
      "Unknown product";

    // ── Price: Amazon Apex layout ──
    // Current price from accessibility label (most reliable)
    const apexPriceLabel = q("#apex-pricetopay-accessibility-label");
    // Fallback: price to pay span
    const priceToPay = q("[data-pricetopay-label]");

    // Our price / deal price
    const ourPrice =
      q("#priceblock_ourprice") ||
      q("#priceblock_dealprice") ||
      null;

    // CSS class-based selectors
    const aPrice = q(".a-price .a-offscreen");

    // ── Regular/List price (RRP, crossed-out) ──
    // Apex layout: strike-through price
    const strikePrice = q("[class*='a-text-strike']");
    // Fallback: basisprice value
    const basisPrice = q("[class*='apex-basisprice-value']");

    // ── Unit price ──
    const unitPriceText =
      q("[data-a-size='medium']") ||
      null;

    // ── Availability ──
    const availability = q("#availability") || q(".a-color-state") || null;

    // ── Full page text for price extraction ──
    const apexDesktop = q("#apex_desktop");
    const corePrice = q("#corePriceDisplay_desktop_feature_div");

    return {
      title,
      apexPriceLabel,
      priceToPay,
      ourPrice,
      aPrice,
      strikePrice,
      basisPrice,
      unitPriceText,
      availability,
    };
  });
}

async function scrape(url, options = {}) {
  return withPuppeteerPage(HEADERS["User-Agent"], async (page) => {
    const data = await navigateAndExtract(page, url);

    // ── Title ──
    const title = data.title;

    // ── Price ──
    // Priority: apex accessibility label > a-offscreen > ourprice
    // The apex label contains "€43.00 with 9 percent savings" — parse the price
    const price =
      parsePrice(data.apexPriceLabel) ??
      parsePrice(data.priceToPay) ??
      parsePrice(data.aPrice) ??
      parsePrice(data.ourPrice);

    // ── Regular price (RRP/strike-through) ──
    const regularPrice =
      parsePrice(data.strikePrice) ??
      parsePrice(data.basisPrice);

    // ── Availability ──
    const outOfStock = data.availability
      ?.toLowerCase()
      .includes("currently unavailable") ||
      data.availability?.toLowerCase().includes("out of stock");

    return {
      title,
      price,
      regularPrice,
      unitPrice: null,
      opIsOp: false,
      promotion: null,
      currency: "EUR",
      outOfStock: !!outOfStock,
    };
  });
}

module.exports = { scrape };
