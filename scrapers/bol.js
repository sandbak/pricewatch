const axios = require("axios");
const cheerio = require("cheerio");
const { parsePrice } = require("./parsePrice");
const { withRetry } = require("./retry");

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "nl-NL,nl;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

/**
 * Extract product ID from a Bol.com URL.
 * e.g. ".../9300000162832351/..." → "9300000162832351"
 */
function extractProductId(url) {
  const match = url.match(/\/(\d{10,})\//);
  return match ? match[1] : null;
}

/**
 * Extract product data from JSON-LD structured data embedded in the page.
 * Handles both @type "Product" and "ProductGroup" (with hasVariant).
 */
function extractJsonLd($, url) {
  const productId = extractProductId(url);

  let product = null;
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const data = JSON.parse($(el).html());

      // Direct Product
      if (data["@type"] === "Product" && data.offers) {
        product = data;
      }

      // ProductGroup — find the matching variant by ID
      if (data["@type"] === "ProductGroup" && data.hasVariant) {
        const variant = data.hasVariant.find((v) => {
          const vid = (v.productID || v["@id"] || "").toString();
          return productId && vid.includes(productId);
        });
        if (variant?.offers) {
          product = variant;
        } else if (!product && data.hasVariant.length > 0) {
          // Fallback: no ID match, use first variant with offers
          product = data.hasVariant.find((v) => v.offers) || null;
        }
      }
    } catch {}
  });
  return product;
}

async function scrape(url) {
  const fetchWithRetry = withRetry(axios.get);
  const res = await fetchWithRetry(url, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(res.data);

  // ── Primary: JSON-LD structured data (reliable, SEO-mandated) ──────────
  const jsonLd = extractJsonLd($, url);

  const title =
    jsonLd?.name ||
    $('h1[data-test="title"]').first().text().trim() ||
    $("h1.page-heading").first().text().trim() ||
    $("h1.product-title").first().text().trim() ||
    $("h1").first().text().trim() ||
    "Unknown product";

  // Price from JSON-LD offers
  const jsonPrice = jsonLd?.offers?.price ? parseFloat(jsonLd.offers.price) : null;

  // ── Fallback: CSS selectors (in case JSON-LD is missing) ───────────────
  const priceSelectors = [
    '[data-test="price"] .price',
    '[data-test="price"]',
    ".buy-block .price",
    ".price-block__highlight",
    ".product-prices .price",
    'span[class*="price--"]',
    '[class*="buy-block"] [class*="price"]',
  ];

  let cssPriceText = null;
  for (const sel of priceSelectors) {
    const el = $(sel).first();
    if (el.length && el.text().trim()) {
      cssPriceText = el.text().trim();
      break;
    }
  }

  // Regular (was) price — CSS only, JSON-LD doesn't distinguish sale vs regular
  const regularPriceText =
    $('[data-test="from-price"]').first().text().trim() ||
    $(".price--old").first().text().trim() ||
    $('[class*="price--original"]').first().text().trim() ||
    null;

  const price = jsonPrice ?? parsePrice(cssPriceText);
  const regularPrice = parsePrice(regularPriceText);

  return {
    title,
    price,
    regularPrice,
    unitPrice: null,
    opIsOp: false,
    currency: "EUR",
  };
}

module.exports = { scrape };
