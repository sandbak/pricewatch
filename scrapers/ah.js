const { parsePrice } = require("./parsePrice");
const { withRetry } = require("./retry");
const { withPuppeteerPage } = require("./puppeteerPage");

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "nl-NL,nl;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

/**
 * Navigate to a URL and extract product data from the rendered page.
 * Wrapped in withRetry so transient failures are retried.
 */
async function navigateAndExtract(page, url) {
  await page.setExtraHTTPHeaders({
    "Accept-Language": HEADERS["Accept-Language"],
  });

  // Use domcontentloaded + explicit wait (networkidle0 times out on AH's persistent connections)
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 5000)); // wait for JS rendering

  // Wait for the product title to appear (signals the page is rendered)
  await page
    .waitForSelector("h1", { timeout: 10000 })
    .catch(() => {
      /* proceed anyway — we'll fall back to "Unknown product" */
    });

  // Extract all price-related data in a single evaluate to minimise round-trips
  const data = await page.evaluate(() => {
    const q = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.textContent.trim() : null;
    };

    // ── Title ──────────────────────────────────────────────────────────
    const title = q("h1") || "Unknown product";

    // ── JSON-LD structured data (most reliable) ────────────────────────
    let jsonLdPrice = null;
    let jsonLdTitle = null;
    document
      .querySelectorAll('script[type="application/ld+json"]')
      .forEach((el) => {
        try {
          const data = JSON.parse(el.textContent);
          if (data["@type"] === "Product" || data.offers) {
            jsonLdTitle = data.name || null;
            if (data.offers?.price) {
              jsonLdPrice = parseFloat(data.offers.price);
            }
          }
        } catch {}
      });

    // ── CSS selector fallbacks (in case JSON-LD is missing) ────────────
    // Current AH uses CSS modules — match on partial class names
    const bonusPriceText =
      q("[class*='current-price_root']") ||
      q("[class*='price-amount']") ||
      q("[class*='product-price']") ||
      null;

    const regularPriceText =
      q("[class*='price_originalPrice']") ||
      q("[class*='strikethrough']") ||
      q("[class*='was-price']") ||
      null;

    // ── Multi-buy promotion detection ("2 voor €3,99") ─────────────────
    let promoText = null;
    const promoEls = document.querySelectorAll("[class*='promo']");
    for (const el of promoEls) {
      const inRelatedProductCard = el.closest(
        "[class*='cross-sell'], [class*='product-card'], [class*='product-results']"
      );
      if (inRelatedProductCard) continue;

      const text = el.textContent.trim();
      // Match patterns like "2 voor 3.99", "3 voor 10", "2 voor €3,99"
      const match = text.match(/(\d+)\s*voor\s*€?\s*([\d,.]+)/i);
      if (match) {
        promoText = match[0]; // e.g. "2 voor 3.99"
        break;
      }
    }

    // ── Op=Op detection ────────────────────────────────────────────────
    const pageText = document.body.innerText.toLowerCase();
    const opIsOp =
      pageText.includes("op=op") ||
      pageText.includes("zolang de voorraad strekt") ||
      document.querySelectorAll("[class*='op-op'], [data-testhook*='op-op']")
        .length > 0;

    // ── Unit price ─────────────────────────────────────────────────────
    const unitPriceText =
      q("[class*='unit-price']") ||
      q("[class*='price-per-unit']") ||
      null;

    return {
      title: title || jsonLdTitle,
      jsonLdPrice,
      bonusPriceText,
      regularPriceText,
      unitPriceText,
      promoText,
      opIsOp,
    };
  });

  return data;
}

async function scrape(url, options = {}) {
  const priceType = options.priceType || "bonus";

  return withPuppeteerPage(HEADERS["User-Agent"], async (page) => {
    // Wrap navigation + extraction in withRetry
    const navigateWithRetry = withRetry(navigateAndExtract);
    const data = await navigateWithRetry(page, url);

    // Parse prices — prefer JSON-LD, fall back to CSS selectors
    const bonusPrice =
      data.jsonLdPrice ??
      parsePrice(data.bonusPriceText);
    const regularPrice = parsePrice(data.regularPriceText);

    // Which price to track
    const trackedPrice =
      priceType === "bonus"
        ? bonusPrice ?? regularPrice
        : regularPrice ?? bonusPrice;

    // Parse multi-buy promotion
    let promotion = null;
    if (data.promoText) {
      const match = data.promoText.match(/(\d+)\s*voor\s*€?\s*([\d,.]+)/i);
      if (match) {
        const quantity = parseInt(match[1], 10);
        const totalPrice = parseFloat(match[2].replace(",", "."));
        const unitPrice = totalPrice / quantity;
        promotion = {
          quantity,
          totalPrice,
          unitPrice,
          label: `${quantity} voor €${totalPrice.toFixed(2).replace(".", ",")}`,
        };
      }
    }

    return {
      title: data.title,
      price: trackedPrice,
      regularPrice: regularPrice,
      unitPrice: data.unitPriceText || null,
      opIsOp: data.opIsOp,
      promotion,
      currency: "EUR",
    };
  });
}

module.exports = { scrape };
