const GeminiService = require('./gemini');
const logger = require('../utils/logger');

function formatDateFromTimestamp(timestampMs, timezone) {
  const date = new Date(timestampMs);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const partMap = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${partMap.year}-${partMap.month}-${partMap.day}`;
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
