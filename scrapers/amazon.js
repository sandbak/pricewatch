const { parsePrice } = require("./parsePrice");
const { withPuppeteerPage } = require("./puppeteerPage");

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

function normalizeAmazonUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/dp\/([A-Z0-9]{10})/i);
    if (!match) return url;
    parsed.pathname = `/dp/${match[1]}`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Navigate and extract product data from Amazon.nl using Puppeteer.
 */
async function navigateAndExtract(page, url) {
  await page.setExtraHTTPHeaders({
    "Accept-Language": HEADERS["Accept-Language"],
  });

  await page.goto(normalizeAmazonUrl(url), { waitUntil: "domcontentloaded", timeout: 30000 });
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

    const firstText = (selectors) => {
      for (const sel of selectors) {
        const text = q(sel);
        if (text) return text;
      }
      return null;
    };

    const priceFromParts = (containerSelector) => {
      const container = document.querySelector(containerSelector);
      if (!container) return null;
      const whole = container.querySelector(".a-price-whole")?.textContent?.trim() || "";
      const fraction = container.querySelector(".a-price-fraction")?.textContent?.trim() || "";
      if (!whole && !fraction) return null;
      return `€${whole}${fraction ? `.${fraction}` : ""}`;
    };

    const priceFromPartsText =
      priceFromParts("#corePrice_feature_div") ||
      priceFromParts("#corePriceDisplay_desktop_feature_div") ||
      priceFromParts("#apex_desktop") ||
      priceFromParts("#corePrice_desktop") ||
      null;

    let jsonLdPrice = null;
    let jsonLdRegularPrice = null;
    document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
      try {
        const data = JSON.parse(el.textContent);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item?.['@type'] !== "Product" && !item?.offers) continue;
          const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
          if (!offers) continue;
          if (offers.price != null) jsonLdPrice = String(offers.price);
          if (offers.lowPrice != null) jsonLdPrice = String(offers.lowPrice);
          if (offers.highPrice != null) jsonLdRegularPrice = String(offers.highPrice);
        }
      } catch {}
    });

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
    const aPrice = firstText([
      "#corePrice_feature_div .a-price .a-offscreen",
      "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
      "#apex_desktop .a-price .a-offscreen",
      "#corePrice_desktop .a-price .a-offscreen",
      "#newBuyBoxPrice",
      "#price_inside_buybox",
      ".a-price .a-offscreen",
    ]);

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

    // ── Blocking / invalid page detection ──
    const pageText = document.body.innerText.toLowerCase();
    const pageTitle = document.title || "";
    const hasCaptcha =
      pageText.includes("enter the characters you see below") ||
      pageText.includes("type the characters you see in this image") ||
      pageText.includes("robot check") ||
      document.querySelector('form[action*="validateCaptcha"]') != null;
    const pageNotFound =
      pageTitle.toLowerCase().includes("page not found") ||
      pageText.includes("the web address you entered is not a functioning page");

    return {
      title,
      apexPriceLabel,
      priceToPay,
      ourPrice,
      aPrice,
      priceFromPartsText,
      jsonLdPrice,
      jsonLdRegularPrice,
      strikePrice,
      basisPrice,
      unitPriceText,
      availability,
      hasCaptcha,
      pageNotFound,
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
      parsePrice(data.jsonLdPrice) ??
      parsePrice(data.aPrice) ??
      parsePrice(data.priceFromPartsText) ??
      parsePrice(data.ourPrice);

    if (data.hasCaptcha) {
      throw new Error("Amazon blocked the scraper with a CAPTCHA/robot check");
    }

    if (data.pageNotFound) {
      throw new Error("Amazon product page not found");
    }

    // ── Regular price (RRP/strike-through) ──
    const regularPrice =
      parsePrice(data.strikePrice) ??
      parsePrice(data.basisPrice) ??
      parsePrice(data.jsonLdRegularPrice);

    // ── Availability ──
    const outOfStock = data.availability
      ?.toLowerCase()
      .includes("currently unavailable") ||
      data.availability?.toLowerCase().includes("out of stock");

    if (price == null && !outOfStock) {
      throw new Error("Amazon price not found — page layout may have changed or Amazon blocked the request");
    }

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
