"use strict";

/**
 * Before `catalyst deploy`, merge secret env vars from backend/.env into app-config.json.
 * CLI deploy pushes app-config env_variables to AppSail and overwrites the console —
 * empty strings in app-config wipe keys you set manually in the dashboard.
 */

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const CONFIG_PATH = path.join(__dirname, "..", "app-config.json");

/** Must be present in .env at deploy time */
const REQUIRED = ["JWT_SECRET", "PAYSTACK_SECRET_KEY"];

/** Set from .env when value is non-empty; removed from app-config when empty (avoids pushing "") */
const OPTIONAL_IF_EMPTY_REMOVE = ["PAYSTACK_WEBHOOK_SECRET"];

/** Set from .env when non-empty; leave existing app-config value when .env is blank */
const INJECT_WHEN_SET = [
  "INTERNAL_API_SECRET",
  "PASSWORD_RESET_TOKEN_SECRET",
  "PAYSTACK_TEST_MODE",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM_EMAIL",
  "SMTP_FROM_NAME",
  "SMTP_SECURE",
];

function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error("inject-app-config-env: app-config.json not found");
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  config.env_variables = config.env_variables || {};

  const missing = REQUIRED.filter((key) => !String(process.env[key] || "").trim());
  if (missing.length) {
    console.error(`inject-app-config-env: missing in backend/.env: ${missing.join(", ")}`);
    process.exit(1);
  }

  for (const key of REQUIRED) {
    config.env_variables[key] = String(process.env[key]).trim();
  }

  for (const key of OPTIONAL_IF_EMPTY_REMOVE) {
    const val = String(process.env[key] || "").trim();
    if (val) config.env_variables[key] = val;
    else delete config.env_variables[key];
  }

  for (const key of INJECT_WHEN_SET) {
    const val = String(process.env[key] ?? "").trim();
    if (val) config.env_variables[key] = val;
  }

  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  console.log("inject-app-config-env: secrets merged from .env — safe to deploy");
}

main();
