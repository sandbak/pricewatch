# 🛒 Price Watcher

Web app for tracking product prices and sending Telegram alerts when a product drops to or below your target price.

## Supported shops

| Shop | Notes |
|---|---|
| `ah.nl` | Tracks Bonuskaart price by default. Detects Op=Op and multi-buy deals. |
| `bol.com` | Uses product structured data where available. |
| `plus.nl` | Supports promotions from PLUS product APIs. |
| `jumbo.com` | Supports regular offers and `2 voor` multi-buy deals. |

### Temporarily suspended shops

| Shop | Notes |
|---|---|
| `amazon.nl` | Temporarily removed from the frontend because Amazon.nl returns HTTP 503 block pages from Railway/server-side scraping. The Amazon scraper/backend code remains in the repository for potential future development, such as proxy-based or API-based support. |

## Requirements

- Node.js 20+
- PostgreSQL database
- Clerk app for authentication
- Optional Telegram bot for alerts

## Local development

```bash
npm install
cd client && npm install && cd ..
npm run dev
```

The API runs from `server.js`; the Vite frontend runs from `client/`.

## Environment variables

Copy `.env.example` to `.env` and fill in:

```bash
CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
VITE_CLERK_PUBLISHABLE_KEY=
VITE_CLERK_PROXY_URL=
DATABASE_URL=
```

Telegram credentials are configured per user in the web UI, not in local config files.

## Production

```bash
npm run build
npm start
```

On Railway, deploy the app with a Postgres service and the environment variables above.

## How checks work

- Users add products in the web UI.
- Product data and per-user settings are stored in Postgres.
- The server runs a cron every minute and enforces each user's configured check interval, entered in hours with a 6-hour minimum.
- Users can also trigger a manual "Check now" run from the UI.

## Notification format

```text
🛒 Prijsalert: Illy Nespresso 100st (AH)

💶 Prijs:        €24,99
📦 Normaal:      €32,99
💰 Besparing:    €8,00
🎯 Jouw limiet:  €25,00

🔗 https://www.ah.nl/...
```

## Notes

- Scraping may break if a shop changes its page layout.
- This tool is for personal use only. Automated scraping may conflict with a site's Terms of Service.
