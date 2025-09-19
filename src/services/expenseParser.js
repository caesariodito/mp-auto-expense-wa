const GeminiService = require('./gemini');
const logger = require('../utils/logger');

const OFFSET_TIMEZONE_REGEX = /^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/i;

function parseOffsetTimezone(value) {
  if (!value) {
    return null;
  }

  const match = OFFSET_TIMEZONE_REGEX.exec(value.trim());
  if (!match) {
    return null;
  }

  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number.parseInt(match[2], 10);
  const minutes = match[3] ? Number.parseInt(match[3], 10) : 0;

  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return null;
  }

  return sign * (hours * 60 + minutes);
}

function formatDateFromTimestamp(timestampMs, timezone) {
  const date = new Date(timestampMs);

  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.formatToParts(date);
    const partMap = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return `${partMap.year}-${partMap.month}-${partMap.day}`;
  } catch (error) {
    const offsetMinutes = parseOffsetTimezone(timezone);

    if (offsetMinutes !== null) {
      const adjusted = new Date(date.getTime() + offsetMinutes * 60 * 1000);
      return adjusted.toISOString().slice(0, 10);
    }

    logger.warn(
      'ExpenseParser',
      `Invalid timezone "${timezone}" provided. Falling back to UTC.`
    );
    return new Date(timestampMs).toISOString().slice(0, 10);
  }
}

function fallbackParseText(text, fallbackDate, defaultCurrency) {
  const match =
    text &&
    text.match(
      /^(?<description>[\p{L}\s]+?)\s*(?<amount>[0-9]+[\d.,]*)\s*(?<currency>[A-Za-z]{3}|[$€£])?/u
    );

  if (!match) {
    throw new Error('Fallback parser could not understand the message');
  }

  const { description, amount, currency } = match.groups;
  const sanitizedAmount = Number.parseFloat(amount.replace(/,/g, ''));

  logger.info(
    'ExpenseParser',
    `Fallback parser extracted description="${description.trim()}" amount=${sanitizedAmount} currency=${currency || 'default'}`
  );

  return {
    date: fallbackDate,
    description: description.trim(),
    category: 'General',
    amount: sanitizedAmount,
    currency: normalizeCurrency(currency, defaultCurrency),
    merchant: null,
  };
}

function normalizeCurrency(currency, defaultCurrency) {
  if (!currency) {
    return defaultCurrency;
  }

  const trimmed = currency.trim().toUpperCase();
  if (trimmed === '$') return 'USD';
  if (trimmed === '€') return 'EUR';
  if (trimmed === '£') return 'GBP';
  if (trimmed.length === 3) return trimmed;
  return defaultCurrency;
}

class ExpenseParser {
  constructor({ config }) {
    this.defaultCurrency = config.defaults.currency;
    this.timezone = config.defaults.timezone;
    this.geminiService = new GeminiService({
      apiKey: config.gemini.apiKey,
      model: config.gemini.model,
      defaults: { currency: this.defaultCurrency },
    });
  }

  async parse({ text, media, timestampMs }) {
    const fallbackDate = formatDateFromTimestamp(timestampMs, this.timezone);

    if (media) {
      try {
        logger.info('ExpenseParser', 'Attempting image-based extraction via Gemini');
        return await this.geminiService.parseImageExpense(
          {
            base64Data: media.base64Data,
            mimeType: media.mimeType,
            accompanyingText: text,
          },
          fallbackDate
        );
      } catch (error) {
        logger.error('ExpenseParser', 'Gemini image parsing failed', error);
        logger.info('ExpenseParser', 'Falling back to text parser after image failure');
        if (text) {
          return fallbackParseText(text, fallbackDate, this.defaultCurrency);
        }
        throw error;
      }
    }

    try {
      logger.info('ExpenseParser', 'Attempting text-based extraction via Gemini');
      return await this.geminiService.parseTextExpense(text, fallbackDate);
    } catch (error) {
      logger.error('ExpenseParser', 'Gemini text parsing failed', error);
      logger.info('ExpenseParser', 'Falling back to regex parser for text message');
      return fallbackParseText(text, fallbackDate, this.defaultCurrency);
    }
  }
}

module.exports = ExpenseParser;
