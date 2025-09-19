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
    account: null,
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
const ACCOUNT_DEFINITIONS = [
  { name: 'cash', aliases: ['cash', 'tunai'] },
  { name: 'gopay', aliases: ['gopay', 'go-pay', 'go pay', 'gojek pay'] },
  { name: 'shopeepay', aliases: ['shopeepay', 'shopee pay', 'shopee-pay'] },
  { name: 'isaku', aliases: ['isaku'] },
  { name: 'bca', aliases: ['bca', 'bank central asia', 'bank bca'] },
  {
    name: 'flazz emoney',
    aliases: ['flazz emoney', 'flazz', 'flazz e-money', 'emoney', 'e-money', 'bca flazz', 'flazz card'],
  },
  { name: 'superbank', aliases: ['superbank', 'super bank'] },
  {
    name: 'jago cloudthingy',
    aliases: ['jago cloudthingy', 'jago', 'bank jago', 'cloudthingy', 'jago cloud thingy'],
  },
];

function escapeRegExp(value) {
  return value.replace(/[-/\^$*+?.()|[\]{}]/g, '\$&');
}

const ACCOUNT_PATTERNS = ACCOUNT_DEFINITIONS.map(({ name, aliases }) => {
  const uniqueAliases = Array.from(new Set([name, ...aliases]));
  return {
    name,
    regexes: uniqueAliases.map((alias) =>
      new RegExp('\\b' + escapeRegExp(alias) + '\b', 'i')
    ),
  };
});

function normalizeAccountName(value) {
  if (!value) {
    return null;
  }

  const normalized = value.toString().trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  for (const { name, aliases } of ACCOUNT_DEFINITIONS) {
    if (name === normalized) {
      return name;
    }

    for (const alias of aliases) {
      if (alias.toLowerCase() === normalized) {
        return name;
      }
    }
  }

  return null;
}

function findAccountInText(text) {
  if (!text) {
    return null;
  }

  for (const { name, regexes } of ACCOUNT_PATTERNS) {
    for (const regex of regexes) {
      if (regex.test(text)) {
        return name;
      }
    }
  }

  return null;
}

function resolveAccount({ override, parsedAccount, textCandidates }) {
  const normalizedOverride = normalizeAccountName(override);
  if (override && !normalizedOverride) {
    logger.warn(
      'ExpenseParser',
      `Account override "${override}" is not recognized; ignoring override.`
    );
  }
  if (normalizedOverride) {
    return normalizedOverride;
  }

  const normalizedParsed = normalizeAccountName(parsedAccount);
  if (normalizedParsed) {
    return normalizedParsed;
  }

  for (const candidate of textCandidates || []) {
    if (!candidate) {
      continue;
    }

    const detected = findAccountInText(candidate);
    if (detected) {
      return detected;
    }
  }

  return null;
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

  async parse({ text, media, timestampMs, accountOverride, rawText }) {
    const fallbackDate = formatDateFromTimestamp(timestampMs, this.timezone);
    const sanitizedText = text || '';
    const originalText = rawText || text || '';
    let expense;

    if (media) {
      try {
        logger.info('ExpenseParser', 'Attempting image-based extraction via Gemini');
        expense = await this.geminiService.parseImageExpense(
          {
            base64Data: media.base64Data,
            mimeType: media.mimeType,
            accompanyingText: sanitizedText,
          },
          fallbackDate
        );
      } catch (error) {
        logger.error('ExpenseParser', 'Gemini image parsing failed', error);
        logger.info('ExpenseParser', 'Falling back to text parser after image failure');
        if (sanitizedText) {
          expense = fallbackParseText(sanitizedText, fallbackDate, this.defaultCurrency);
        } else {
          throw error;
        }
      }
    } else {
      try {
        logger.info('ExpenseParser', 'Attempting text-based extraction via Gemini');
        expense = await this.geminiService.parseTextExpense(sanitizedText, fallbackDate);
      } catch (error) {
        logger.error('ExpenseParser', 'Gemini text parsing failed', error);
        logger.info('ExpenseParser', 'Falling back to regex parser for text message');
        expense = fallbackParseText(sanitizedText, fallbackDate, this.defaultCurrency);
      }
    }

    const account = resolveAccount({
      override: accountOverride,
      parsedAccount: expense.account,
      textCandidates: [sanitizedText, originalText, expense.description, expense.merchant],
    });

    expense.account = account;

    if (account) {
      logger.info('ExpenseParser', `Resolved account "${account}" for parsed payload.`);
    }

    return expense;
  }
}

module.exports = ExpenseParser;
