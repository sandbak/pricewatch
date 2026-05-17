const { parsePrice } = require("./parsePrice");
const { withPuppeteerPage } = require("./puppeteerPage");

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "nl-NL,nl;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

/**
 * Navigate to a URL and extract product data from the rendered page.
 */
async function navigateAndExtract(page, url) {
  await page.setExtraHTTPHeaders({
    "Accept-Language": HEADERS["Accept-Language"],
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 5000)); // wait for JS rendering

  // Wait for product title to appear
  await page
    .waitForSelector("h1", { timeout: 10000 })
    .catch(() => {});

  const data = await page.evaluate(() => {
    const q = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.textContent.trim() : null;
    };

    // ── Title ──────────────────────────────────────────────────────────
    const title = q("h1") || "Unknown product";

    // ── JSON-LD structured data ────────────────────────────────────────
    let jsonLdPrice = null;
    let jsonLdRegularPrice = null;
    let jsonLdTitle = null;
    document
      .querySelectorAll('script[type="application/ld+json"]')
      .forEach((el) => {
        try {
          const d = JSON.parse(el.textContent);
          if (d["@type"] === "Product" && d.offers) {
            jsonLdTitle = d.name || null;
            // AggregateOffer: lowPrice = current, highPrice = regular
            if (d.offers.lowPrice != null) {
              jsonLdPrice = parseFloat(d.offers.lowPrice);
            }
            if (d.offers.highPrice != null) {
              jsonLdRegularPrice = parseFloat(d.offers.highPrice);
            }
          }
        } catch {}
      });

    // ── CSS fallbacks ──────────────────────────────────────────────────
    // Current price (prominent block)
    const currentPriceText = q(".prominent .current-price");
    // Old/promo price (only present when on offer)
    const promoPriceText = q(".promo-price");
    // Unit price
    const unitPriceText = q(".price-per-unit");

    // ── Multi-buy detection ("2 voor €X,XX") ──────────────────────────
    let promoText = null;
    const promoEls = document.querySelectorAll(
      ".promotion-tags, .promotion-details, [class*=promo-tag], [class*=actie], [class*=offer]"
    );
    for (const el of promoEls) {
      const text = el.textContent.trim();
      // Filter out related product cards by checking for 'Bekijk aanbieding' noise
      if (text.includes("Bekijk aanbieding")) continue;
      const match = text.match(/(\d+)\s*voor\s*([\d,.]+)/i);
      if (match) {
        promoText = match[0];
        break;
      }
    }

    return {
      title: title || jsonLdTitle,
      jsonLdPrice,
      jsonLdRegularPrice,
      currentPriceText,
      promoPriceText,
      unitPriceText,
      promoText,
    };
  });

  return data;
}

async function scrape(url, options = {}) {
  return withPuppeteerPage(HEADERS["User-Agent"], async (page) => {
    const data = await navigateAndExtract(page, url);

    // Prices — prefer JSON-LD, fallback to DOM
    const price =
      data.jsonLdPrice ??
      parsePrice(data.currentPriceText);

    const regularPrice =
      data.jsonLdRegularPrice ??
      parsePrice(data.promoPriceText);

    // Determine if product is on offer
    const isOnOffer =
      price != null && regularPrice != null && price < regularPrice;

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
      price,
      regularPrice,
      unitPrice: data.unitPriceText || null,
      opIsOp: false,
      promotion,
      currency: "EUR",
    };
  });
}

module.exports = { scrape };
