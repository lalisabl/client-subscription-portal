#!/usr/bin/env node
"use strict";

/**
 * Quick PayFast sandbox credential check.
 *
 *   npm run test:payfast
 *   node scripts/test-payfast.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const querystring = require("querystring");
const {
  buildPaymentData,
  getConfig,
  isSandbox,
  onsiteUrl,
  generateSignature,
} = require("../services/payfast");

function mask(value) {
  const s = String(value || "");
  if (!s) return "(missing)";
  if (s.length <= 4) return "****";
  return `${s.slice(0, 2)}…${s.slice(-2)} (${s.length} chars)`;
}

function extractHtmlError(text) {
  const plain = String(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.slice(0, 240) || "(empty HTML body)";
}

async function main() {
  const cfg = getConfig();
  console.log("PayFast config");
  console.log("  sandbox     :", isSandbox());
  console.log("  merchant_id :", mask(cfg.merchantId));
  console.log("  merchant_key:", mask(cfg.merchantKey));
  console.log("  passphrase  :", mask(cfg.passphrase));

  if (!cfg.merchantId || !cfg.merchantKey) {
    console.error("\nFAIL: set PAYFAST_MERCHANT_ID and PAYFAST_MERCHANT_KEY in backend/.env");
    process.exit(1);
  }
  if (!cfg.passphrase) {
    console.warn("WARN: PAYFAST_PASSPHRASE is empty — sandbox usually requires the passphrase you set in PayFast.");
  }

  // Local signature self-check (ensures passphrase encoding path works)
  const sample = { merchant_id: cfg.merchantId, merchant_key: cfg.merchantKey, amount: "5.00", item_name: "test" };
  const sig = generateSignature(sample, cfg.passphrase);
  console.log("\nLocal signature OK:", sig.slice(0, 8) + "…");

  const portalBase = (process.env.PORTAL_BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
  const apiBase = (process.env.API_PUBLIC_URL || "http://localhost:3001").replace(/\/+$/, "");

  const data = buildPaymentData({
    return_url: portalBase,
    cancel_url: portalBase,
    notify_url: `${apiBase}/api/payfast/itn`,
    name_first: "Test",
    name_last: "Merchant",
    email_address: "test@example.com",
    m_payment_id: `key-test-${Date.now()}`,
    amount: 5.0,
    item_name: "Manvic PayFast key test",
    item_description: "Sandbox credential verification only",
    subscription: false,
  });

  const url = onsiteUrl() + (cfg.sandbox ? "?testing=true" : "");
  console.log("\nPOST", url);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: querystring.stringify(data),
  });
  const text = await res.text();
  console.log("HTTP", res.status, res.headers.get("content-type") || "");

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error("\nFAIL: PayFast returned HTML/text instead of JSON uuid");
    console.error("  hint:", extractHtmlError(text));
    console.error("\nCommon causes:");
    console.error("  - Merchant ID / Key / Passphrase do not match the sandbox dashboard");
    console.error("  - Passphrase has a typo or extra space");
    console.error("  - Keys are live keys while PAYFAST_SANDBOX=true (or the reverse)");
    process.exit(1);
  }

  if (!json?.uuid) {
    console.error("\nFAIL: no uuid in response:", JSON.stringify(json).slice(0, 400));
    process.exit(1);
  }

  console.log("\nOK: sandbox accepted your keys");
  console.log("  uuid:", json.uuid);
}

main().catch((err) => {
  console.error("\nFAIL:", err.message || err);
  process.exit(1);
});
