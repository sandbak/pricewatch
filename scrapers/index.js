const ah = require("./ah");
const bol = require("./bol");
const amazon = require("./amazon");
const plus = require("./plus");

const SCRAPERS = {
  "ah.nl": ah,
  "bol.com": bol,
  "amazon.nl": amazon,
  "plus.nl": plus,
};

/**
 * Detect which scraper to use based on the URL.
 * @param {string} url
 * @returns {{ domain: string, scraper: object } | null}
 */
function detect(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }

  for (const [domain, scraper] of Object.entries(SCRAPERS)) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return { domain, scraper };
  }
  return null;
}

/**
 * Scrape a product URL.
 * @param {string} url
 * @param {object} options  — e.g. { priceType: 'bonus' }
 */
async function scrape(url, options = {}) {
  const match = detect(url);
  if (!match) {
    throw new Error(`No scraper available for URL: ${url}`);
  }
  return match.scraper.scrape(url, options);
}

module.exports = { scrape, detect, SUPPORTED_DOMAINS: Object.keys(SCRAPERS) };
