const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const logger = require('../utils/logger');

class SheetsService {
  constructor({ googleSheetsConfig, localCsvPath }) {
    this.mode = 'local';
    this.googleSheetsConfig = googleSheetsConfig;
    this.localCsvPath = localCsvPath;
    this.googleClient = null;
    this.sheetsApi = null;
    this.authenticated = false;

    if (googleSheetsConfig?.spreadsheetId && googleSheetsConfig?.serviceAccount) {
      this.mode = 'google';
      const { client_email, private_key } = googleSheetsConfig.serviceAccount;
      if (!client_email || !private_key) {
        throw new Error('Service account credentials must include client_email and private_key');
      }

      this.googleClient = new google.auth.JWT(
        client_email,
        null,
        private_key.replace(/\\n/g, '\n'),
        ['https://www.googleapis.com/auth/spreadsheets']
      );
      this.sheetsApi = google.sheets({ version: 'v4', auth: this.googleClient });

      logger.info(
        'SheetsService',
        `Configured for Google Sheets logging: spreadsheet=${googleSheetsConfig.spreadsheetId}, tab=${googleSheetsConfig.tabName || 'Expenses'}`
      );
    }

    if (this.mode === 'local') {
      logger.info('SheetsService', `Configured for local CSV logging at ${this.localCsvPath}`);
    }
  }

  async ensureAuth() {
    if (this.mode !== 'google' || this.authenticated) {
      if (this.mode === 'google') {
        logger.debug('SheetsService', 'Google Sheets client already authenticated');
      }
      return;
    }

    await this.googleClient.authorize();
    this.authenticated = true;
    logger.info('SheetsService', 'Authenticated with Google Sheets API');
  }

  async appendExpense(expense, metadata = {}) {
    if (this.mode === 'google') {
      logger.info('SheetsService', 'Appending expense row to Google Sheets');
      return this.appendToGoogleSheet(expense, metadata);
    }
    logger.info('SheetsService', 'Appending expense row to local CSV');
    return this.appendToCsv(expense, metadata);
  }

  async appendToGoogleSheet(expense, metadata) {
    await this.ensureAuth();

    const note = metadata?.note ? metadata.note.trim() : '';
    const description = note ? `${expense.description} - ${note}` : expense.description;
    const values = [
      [
        new Date().toISOString(),
        expense.date,
        expense.category,
        description,
        expense.amount,
        '',
        expense.merchant || '',
        '',
        '',
        '',
      ],
    ];

    await this.sheetsApi.spreadsheets.values.append({
      spreadsheetId: this.googleSheetsConfig.spreadsheetId,
      range: `${this.googleSheetsConfig.tabName || 'Expenses'}!A:J`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values,
      },
    });

    logger.info(
      'SheetsService',
      `Logged expense to Google Sheets tab ${this.googleSheetsConfig.tabName || 'Expenses'}`
    );
  }

  async appendToCsv(expense, metadata) {
    const absolutePath = path.isAbsolute(this.localCsvPath)
      ? this.localCsvPath
      : path.join(process.cwd(), this.localCsvPath);

    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });

    if (!fs.existsSync(absolutePath)) {
      const header = 'timestamp,date,category,description,amount,currency,merchant,source,chat_name,message_id\n';
      await fs.promises.writeFile(absolutePath, header, 'utf8');
      logger.info('SheetsService', `Created CSV log at ${absolutePath}`);
    }

    const note = metadata?.note ? metadata.note.trim() : '';
    const description = note ? `${expense.description} - ${note}` : expense.description;
    const row = [
      new Date().toISOString(),
      expense.date,
      expense.category,
      description,
      expense.amount,
      '',
      expense.merchant || '',
      '',
      '',
      '',
    ]
      .map((value) => {
        if (value === null || value === undefined) {
          return '';
        }
        const stringValue = String(value);
        if (stringValue.includes(',') || stringValue.includes('"')) {
          return `"${stringValue.replace(/"/g, '""')}"`;
        }
        return stringValue;
      })
      .join(',');

    await fs.promises.appendFile(absolutePath, `${row}\n`, 'utf8');
    logger.info('SheetsService', `Logged expense to local CSV at ${absolutePath}`);
  }
}

module.exports = SheetsService;
