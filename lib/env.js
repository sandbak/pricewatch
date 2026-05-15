const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, "..", ".env");

/**
 * Parse a .env file into a key-value object.
 */
function parseEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const lines = fs.readFileSync(ENV_PATH, "utf-8").split("\n");
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    env[key] = value;
  }
  return env;
}

/**
 * Read a value from the .env file.
 */
function get(key) {
  const env = parseEnvFile();
  return env[key] || process.env[key] || null;
}

/**
 * Write a key-value pair to the .env file.
 * Preserves comments and ordering of existing keys.
 */
function set(key, value) {
  let lines = [];
  if (fs.existsSync(ENV_PATH)) {
    lines = fs.readFileSync(ENV_PATH, "utf-8").split("\n");
  }

  let found = false;
  lines = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    // Remove trailing empty lines before appending
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    lines.push(`${key}=${value}`);
  }

  fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n");

  // Also update process.env so changes take effect immediately
  process.env[key] = value;
}

/**
 * Check if a key exists in .env or process.env.
 */
function has(key) {
  return !!(parseEnvFile()[key] || process.env[key]);
}

/**
 * Migrate Telegram credentials from config.json to .env.
 * Removes the `telegram` block from config.json after migration.
 */
function migrateTelegramFromConfig(configPath) {
  if (!fs.existsSync(configPath)) return false;

  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  if (!config.telegram) return false;

  const { botToken, chatId } = config.telegram;

  if (botToken && !has("TELEGRAM_BOT_TOKEN")) {
    set("TELEGRAM_BOT_TOKEN", botToken);
  }
  if (chatId && !has("TELEGRAM_CHAT_ID")) {
    set("TELEGRAM_CHAT_ID", chatId);
  }

  // Remove telegram block from config
  delete config.telegram;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  return true;
}

module.exports = { get, set, has, parseEnvFile, migrateTelegramFromConfig };
