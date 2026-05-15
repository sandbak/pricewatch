const ah = require("./ah");
const bol = require("./bol");
const amazon = require("./amazon");

const SCRAPERS = {
  "ah.nl": ah,
  "bol.com": bol,
  "amazon.nl": amazon,
};

/**
 * Detect which scraper to use based on the URL.
 * @param {string} url
 * @returns {{ domain: string, scraper: object } | null}
 */
function detect(url) {
  for (const [domain, scraper] of Object.entries(SCRAPERS)) {
    if (url.includes(domain)) return { domain, scraper };
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
