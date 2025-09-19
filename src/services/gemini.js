const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../utils/logger');

function cleanJsonResponse(raw) {
  if (!raw) {
    throw new Error('Gemini response was empty');
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`Unable to locate JSON in Gemini response: ${raw}`);
  }

  const jsonSlice = raw.slice(start, end + 1);
  return JSON.parse(jsonSlice);
}

function coerceNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const sanitized = String(value).replace(/[^\d.,-]/g, '').replace(',', '.');
  const parsed = Number.parseFloat(sanitized);
  return Number.isFinite(parsed) ? parsed : null;
}

class GeminiService {
  constructor({ apiKey, model, defaults }) {
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is required to initialize GeminiService');
    }

    this.defaultCurrency = defaults?.currency || 'USD';
    this.client = new GoogleGenerativeAI(apiKey);
    this.modelName = model || 'gemini-1.5-flash';
    this.model = this.client.getGenerativeModel({ model: this.modelName });
  }

  buildPrompt({ fallbackDate }) {
    return `You are an AI assistant that extracts structured expense data. Always respond with a single JSON object using this schema:
{
  "date": "YYYY-MM-DD",
  "description": string,
  "category": string,
  "amount": number,
  "currency": ISO 4217 currency code (3 letters),
  "merchant": string | null,
  "account": string | null
}

Rules:
- If the input lacks a date, use the provided fallback date (${fallbackDate}).
- If multiple amounts exist, choose the total the customer paid.
- Normalize the currency to its ISO 4217 alpha code (e.g., USD, EUR). Infer from symbols when necessary. Default to ${this.defaultCurrency} when unsure.
- Keep the description short (<=60 characters) and human readable.
- Category should be a single word (e.g., Food, Travel, Groceries). Use "General" if unclear.
- Merchant can be null if unknown.
- Account must be one of: cash, gopay, shopeepay, isaku, bca, flazz emoney, superbank, jago cloudthingy. Use lowercase and return null if unsure.
- Use a decimal number for amount, without currency symbols.
- Do not wrap the JSON in markdown fences or explanations.`;
  }

  normalizeResponse(raw, fallbackDate) {
    const parsed = {
      date: fallbackDate,
      description: 'Expense',
      category: 'General',
      amount: null,
      currency: this.defaultCurrency,
      merchant: null,
      account: null,
      ...raw,
    };

    if (!parsed.date) {
      parsed.date = fallbackDate;
    }

    if (parsed.date && parsed.date.includes('/')) {
      const [month, day, year] = parsed.date.split(/[\/-]/);
      if (year && month && day) {
        parsed.date = `${year.padStart(4, '20')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      }
    }

    parsed.amount = coerceNumber(parsed.amount);
    if (!parsed.amount) {
      throw new Error('Gemini could not determine an amount');
    }

    if (!parsed.currency) {
      parsed.currency = this.defaultCurrency;
    }

    if (parsed.account !== undefined && parsed.account !== null) {
      parsed.account = String(parsed.account).trim();
      if (!parsed.account) {
        parsed.account = null;
      }
    }

    parsed.currency = String(parsed.currency).trim().toUpperCase();

    if (!parsed.description) {
      parsed.description = 'Expense';
    }

    if (!parsed.category) {
      parsed.category = 'General';
    }

    logger.info(
      'GeminiService',
      `Normalized response: ${parsed.description} ${parsed.amount} ${parsed.currency} on ${parsed.date}`
    );

    return parsed;
  }

  async parseTextExpense(text, fallbackDate) {
    const prompt = this.buildPrompt({ fallbackDate });
    const message = `${prompt}\n\nInput:\n${text}`;

    const result = await this.model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [{ text: message }],
        },
      ],
      generationConfig: {
        temperature: 0.1,
      },
    });

    const raw = result.response.text();
    logger.debug('GeminiService', `Raw text response: ${raw}`);
    const parsed = cleanJsonResponse(raw);
    return this.normalizeResponse(parsed, fallbackDate);
  }

  async parseImageExpense({ base64Data, mimeType, accompanyingText }, fallbackDate) {
    const prompt = this.buildPrompt({ fallbackDate });
    const parts = [
      { text: prompt },
      {
        inlineData: {
          data: base64Data,
          mimeType,
        },
      },
    ];

    if (accompanyingText) {
      parts.push({ text: `Additional user notes: ${accompanyingText}` });
    }

    const result = await this.model.generateContent({
      contents: [
        {
          role: 'user',
          parts,
        },
      ],
      generationConfig: {
        temperature: 0.1,
      },
    });

    const raw = result.response.text();
    logger.debug('GeminiService', `Raw image response: ${raw}`);
    const parsed = cleanJsonResponse(raw);
    return this.normalizeResponse(parsed, fallbackDate);
  }
}

module.exports = GeminiService;
