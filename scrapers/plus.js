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
 * Intercept API responses from the OutSystems SPA to extract product data.
 * OutSystems apps call internal REST/JSON APIs — we capture and parse them.
 */
function captureApiResponse(page) {
  return new Promise((resolve) => {
    const result = { apiData: null };

    // Intercept responses — OutSystems typically uses JSON APIs
    page.on("response", async (response) => {
      const url = response.url();
      // OutSystems API endpoints typically contain "/api/" or return JSON
      if (
        (url.includes("/api/") ||
          url.includes("/widget/") ||
          url.includes("/block/") ||
          response.headers()["content-type"]?.includes("application/json")) &&
        !url.includes("OutSystems") &&
        !url.includes("manifest")
      ) {
        try {
          const body = await response.json().catch(() => null);
          if (body && !result.apiData) {
            result.apiData = body;
          }
        } catch {
          /* ignore non-JSON */
        }
      }
    });

    // Resolve after timeout to let API calls complete
    setTimeout(() => resolve(result.apiData), 6000);
  });
}

/**
 * Navigate to a URL and extract product data from the rendered page.
 */
async function navigateAndExtract(page, url) {
  await page.setExtraHTTPHeaders({
    "Accept-Language": HEADERS["Accept-Language"],
  });

  // Start capturing API responses before navigation
  const apiPromise = captureApiResponse(page);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Wait for JS rendering + API calls
  await new Promise((r) => setTimeout(r, 8000));

  // Wait for product title to appear
  await page
    .waitForSelector("h1, [class*='title'], [class*='product-name']", {
      timeout: 10000,
    })
    .catch(() => {
      /* proceed anyway */
    });

  // Capture API data
  const apiData = await apiPromise;

  // Extract from rendered DOM
  const data = await page.evaluate(() => {
    const q = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.textContent.trim() : null;
    };

    // ── Title ──
    const title =
      q("h1") ||
      q("[class*='product-name']") ||
      q("[class*='product-title']") ||
      q("[class*='title']") ||
      "Unknown product";

    // ── JSON-LD structured data ──
    let jsonLdPrice = null;
    let jsonLdRegularPrice = null;
    let jsonLdTitle = null;
    document
      .querySelectorAll('script[type="application/ld+json"]')
      .forEach((el) => {
        try {
          const d = JSON.parse(el.textContent);
          const offers = d.offers || (d.graph ? d.graph?.[0]?.offers : null);
          if (d["@type"] === "Product" || offers) {
            jsonLdTitle = d.name || null;
            if (offers?.price) {
              jsonLdPrice = parseFloat(offers.price);
            }
            // LowPrice/Offer price vs regular
            if (offers?.priceSpecification) {
              jsonLdRegularPrice = parseFloat(
                offers.priceSpecification?.price || 0
              );
            }
          }
        } catch {}
      });

    // ── Price selectors (generic, for JS-rendered content) ──
    // Look for price patterns in text content
    const priceText =
      q("[class*='price']") ||
      q("[class*='product-price']") ||
      q("[data-testid*='price']") ||
      null;

    // Offer/promo price
    const offerPriceText =
      q("[class*='offer-price']") ||
      q("[class*='sale-price']") ||
      q("[class*='promotion']") ||
      q("[class*='actieprij']") ||
      q("[class*='actie-prijs']") ||
      null;

    // Regular/old price (strikethrough)
    const regularPriceText =
      q("[class*='old-price']") ||
      q("[class*='regular-price']") ||
      q("[class*='original-price']") ||
      q("[class*='strikethrough']") ||
      q("s[class*='price']") ||
      null;

    // Promotion text
    let promoText = null;
    const promoEls = document.querySelectorAll(
      "[class*='promo'], [class*='actie'], [class*='offer'], [class*='sale']"
    );
    for (const el of promoEls) {
      const text = el.textContent.trim();
      // Match Dutch promo patterns
      const match = text.match(/(\d+)\s*voor\s*€?\s*([\d,.]+)/i);
      if (match) {
        promoText = match[0];
        break;
      }
    }

    return {
      title,
      jsonLdTitle,
      jsonLdPrice,
      jsonLdRegularPrice,
      priceText,
      offerPriceText,
      regularPriceText,
      promoText,
      pageBody: document.body.innerText.substring(0, 3000),
    };
  });

  return { dom: data, apiData };
}

/**
 * Try to extract price from API response data (OutSystems JSON).
 */
function extractFromApi(apiData) {
  if (!apiData) return null;

  // Flatten nested object to find price-like fields
  const flatten = (obj, prefix = "") => {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (typeof value === "object" && value !== null) {
        Object.assign(result, flatten(value, fullKey));
      } else {
        result[fullKey] = value;
      }
    }
    return result;
  };

  const flat = flatten(apiData);
  const keys = Object.keys(flat);

  // Look for price fields
  for (const key of keys) {
    const lowerKey = key.toLowerCase();
    const value = flat[key];
    if (
      (lowerKey.includes("price") ||
        lowerKey.includes("prij") ||
        lowerKey.includes("amount")) &&
      typeof value === "number" &&
      value > 0
    ) {
      return { price: value, source: "api", field: key };
    }
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

    const { dom, apiData } = result;

    // Try API extraction first (most reliable for OutSystems SPAs)
    const apiExtraction = extractFromApi(apiData);

    // Title
    const title = dom.title || dom.jsonLdTitle || "Unknown product";

    // Prices — priority: JSON-LD > API > CSS selectors
    const bonusPrice =
      dom.jsonLdPrice ??
      (apiExtraction ? apiExtraction.price : null) ??
      parsePrice(dom.offerPriceText) ??
      parsePrice(dom.priceText);

    const regularPrice =
      dom.jsonLdRegularPrice ??
      parsePrice(dom.regularPriceText) ??
      bonusPrice;

    const trackedPrice =
      priceType === "bonus"
        ? bonusPrice ?? regularPrice
        : regularPrice ?? bonusPrice;

    // Promotion
    let promotion = null;
    if (dom.promoText) {
      const match = dom.promoText.match(/(\d+)\s*voor\s*€?\s*([\d,.]+)/i);
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
      title,
      price: trackedPrice,
      regularPrice,
      unitPrice: null,
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
