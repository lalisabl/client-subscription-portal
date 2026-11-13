"use strict";

const crypto = require("crypto");

const API_BASE = "https://api.paystack.co";

function safeStr(v) {
  return String(v == null ? "" : v).trim();
}

function isTestMode() {
  return String(process.env.PAYSTACK_TEST_MODE || "true").toLowerCase() !== "false";
}

function getSecretKey() {
  return safeStr(process.env.PAYSTACK_SECRET_KEY);
}

function getWebhookSecret() {
  return safeStr(process.env.PAYSTACK_WEBHOOK_SECRET) || getSecretKey();
}

function authHeaders() {
  const key = getSecretKey();
  if (!key) throw new Error("Paystack secret key is not configured");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

async function paystackRequest(method, path, body = null) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: authHeaders(),
    body: body && method !== "GET" ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Paystack API invalid JSON: ${text.slice(0, 300)}`);
  }
  if (!res.ok || json.status === false) {
    throw new Error(safeStr(json.message) || `Paystack ${method} ${path} failed`);
  }
  return json;
}

/**
 * @param {{ email: string, amountCents: number, reference: string, callbackUrl: string, metadata?: object }} opts
 */
async function initializeTransaction(opts) {
  const email = safeStr(opts.email);
  const reference = safeStr(opts.reference);
  const amountCents = Math.round(Number(opts.amountCents || 0));
  if (!email || !email.includes("@")) throw new Error("Customer email is required for Paystack");
  if (!reference) throw new Error("Payment reference is required");
  if (amountCents < 100) throw new Error("Amount must be at least R1.00");

  const payload = {
    email,
    amount: amountCents,
    reference,
    currency: "ZAR",
    callback_url: safeStr(opts.callbackUrl),
    metadata: opts.metadata || {},
  };

  const json = await paystackRequest("POST", "/transaction/initialize", payload);
  const data = json.data || {};
  return {
    authorization_url: data.authorization_url,
    access_code: data.access_code,
    reference: data.reference || reference,
  };
}

async function verifyTransaction(reference) {
  const ref = encodeURIComponent(safeStr(reference));
  const json = await paystackRequest("GET", `/transaction/verify/${ref}`);
  return json.data || {};
}

/** Legacy x-paystack-signature: HMAC SHA512 of raw body with secret key. */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const sig = safeStr(signatureHeader);
  const secret = getWebhookSecret();
  if (!sig || !secret || !rawBody) return false;

  if (!sig.includes("t=") && !sig.includes("v1=")) {
    const hash = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
    if (hash.length !== sig.length) return false;
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(sig));
  }

  const parts = Object.fromEntries(
    sig.split(",").map((chunk) => {
      const [k, ...rest] = chunk.trim().split("=");
      return [k, rest.join("=")];
    })
  );
  const timestamp = parts.t;
  const v1Values = sig
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1="))
    .map((s) => s.slice(3));

  if (!timestamp || v1Values.length === 0) return false;
  const signedPayload = `${timestamp}.${rawBody}`;
  return v1Values.some((expected) => {
    const hash = crypto.createHmac("sha512", secret).update(signedPayload).digest("hex");
    try {
      return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
    } catch {
      return hash === expected;
    }
  });
}

function centsToZar(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function zarToCents(zar) {
  return Math.round(Number(zar || 0) * 100);
}

module.exports = {
  isTestMode,
  getSecretKey,
  getWebhookSecret,
  initializeTransaction,
  verifyTransaction,
  verifyWebhookSignature,
  centsToZar,
  zarToCents,
};
