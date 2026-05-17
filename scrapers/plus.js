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
 * Capture the product details API response from OutSystems SPA.
 * The key endpoint is: /screenservices/ECP_Product_CW/ProductDetails/PDPContent/DataActionGetProductDetailsAndAgeInfo
 * Returns: { data: { ProductOut: { Overview: { Name, Price, BaseUnitPrice, ... } } } }
 */
function captureProductApi(page) {
  return new Promise((resolve) => {
    let productDetails = null;

    page.on("response", async (response) => {
      const url = response.url();
      const contentType = response.headers()["content-type"] || "";

      if (
        contentType.includes("application/json") &&
        url.includes("DataActionGetProductDetailsAndAgeInfo")
      ) {
        try {
          const body = await response.json().catch(() => null);
          if (body?.data?.ProductOut) {
            productDetails = body.data.ProductOut;
          }
        } catch {
          /* ignore */
        }
      }
    });

    // Resolve after timeout to let API calls complete
    setTimeout(() => resolve(productDetails), 8000);
  });
}

/**
 * Navigate to a URL and extract product data.
 */
async function navigateAndExtract(page, url) {
  await page.setExtraHTTPHeaders({
    "Accept-Language": HEADERS["Accept-Language"],
  });

  // Start capturing API before navigation
  const apiPromise = captureProductApi(page);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Wait for JS rendering + API calls
  await new Promise((r) => setTimeout(r, 10000));

  // Wait for product title to appear (confirms page is rendered)
  await page
    .waitForSelector("h1, [class*='product-header']", { timeout: 10000 })
    .catch(() => {
      /* proceed anyway */
    });

  const apiData = await apiPromise;

  // Extract from rendered DOM as fallback
  const domData = await page.evaluate(() => {
    const q = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.textContent.trim() : null;
    };

    // Title
    const title =
      q("h1") ||
      q("[class*='product-name']") ||
      q("[class*='product-title']") ||
      "Unknown product";

    // Price — product-price-wrapper contains the full price
    const priceText =
      q("[class*='product-price-wrapper']") ||
      q("[class*='product-price']") ||
      q("[class*='product-header-price']") ||
      null;

    // Previous/regular price (if on promotion)
    const regularPriceText =
      q("[class*='product-header-price-previous']") ||
      q("[class*='old-price']") ||
      q("[class*='original-price']") ||
      null;

    // Promotion info
    const promoText =
      q("[class*='promotion']") ||
      q("[class*='actie']") ||
      q("[class*='offer-label']") ||
      null;

    return { title, priceText, regularPriceText, promoText };
  });

  return { dom: domData, apiData };
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

    const { dom, apiData } = result;

    // ── Extract from API (most reliable) ──
    const overview = apiData?.Overview || {};
    const apiTitle = overview.Name || overview.ProductName || null;
    const apiPriceStr = overview.Price || "0";
    const apiBaseUnitPrice = overview.BaseUnitPrice || null;
    const apiSubtitle = overview.Subtitle || null;

    const apiPrice = apiPriceStr
      ? parseFloat(String(apiPriceStr).replace(",", "."))
      : null;

    // ── Title ──
    const title = apiTitle || dom.title || "Unknown product";

    // ── Prices ──
    // API price is the current selling price
    const bonusPrice =
      apiPrice ??
      parsePrice(dom.priceText);

    // Regular price: API doesn't expose original price when on promotion.
    // The DOM "product-header-price-previous" may have it.
    const regularPrice =
      parsePrice(dom.regularPriceText) ??
      bonusPrice;

    const trackedPrice =
      priceType === "bonus"
        ? bonusPrice ?? regularPrice
        : regularPrice ?? bonusPrice;

    // Unit price from subtitle: "Per Zak 500 g  (per kilo €4.78)"
    let unitPrice = null;
    if (apiSubtitle) {
      const unitMatch = apiSubtitle.match(/\(per\s+(?:kilo|kg|stuk|liter|l)\s*[€]?\s*([\d]+[.,]\d+)\)/i);
      if (unitMatch) {
        unitPrice = parseFloat(unitMatch[1].replace(",", "."));
      }
    }

    return {
      title,
      price: trackedPrice,
      regularPrice,
      unitPrice: unitPrice ? `€${unitPrice.toFixed(2).replace(".", ",")}` : null,
      opIsOp: false,
      promotion: null, // Plus doesn't expose promotion details in API
      currency: "EUR",
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = { scrape };
