# WhatsApp Daily Expense Logger

Automates expense tracking by monitoring a WhatsApp account, parsing incoming expense messages (text or receipt images) with Google Gemini, and logging structured entries into Google Sheets or a local CSV fallback. After processing, the bot replies in WhatsApp with a confirmation summary.

## Features

- Listens for WhatsApp messages via [`whatsapp-web.js`](https://wwebjs.dev/)
- Uses Gemini for OCR and natural language parsing of receipts and free-form text
- Logs structured records (`timestamp`, `date`, `category`, `description`, `amount`, `currency`, `merchant`, `source`, `chat_name`, `message_id`) to Google Sheets or CSV
- Sends confirmation replies or friendly errors when parsing fails
- Optional chat allowlist for production safety

## Prerequisites

1. Node.js 18+
2. Google Gemini API key (`https://ai.google.dev/`)
3. Google Cloud service account with the *Google Sheets API* enabled (optional if using CSV only)
4. Target Google Sheet shared with the service account email (edit permission)

## Setup

```bash
npm install
cp .env.example .env # edit with your values
```

Key environment variables:

| Name | Required | Description |
| ---- | -------- | ----------- |
| `GEMINI_API_KEY` | ✅ | Gemini API key used for OCR and parsing |
| `GEMINI_MODEL` | ❌ | Override model (default `gemini-1.5-flash`) |
| `GOOGLE_SHEETS_ID` | ⚠️ | Spreadsheet ID; omit to use CSV fallback |
| `GOOGLE_SHEETS_TAB` | ⚠️ | Worksheet/tab name (default `Expenses`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | ⚠️ | JSON string or file path to service-account credentials |
| `LOCAL_CSV_PATH` | ❌ | CSV path fallback (default `./data/expenses.csv`) |
| `DEFAULT_CURRENCY` | ❌ | Used when Gemini cannot infer a currency (default `USD`) |
| `DEFAULT_TIMEZONE` | ❌ | Timezone for date stamping (default `UTC`) |
| `ALLOWED_CHAT_IDS` | ❌ | Comma-separated WhatsApp chat IDs to whitelist |
| `WHATSAPP_SESSION_PATH` | ❌ | Path for `LocalAuth` session cache (default `.wwebjs_auth`) |

> The service account JSON must include `client_email` and `private_key`. When using a file path, ensure the process can read it.

## Running

```bash
npm run start
```

- On first launch, a QR code prints to the console. Scan it with WhatsApp on your phone to link the session.
- Keep the machine running to maintain the WhatsApp Web session. The `.wwebjs_auth/` directory stores credentials.

## Docker

Quick start with Docker Compose (recommended for homelab):

```bash
cp .env.example .env # fill in your values
docker compose build
# First run in foreground to scan the QR code
docker compose up
# After the session is linked, you can run detached
# docker compose up -d
```

What this does:

- Uses a Chromium-ready base image for Puppeteer.
- Persists WhatsApp auth in `./.wwebjs_auth` so you don’t have to relink.
- Persists CSV fallback logs under `./data`.
- Reads configuration from your local `.env`.

Notes:

- To use Google Sheets via file credentials, mount `service-account.json` and set `GOOGLE_SERVICE_ACCOUNT_JSON=service-account.json` in `.env`.
- On first launch, watch the compose logs to see the QR code (or run without `-d`).
- If you ever need to relink WhatsApp, stop the container and delete `./.wwebjs_auth` before starting again.

## WhatsApp Interaction

- **Text**: Send messages like `Lunch 12.50 USD` or `Groceries at Target 48.90`.
- **Images**: Send receipt photos. Optionally add a caption for clarification.
- The bot replies with a confirmation such as `Recorded: Lunch – $12.50 on 2024-03-17. Category: Food.`
- If parsing fails, you receive `Could not record expense...` with guidance to retry.

## Troubleshooting

- Ensure Gemini and Google Sheets credentials are valid and not rate-limited.
- Delete `.wwebjs_auth/` if you need to re-link WhatsApp (will require scanning the QR again).
- Check `data/expenses.csv` when running without Google Sheets.

## Roadmap Ideas

- Multi-user routing & per-chat spreadsheets
- Aggregated summaries via scheduled WhatsApp messages
- Enhanced categorization with user-trained examples
