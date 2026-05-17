const puppeteer = require("puppeteer");

async function withPuppeteerPage(userAgent, fn) {
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    if (userAgent) {
      await page.setUserAgent(userAgent);
    }

    return await fn(page);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = { withPuppeteerPage };
