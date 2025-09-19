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

client.on("qr", (qr) => {
  logger.info(
    "WhatsApp",
    "QR code received. Scan with your phone to authenticate."
  );
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  logger.info("WhatsApp", "Authentication successful.");
});

client.on("auth_failure", (msg) => {
  logger.error("WhatsApp", `Authentication failed: ${msg}`);
});

client.on("ready", () => {
  logger.info("WhatsApp", "Client is ready. Listening for messages...");
});

client.on("disconnected", (reason) => {
  logger.warn("WhatsApp", `Client disconnected: ${reason}`);
  logger.info("WhatsApp", "Reinitializing...");
  client.initialize();
});

async function shouldProcessMessage(message) {
  if (message.fromMe) {
    logger.debug("Handler", "Skipping message because it was sent by the bot");
    return false;
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
  const text = message.body?.trim();

  if (media) {
    logger.info(
      "Handler",
      `Message ${message.id._serialized} contains media (${media.mimeType}), forwarding to Gemini image parser`
    );
  } else {
    logger.info(
      "Handler",
      `Message ${message.id._serialized} contains text only${
        text ? "" : " (empty body)"
      }`
    );
  }

  try {
    logger.info(
      "Handler",
      `Parsing expense details for message ${message.id._serialized}`
    );
    const expense = await expenseParser.parse({
      text,
      media,
      timestampMs,
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
    await sheetsService.appendExpense(expense, {
      source: media ? "image" : "text",
      chatName: chat?.name || chat?.id?._serialized || "",
      messageId: message.id?._serialized || "",
    });

    const reply = buildSuccessReply(expense);
    logger.info(
      "Handler",
      `Replying to message ${message.id._serialized} with confirmation`
    );
    await message.reply(reply);
    logger.info(
      "Handler",
      `Logged expense for message ${message.id._serialized}`
    );
  } catch (error) {
    logger.error("Handler", "Failed to process message", error);
    await message.reply(
      "Could not record expense. Please try again or specify amount and description in text."
    );
  }
}

client.on("message", (message) => {
  logger.info(
    "Handler",
    `Incoming message ${message.id?._serialized || "unknown"} from ${
      message.from
    } (type=${message.type}, hasMedia=${message.hasMedia})`
  );
  handleMessage(message).catch((error) => {
    logger.error("Handler", "Unexpected error while handling message", error);
  });
});

client.initialize();
