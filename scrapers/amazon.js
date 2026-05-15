const axios = require("axios");
const cheerio = require("cheerio");
const { parsePrice } = require("./parsePrice");
const { withRetry } = require("./retry");

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
};

async function scrape(url) {
  const fetchWithRetry = withRetry(axios.get);
  const res = await fetchWithRetry(url, {
    headers: HEADERS,
    timeout: 15000,
    maxRedirects: 5,
  });
  const $ = cheerio.load(res.data);

  // Amazon blocks bots aggressively — detect CAPTCHA page
  const isCaptcha =
    $("form[action='/errors/validateCaptcha']").length > 0 ||
    res.data.includes("automatische verzoeken") ||
    res.data.includes("robot");

  if (isCaptcha) {
    throw new Error("Amazon returned a CAPTCHA page — skipping this check");
  }

  const title =
    $("#productTitle").text().trim() ||
    $("h1.a-size-large").text().trim() ||
    "Unknown product";

  // Price — Amazon uses several layouts depending on deal type
  const priceText =
    $(".a-price .a-offscreen").first().text().trim() ||
    $("#priceblock_ourprice").text().trim() ||
    $("#priceblock_dealprice").text().trim() ||
    $(".apexPriceToPay .a-offscreen").first().text().trim() ||
    null;

  const regularPriceText =
    $(".a-price.a-text-price .a-offscreen").last().text().trim() ||
    $("#listPrice").text().trim() ||
    null;

  const price = parsePrice(priceText);
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
