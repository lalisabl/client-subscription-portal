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
    const msg = safeStr(json.message) || `Paystack ${method} ${path} failed`;
    if (/duplicate transaction reference/i.test(msg)) {
      throw new Error("Duplicate Transaction Reference — try Pay with Paystack again (a new reference is generated each time).");
    }
    throw new Error(msg);
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
  const planCode = safeStr(opts.planCode);
  if (!planCode && amountCents < 100) throw new Error("Amount must be at least R1.00");

  const payload = {
    email,
    amount: amountCents,
    reference,
    currency: safeStr(opts.currency) || "ZAR",
    callback_url: safeStr(opts.callbackUrl),
    metadata: opts.metadata || {},
  };
  if (planCode) payload.plan = planCode;

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

async function createPlan({ name, amount, interval, currency = "ZAR", invoice_limit, send_invoices = false, send_sms = false }) {
  const payload = {
    name: safeStr(name),
    amount: Math.round(Number(amount)),
    interval: safeStr(interval),
    currency: safeStr(currency) || "ZAR",
    send_invoices: !!send_invoices,
    send_sms: !!send_sms,
  };
  if (invoice_limit != null && Number(invoice_limit) > 0) payload.invoice_limit = Number(invoice_limit);
  const json = await paystackRequest("POST", "/plan", payload);
  return json.data || {};
}

async function updatePlan(planCode, { name, amount, interval, currency, invoice_limit, update_existing_subscriptions }) {
  const code = encodeURIComponent(safeStr(planCode));
  const payload = {};
  if (name != null) payload.name = safeStr(name);
  if (amount != null) payload.amount = Math.round(Number(amount));
  if (interval != null) payload.interval = safeStr(interval);
  if (currency != null) payload.currency = safeStr(currency);
  if (invoice_limit != null) payload.invoice_limit = Number(invoice_limit);
  if (update_existing_subscriptions != null) {
    payload.update_existing_subscriptions = !!update_existing_subscriptions;
  }
  const json = await paystackRequest("PUT", `/plan/${code}`, payload);
  return json.data || {};
}

async function disableSubscription({ code, token }) {
  const json = await paystackRequest("POST", "/subscription/disable", {
    code: safeStr(code),
    token: safeStr(token),
  });
  return json;
}

async function enableSubscription({ code, token }) {
  const json = await paystackRequest("POST", "/subscription/enable", {
    code: safeStr(code),
    token: safeStr(token),
  });
  return json;
}

async function fetchSubscription(codeOrId) {
  const id = encodeURIComponent(safeStr(codeOrId));
  const json = await paystackRequest("GET", `/subscription/${id}`);
  return json.data || {};
}

async function fetchPlan(planCode) {
  const code = encodeURIComponent(safeStr(planCode));
  const json = await paystackRequest("GET", `/plan/${code}`);
  return json.data || {};
}

async function fetchCustomer(emailOrCode) {
  const id = encodeURIComponent(safeStr(emailOrCode));
  const json = await paystackRequest("GET", `/customer/${id}`);
  return json.data || {};
}

async function listSubscriptions(query = {}) {
  const qs = new URLSearchParams();
  Object.entries(query).forEach(([key, val]) => {
    if (val != null && val !== "") qs.set(key, String(val));
  });
  const path = qs.toString() ? `/subscription?${qs.toString()}` : "/subscription";
  const json = await paystackRequest("GET", path);
  return json.data || [];
}

async function listSubscriptionsScanByCustomerEmail(email, { maxPages = 5, perPage = 50 } = {}) {
  const target = safeStr(email).toLowerCase();
  if (!target) return [];
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const rows = await listSubscriptions({ page, perPage });
    if (!rows.length) break;
    for (const row of rows) {
      const rowEmail = safeStr(row.customer?.email).toLowerCase();
      if (rowEmail === target) out.push(row);
    }
    if (rows.length < perPage) break;
  }
  return out;
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
  createPlan,
  updatePlan,
  disableSubscription,
  enableSubscription,
  fetchSubscription,
  fetchPlan,
  fetchCustomer,
  listSubscriptions,
  listSubscriptionsScanByCustomerEmail,
};
