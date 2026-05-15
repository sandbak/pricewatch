# 🛒 Price Watcher

Monitors product prices on **ah.nl**, **bol.com**, and **amazon.nl** and sends a **Telegram message** when a product drops to or below your target price.

## Requirements

- [Node.js](https://nodejs.org/) version 18 or higher

## Installation

```bash
npm install
```

## Setup (first time only)

```bash
node setup.js
```

The wizard will:
1. Ask for your Telegram bot token and chat ID
2. Send a test message to confirm everything works
3. Let you add products to watch
4. Write `config.json`

### Getting a Telegram bot

1. Open Telegram and message **@BotFather**
2. Send `/newbot` and follow the prompts → you get a **bot token**
3. Message your new bot (just say "hi")
4. Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in your browser
5. Find `"chat": { "id": 123456789 }` — that's your **chat ID**

## Running

```bash
node watcher.js
```

Checks prices immediately on start, then on the interval set in `config.json` (default: 60 minutes).

### Keep it running in the background

```bash
npx pm2 start watcher.js --name price-watcher
npx pm2 save          # auto-restart on reboot
npx pm2 logs price-watcher   # view logs
npx pm2 stop price-watcher   # stop it
```

## Adding more products

Either re-run `node setup.js`, or edit `config.json` directly:

```json
{
  "products": [
    {
      "id": "illy-nespresso-ah",
      "url": "https://www.ah.nl/producten/product/...",
      "targetPrice": 24.99,
      "priceType": "bonus",
      "currency": "EUR",
      "label": "Illy Nespresso 100st (AH)"
    }
  ]
}
```

**`priceType`** — use `"bonus"` for AH to track the Bonuskaart price (default). Use `"regular"` to track the standard price.

Changes to `config.json` take effect on the next check — no restart needed.

## Supported sites

| Site | Notes |
|---|---|
| `ah.nl` | Tracks Bonuskaart price by default. Detects Op=Op deals. |
| `bol.com` | Good for branded food products (Illy, Holie's, etc.) |
| `amazon.nl` | Best-effort — Amazon blocks scrapers aggressively |

## Notification format

```
🛒 Prijsalert: Illy Nespresso 100st (AH)

💶 Prijs:        €24,99
📦 Normaal:      €32,99
💰 Besparing:    €8,00
🎯 Jouw limiet:  €25,00

⚡️ Op=Op deal — zolang de voorraad strekt!

🔗 https://www.ah.nl/...
```

## Notes

- Scraping may break if a site changes its page layout. If prices stop being detected, check the logs for warnings.
- This tool is for **personal use only**. Automated scraping may conflict with a site's Terms of Service.
