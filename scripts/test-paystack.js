"use strict";

/**
 * Quick Paystack test-mode credential check.
 *   npm run test:paystack
 */
require("dotenv").config();

const { getSecretKey, isTestMode, initializeTransaction } = require("../services/paystack");

async function main() {
  const key = getSecretKey();
  console.log("Paystack config");
  console.log("  test mode:", isTestMode());
  console.log("  secret key:", key ? `${key.slice(0, 12)}…` : "(missing)");

  if (!key || !key.startsWith("sk_")) {
    console.error("\nFAIL: set PAYSTACK_SECRET_KEY in backend/.env");
    process.exit(1);
  }

  const portalBase = String(process.env.PORTAL_BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
  const reference = `test-${Date.now()}`;

  try {
    const init = await initializeTransaction({
      email: process.env.PAYSTACK_TEST_EMAIL || "test@example.com",
      amountCents: 10000,
      reference,
      callbackUrl: `${portalBase}/my/invoices?paid=1`,
      metadata: { smoke_test: true },
    });
    console.log("\nOK: initialize transaction");
    console.log("  reference:", init.reference);
    console.log("  authorization_url:", init.authorization_url ? "(present)" : "(missing)");
    if (!init.authorization_url) process.exit(1);
  } catch (err) {
    console.error("\nFAIL:", err.message || err);
    process.exit(1);
  }
}

main();
