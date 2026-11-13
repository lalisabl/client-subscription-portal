"use strict";

/**
 * Remove deploy-only secrets from app-config.json after deploy so they are not committed.
 * Run: npm run deploy:strip
 */

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "app-config.json");

const STRIP_KEYS = [
  "JWT_SECRET",
  "INTERNAL_API_SECRET",
  "PASSWORD_RESET_TOKEN_SECRET",
  "PAYSTACK_SECRET_KEY",
  "PAYSTACK_WEBHOOK_SECRET",
  "SMTP_USER",
  "SMTP_PASS",
];

function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  config.env_variables = config.env_variables || {};
  let n = 0;
  for (const key of STRIP_KEYS) {
    if (key in config.env_variables) {
      delete config.env_variables[key];
      n += 1;
    }
  }
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`strip-app-config-secrets: removed ${n} secret key(s) from app-config.json`);
}

main();
