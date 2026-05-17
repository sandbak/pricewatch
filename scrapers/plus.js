const puppeteer = require("puppeteer");
const { parsePrice } = require("./parsePrice");
const { withRetry } = require("./retry");

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "nl-NL,nl;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

/**
 * Capture product details + promotion API responses from OutSystems SPA.
 * Two endpoints:
 * 1. DataActionGetProductDetailsAndAgeInfo → { data: { ProductOut: { Overview: { Name, Price, ... } } } }
 * 2. DataActionGetPromotionOffer → { data: { Offer: { DisplayInfo_Label, PriceOriginal_Product, NewPrice, Package, ... } } }
 */
function captureProductApis(page) {
  return new Promise((resolve) => {
    let productDetails = null;
    let promotionOffer = null;

    page.on("response", async (response) => {
      const url = response.url();
      const contentType = response.headers()["content-type"] || "";

      if (contentType.includes("application/json")) {
        try {
          const body = await response.json().catch(() => null);
          if (!body) return;

          if (url.includes("DataActionGetProductDetailsAndAgeInfo")) {
            productDetails = body.data?.ProductOut || null;
          }
          if (url.includes("DataActionGetPromotionOffer")) {
            promotionOffer = body.data?.Offer || null;
          }
        } catch {
          /* ignore */
        }
      }
    });

    setTimeout(
      () => resolve({ productDetails, promotionOffer }),
      8000
    );
  });
}

/**
 * Navigate to a URL and extract product data.
 */
async function navigateAndExtract(page, url) {
  await page.setExtraHTTPHeaders({
    "Accept-Language": HEADERS["Accept-Language"],
  });

  const apiPromise = captureProductApis(page);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 10000));

  await page
    .waitForSelector("h1, [class*='product-header']", { timeout: 10000 })
    .catch(() => {});

  const apis = await apiPromise;

  // DOM data — price is most reliable from DOM since API doesn't always reflect promo price
  const domData = await page.evaluate(() => {
    const q = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.textContent.trim() : null;
    };

    const title =
      q("h1") ||
      q("[class*='product-name']") ||
      q("[class*='product-title']") ||
      "Unknown product";

    // Current price — use the integer+decimals combo (most reliable)
    const priceInteger = q("[class*='product-header-price-integer']") || "";
    const priceDecimals = q("[class*='product-header-price-decimals']") || "";
    // Fallback: product-price div
    const priceFallback =
      q("[class*='product-price margin-top-s']") ||
      q("[class*='product-price-wrapper']") ||
      null;

    // Regular (original) price — struck-through previous price
    const regularPriceText =
      q("[class*='product-header-price-previous']") ||
      q("[class*='old-price']") ||
      null;

    // Promo label from DOM: "500 GRAM 2.49" or "2 VOOR 2.49"
    const promoLabelText = q("[class*='promo-offer-label']") || null;

    return {
      title,
      priceInteger,
      priceDecimals,
      priceFallback,
      regularPriceText,
      promoLabelText,
    };
  });

  return { dom: domData, ...apis };
}

/**
 * Parse promotion label like "2 VOOR 2.49" or "500 GRAM 2.49".
 */
function parsePromotion(offer, promoLabelText) {
  if (!offer) return null;

  const label = offer.DisplayInfo_Label || promoLabelText || "";
  const originalPrice = offer.PriceOriginal_Product
    ? parseFloat(offer.PriceOriginal_Product.replace(",", "."))
    : null;
  const newPrice = offer.NewPrice
    ? parseFloat(offer.NewPrice.replace(",", "."))
    : null;
  const package_ = offer.Package || "";

  // Multi-buy: "2 VOOR 2.49"
  const multiBuyMatch = label.match(/(\d+)\s+VOOR\s+([\d,.]+)/i);
  if (multiBuyMatch) {
    const quantity = parseInt(multiBuyMatch[1], 10);
    const totalPrice = parseFloat(multiBuyMatch[2].replace(",", "."));
    return {
      quantity,
      totalPrice,
      unitPrice: totalPrice / quantity,
      label: `${quantity} voor €${totalPrice.toFixed(2).replace(".", ",")}`,
      originalPrice,
    };
  }

  // Weight/package price: "500 GRAM 2.49"
  const weightMatch = label.match(/([\d]+)\s+GRAM\s+([\d,.]+)/i);
  if (weightMatch) {
    const grams = parseInt(weightMatch[1], 10);
    const price = parseFloat(weightMatch[2].replace(",", "."));
    const perKg = (price / grams) * 1000;
    return {
      quantity: grams,
      unit: "gram",
      totalPrice: price,
      pricePerKg: perKg,
      label: `${grams} gram €${price.toFixed(2).replace(".", ",")}`,
      originalPrice,
    };
  }

  // Fallback: just return what we have
  if (originalPrice || newPrice) {
    return {
      label,
      originalPrice,
      newPrice: newPrice || null,
      package: package_,
    };
  }

  return null;
}

async function scrape(url, options = {}) {
  const priceType = options.priceType || "regular";
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.setUserAgent(HEADERS["User-Agent"]);

    const navigateWithRetry = withRetry(navigateAndExtract);
    const result = await navigateWithRetry(page, url);

    const { dom, productDetails, promotionOffer } = result;

    // ── Extract from product details API ──
    const overview = productDetails?.Overview || {};
    const apiTitle = overview.Name || null;
    const apiSubtitle = overview.Subtitle || null;

    // ── Title ──
    const title = apiTitle || dom.title || "Unknown product";

    // ── Promotion ──
    const promotion = parsePromotion(promotionOffer, dom.promoLabelText);

    // ── Prices ──
    // DOM is authoritative for current price (API Overview.Price doesn't reflect promos)
    // Combine integer + decimals: "0." + "50" → "0.50"
    const domPriceCombined = (dom.priceInteger || "") + (dom.priceDecimals || "");
    const domPrice = domPriceCombined
      ? parseFloat(domPriceCombined.replace(",", "."))
      : null;

    const currentPrice =
      domPrice ??
      parsePrice(dom.priceFallback);

    // Regular (original) price: from promotion API or DOM
    const regularPrice =
      promotion?.originalPrice ??
      parsePrice(dom.regularPriceText) ??
      currentPrice;

    const trackedPrice = currentPrice ?? regularPrice;

    // ── Unit price from subtitle: "Per Zak 500 g  (per kilo €4.78)" ──
    let unitPrice = null;
    if (apiSubtitle) {
      const unitMatch = apiSubtitle.match(
        /\(per\s+(?:kilo|kg|stuk|liter|l)\s*[€]?\s*([\d]+[.,]\d+)\)/i
      );
      if (unitMatch) {
        unitPrice = parseFloat(unitMatch[1].replace(",", "."));
      }
    }

    return {
      title,
      price: trackedPrice,
      regularPrice,
      unitPrice: unitPrice
        ? `€${unitPrice.toFixed(2).replace(".", ",")}`
        : null,
      opIsOp: false,
      promotion,
      currency: "EUR",
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = { scrape };
