#!/usr/bin/env node
"use strict";

/**
 * Quick SMTP check — verifies credentials and sends one test email.
 *
 *   npm run test:smtp
 *   node scripts/test-smtp.js
 *   node scripts/test-smtp.js someone@example.com
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const nodemailer = require("nodemailer");

function safeStr(v) {
  return String(v == null ? "" : v).trim();
}

function mask(value) {
  const s = safeStr(value);
  if (!s) return "(missing)";
  if (s.length <= 4) return "****";
  return `${s.slice(0, 2)}…${s.slice(-2)} (${s.length} chars)`;
}

async function main() {
  const host = safeStr(process.env.SMTP_HOST);
  const port = Number(process.env.SMTP_PORT || 587);
  const user = safeStr(process.env.SMTP_USER);
  const pass = safeStr(process.env.SMTP_PASS);
  const secure = String(process.env.SMTP_SECURE || "").toLowerCase() === "true";
  const fromEmail = safeStr(process.env.SMTP_FROM_EMAIL) || user;
  const fromName = safeStr(process.env.SMTP_FROM_NAME) || "Manvic Client Portal";
  const to = safeStr(process.argv[2] || "bulalalisa@gmail.com");

  console.log("SMTP config");
  console.log("  host  :", host || "(missing)");
  console.log("  port  :", port);
  console.log("  secure:", secure);
  console.log("  user  :", mask(user));
  console.log("  pass  :", mask(pass));
  console.log("  from  :", fromEmail ? `"${fromName}" <${fromEmail}>` : "(missing)");
  console.log("  to    :", to || "(missing)");

  if (!host || !user || !pass) {
    console.error("\nFAIL: set SMTP_HOST, SMTP_USER, and SMTP_PASS in backend/.env");
    process.exit(1);
  }
  if (!to) {
    console.error("\nFAIL: recipient email required");
    process.exit(1);
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  console.log("\nVerifying SMTP connection…");
  await transporter.verify();
  console.log("OK: server accepted credentials");

  console.log("\nSending test email…");
  const info = await transporter.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject: "Manvic SMTP test",
    text: "SMTP is working for the Manvic Client Portal.",
    html: "<p><strong>SMTP is working</strong> for the Manvic Client Portal.</p>",
  });

  console.log("OK: email sent");
  console.log("  messageId:", info.messageId || "(none)");
  console.log("  accepted :", (info.accepted || []).join(", ") || "(none)");
  console.log("  rejected :", (info.rejected || []).join(", ") || "(none)");
}

main().catch((err) => {
  console.error("\nFAIL:", err.message || err);
  process.exit(1);
});
