const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

function parseList(value) {
  return value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const normalized = value.toString().trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function parseInteger(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function resolveServiceAccount(rawValue) {
  if (!rawValue) {
    return null;
  }

  try {
    return JSON.parse(rawValue);
  } catch (err) {
    const resolvedPath = path.isAbsolute(rawValue)
      ? rawValue
      : path.join(process.cwd(), rawValue);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(
        'GOOGLE_SERVICE_ACCOUNT_JSON must be a JSON string or a valid file path'
      );
    }
    const fileContents = fs.readFileSync(resolvedPath, 'utf8');
    return JSON.parse(fileContents);
  }
}

const config = {
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
  },
  googleSheets: {
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    tabName: process.env.GOOGLE_SHEETS_TAB || 'Expenses',
    serviceAccount: resolveServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  },
  localCsvPath: process.env.LOCAL_CSV_PATH || path.join(process.cwd(), 'data/expenses.csv'),
  defaults: {
    currency: process.env.DEFAULT_CURRENCY || 'USD',
    timezone: process.env.DEFAULT_TIMEZONE || 'UTC',
  },
  whatsapp: {
    allowedChatIds: parseList(process.env.ALLOWED_CHAT_IDS),
    sessionPath: process.env.WHATSAPP_SESSION_PATH || '.wwebjs_auth',
    replyEnabled: parseBoolean(process.env.WHATSAPP_REPLY_ENABLED, false),
    chatLogLimit: parseInteger(process.env.WHATSAPP_CHAT_LOG_LIMIT, 10),
    selfMessagesOnly: parseBoolean(process.env.WHATSAPP_SELF_MESSAGES_ONLY, true),
  },
};

module.exports = config;
