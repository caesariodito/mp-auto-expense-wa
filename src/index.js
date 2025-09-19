const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const config = require("./config");
const logger = require("./utils/logger");
const SheetsService = require("./services/sheets");
const ExpenseParser = require("./services/expenseParser");

if (!config.gemini.apiKey) {
  logger.error(
    "Startup",
    "GEMINI_API_KEY is not set. Please configure it before running the bot."
  );
  process.exit(1);
}

const sheetsService = new SheetsService({
  googleSheetsConfig: config.googleSheets,
  localCsvPath: config.localCsvPath,
});

const expenseParser = new ExpenseParser({ config });

const ACCOUNT_OVERRIDE_REGEX = /\bacc:([a-z0-9 _-]+)/i;
const ACCOUNT_OVERRIDE_STRIP_REGEX = /\bacc:[a-z0-9 _-]+/gi;

function extractAccountDirective(sourceText) {
  if (!sourceText) {
    return { accountOverride: null, cleanedText: '' };
  }

  const match = ACCOUNT_OVERRIDE_REGEX.exec(sourceText);
  const accountOverride = match ? match[1].trim() : null;
  const cleanedText = sourceText
    .replace(ACCOUNT_OVERRIDE_STRIP_REGEX, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return {
    accountOverride: accountOverride || null,
    cleanedText,
  };
}

let selfId = null;

function refreshSelfId() {
  const resolved = client.info?.wid?._serialized;
  if (resolved && resolved !== selfId) {
    selfId = resolved;
    logger.info("WhatsApp", `Resolved self WhatsApp ID: ${selfId}`);
  }
}

function isMessageFromSelf(message) {
  if (message.fromMe) {
    return true;
  }

  if (typeof message.id?.fromMe === 'boolean') {
    if (message.id.fromMe) {
      return true;
    }
  } else if (typeof message.id?._serialized === 'string' && message.id._serialized.startsWith('true_')) {
    return true;
  }

  const authorId = message.author;
  const chatId = message.from;

  if (selfId) {
    if (authorId && authorId === selfId) {
      return true;
    }

    if (!authorId && chatId === selfId) {
      return true;
    }
  }

  return false;
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: config.whatsapp.sessionPath }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
    ],
  },
});

async function logAllowedChatHistories() {
  const { allowedChatIds, chatLogLimit } = config.whatsapp;

  if (!allowedChatIds || allowedChatIds.length === 0) {
    logger.info("ChatLog", "ALLOWED_CHAT_IDS is empty; no chat history to display.");
    return;
  }

  const limit = Math.max(1, chatLogLimit || 10);
  refreshSelfId();
  const currentSelfId = selfId || "";

  for (const chatId of allowedChatIds) {
    try {
      const chat = await client.getChatById(chatId);
      const label = chat?.name || chatId;
      logger.info(
        "ChatLog",
        `Fetching last ${limit} message(s) for chat ${label} (${chatId})`
      );
      const messages = await chat.fetchMessages({ limit });
      const ordered = [...messages].reverse();

      for (const message of ordered) {
        const timestamp = message.timestamp
          ? new Date(message.timestamp * 1000).toISOString()
          : "unknown";
        const fromSelf = isMessageFromSelf(message);
        const direction = fromSelf ? "outgoing" : "incoming";
        const body = typeof message.body === "string" ? message.body : "";
        const { cleanedText: sanitizedBody } = extractAccountDirective(body);
        const previewSource = sanitizedBody || body;
        const preview = previewSource.replace(/\s+/g, " ").trim();
        const content = preview ? preview.slice(0, 200) : "[no text]";
        const messageId = message.id?._serialized || "unknown";
        const messageType = message.type || "unknown";
        const mediaFlag = message.hasMedia ? "has-media" : "no-media";
        const author = message.author || (fromSelf ? currentSelfId : message.from);
        logger.info(
          "ChatLog",
          `[${chatId}] ${timestamp} ${direction} author=${author} id=${messageId} ${mediaFlag} type=${messageType} text=${content}`
        );
      }
    } catch (error) {
      logger.error(
        "ChatLog",
        `Unable to retrieve chat history for ${chatId}`,
        error
      );
    }
  }
}

client.on("qr", (qr) => {
  logger.info(
    "WhatsApp",
    "QR code received. Scan with your phone to authenticate."
  );
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  logger.info("WhatsApp", "Authentication successful.");
  refreshSelfId();
});

client.on("auth_failure", (msg) => {
  logger.error("WhatsApp", `Authentication failed: ${msg}`);
});

client.on("ready", () => {
  logger.info("WhatsApp", "Client is ready. Listening for messages...");
  refreshSelfId();
  if (!config.whatsapp.replyEnabled) {
    logger.info(
      "WhatsApp",
      "Confirmation replies are disabled; messages will be logged only."
    );
  }

  logAllowedChatHistories().catch((error) => {
    logger.error(
      "ChatLog",
      "Failed to log chat history for configured ALLOWED_CHAT_IDS",
      error
    );
  });
});

client.on("disconnected", (reason) => {
  logger.warn("WhatsApp", `Client disconnected: ${reason}`);
  logger.info("WhatsApp", "Reinitializing...");
  client.initialize();
});

async function shouldProcessMessage(message) {
  const fromSelf = isMessageFromSelf(message);

  if (config.whatsapp.selfMessagesOnly && !fromSelf) {
    const author = message.author || message.from;
    logger.info(
      "Handler",
      `Ignoring message ${message.id?._serialized || "unknown"} from ${author} because it was not sent by the logged-in account`
    );
    return false;
  }

  if (fromSelf) {
    logger.debug(
      "Handler",
      "Processing self-sent message from the logged-in account"
    );
  }

  if (config.whatsapp.allowedChatIds.length > 0) {
    const isAllowed = config.whatsapp.allowedChatIds.includes(message.from);
    if (!isAllowed) {
      logger.info(
        "Handler",
        `Ignoring message from ${message.from} because it is not in ALLOWED_CHAT_IDS`
      );
    }
    return isAllowed;
  }

  logger.debug(
    "Handler",
    "Processing message because ALLOWED_CHAT_IDS is empty"
  );
  return true;
}

async function extractMedia(message) {
  if (!message.hasMedia) {
    logger.debug(
      "Handler",
      `Message ${message.id?._serialized || "unknown"} has no media`
    );
    return null;
  }

  const media = await message.downloadMedia();
  if (!media || media.mimetype.indexOf("image/") !== 0 || !media.data) {
    logger.info(
      "Handler",
      `Discarding media on message ${
        message.id?._serialized || "unknown"
      } because it is not an image`
    );
    return null;
  }

  return {
    base64Data: media.data,
    mimeType: media.mimetype,
  };
}

function buildSuccessReply(expense) {
  const amountFormatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: expense.currency,
  });

  const prettyAmount = amountFormatter.format(expense.amount);
  return `Recorded: ${expense.description} – ${prettyAmount} on ${expense.date}. Category: ${expense.category}.`;
}

async function handleMessage(message) {
  refreshSelfId();

  if (!(await shouldProcessMessage(message))) {
    logger.debug(
      "Handler",
      `Message ${message.id?._serialized || "unknown"} skipped after filters`
    );
    return;
  }

  const supportedTypes = ["chat", "image"];
  if (!supportedTypes.includes(message.type)) {
    logger.debug(
      "Handler",
      `Ignoring unsupported message type: ${message.type}`
    );
    return;
  }

  logger.info("Handler", `Processing message ${message.id._serialized}`);

  const timestampMs =
    (message.timestamp || Math.floor(Date.now() / 1000)) * 1000;
  const media = await extractMedia(message);
  const rawText = typeof message.body === 'string' ? message.body.trim() : '';
  const { accountOverride, cleanedText } = extractAccountDirective(rawText);
  const parsingText = cleanedText;

  if (media) {
    logger.info(
      "Handler",
      `Message ${message.id._serialized} contains media (${media.mimeType}), forwarding to Gemini image parser`
    );
  } else {
    logger.info(
      "Handler",
      `Message ${message.id._serialized} contains text only${
        parsingText ? "" : " (empty body)"
      }`
    );
  }

  const textPreview = parsingText ? parsingText.replace(/\s+/g, " ").trim() : "";
  if (textPreview) {
    const fromSelf = isMessageFromSelf(message);
    const author = message.author || (fromSelf ? selfId || client.info?.wid?._serialized || "" : message.from);
    logger.info(
      "ChatLog",
      `[${message.from}] ${message.id._serialized} author=${author} text=${textPreview.slice(0, 200)}`
    );
  }

  try {
    logger.info(
      "Handler",
      `Parsing expense details for message ${message.id._serialized}`
    );
    const expense = await expenseParser.parse({
      text: parsingText,
      media,
      timestampMs,
      accountOverride,
      rawText,
    });

    logger.info(
      "Handler",
      `Parsed expense for message ${message.id._serialized}: ${expense.description} ${expense.amount} ${expense.currency} on ${expense.date}`
    );

    const chat = await message.getChat();
    logger.info(
      "Handler",
      `Appending expense from chat ${
        chat?.name || chat?.id?._serialized || "unknown"
      } to log target`
    );

    const note = media && parsingText ? parsingText : "";
    await sheetsService.appendExpense(expense, {
      note,
    });

    const confirmation = buildSuccessReply(expense);
    logger.info(
      "Handler",
      `Expense summary for message ${message.id._serialized}: ${confirmation}`
    );

    if (config.whatsapp.replyEnabled) {
      logger.info(
        "Handler",
        `Replying to message ${message.id._serialized} with confirmation`
      );
      await message.reply(confirmation);
    } else {
      logger.info(
        "Handler",
        "Replies are disabled; skipping confirmation message."
      );
    }

    logger.info(
      "Handler",
      `Logged expense for message ${message.id._serialized}`
    );
  } catch (error) {
    logger.error("Handler", "Failed to process message", error);
    if (config.whatsapp.replyEnabled) {
      await message.reply(
        "Could not record expense. Please try again or specify amount and description in text."
      );
    } else {
      logger.info(
        "Handler",
        "Replies are disabled; not sending failure notification."
      );
    }
  }
}

client.on("message_create", (message) => {
  logger.info(
    "Handler",
    `New message ${message.id?._serialized || "unknown"} from ${
      message.from
    } (type=${message.type}, hasMedia=${message.hasMedia}, fromMe=${message.fromMe})`
  );
  handleMessage(message).catch((error) => {
    logger.error("Handler", "Unexpected error while handling message_create", error);
  });
});

client.initialize();
