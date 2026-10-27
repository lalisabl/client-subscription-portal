"use strict";

const crypto = require("crypto");
const querystring = require("querystring");

function safeStr(v) {
  return String(v == null ? "" : v).trim();
}

function isSandbox() {
  return String(process.env.PAYFAST_SANDBOX || "true").toLowerCase() !== "false";
}

function getConfig() {
  return {
    merchantId: safeStr(process.env.PAYFAST_MERCHANT_ID),
    merchantKey: safeStr(process.env.PAYFAST_MERCHANT_KEY),
    passphrase: safeStr(process.env.PAYFAST_PASSPHRASE),
    sandbox: isSandbox(),
  };
}

function processUrl() {
  return isSandbox()
    ? "https://sandbox.payfast.co.za/eng/process"
    : "https://www.payfast.co.za/eng/process";
}

function onsiteUrl() {
  return isSandbox()
    ? "https://sandbox.payfast.co.za/onsite/process"
    : "https://www.payfast.co.za/onsite/process";
}

function validateUrl() {
  return isSandbox()
    ? "https://sandbox.payfast.co.za/eng/query/validate"
    : "https://www.payfast.co.za/eng/query/validate";
}

function apiBase() {
  const base = isSandbox() ? "https://sandbox.payfast.co.za" : "https://api.payfast.co.za";
  return `${base}/subscriptions`;
}

/** MD5 signature for PayFast form / onsite / ITN payloads */
function generateSignature(data, passphrase) {
  const keys = Object.keys(data)
    .filter((k) => k !== "signature" && data[k] !== undefined && data[k] !== null && String(data[k]) !== "")
    .sort();
  const paramString = keys
    .map((k) => `${k}=${encodeURIComponent(String(data[k]).trim()).replace(/%20/g, "+")}`)
    .join("&");
  const withPass = passphrase ? `${paramString}&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, "+")}` : paramString;
  return crypto.createHash("md5").update(withPass).digest("hex");
}

/** API request signature (headers + body/query sorted alphabetically) */
function generateApiSignature(headers, body = {}, passphrase) {
  const all = { ...headers, ...body };
  delete all.signature;
  const keys = Object.keys(all)
    .filter((k) => all[k] !== undefined && all[k] !== null && String(all[k]) !== "")
    .sort();
  let paramString = keys.map((k) => `${k}=${encodeURIComponent(String(all[k]).trim()).replace(/%20/g, "+")}`).join("&");
  if (passphrase) {
    paramString += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, "+")}`;
  }
  return crypto.createHash("md5").update(paramString).digest("hex");
}

function buildPaymentData(opts) {
  const cfg = getConfig();
  const data = {
    merchant_id: cfg.merchantId,
    merchant_key: cfg.merchantKey,
    return_url: safeStr(opts.return_url),
    cancel_url: safeStr(opts.cancel_url),
    notify_url: safeStr(opts.notify_url),
    name_first: safeStr(opts.name_first),
    name_last: safeStr(opts.name_last),
    email_address: safeStr(opts.email_address),
    cell_number: safeStr(opts.cell_number),
    m_payment_id: safeStr(opts.m_payment_id),
    amount: Number(opts.amount).toFixed(2),
    item_name: safeStr(opts.item_name).slice(0, 100),
    item_description: safeStr(opts.item_description).slice(0, 255),
  };

  if (opts.subscription) {
    data.subscription_type = "1";
    data.billing_date = safeStr(opts.billing_date) || undefined;
    data.recurring_amount = opts.recurring_amount != null ? Number(opts.recurring_amount).toFixed(2) : data.amount;
    data.frequency = String(opts.frequency || 3);
    data.cycles = String(opts.cycles != null ? opts.cycles : 0);
  }

  // strip empties
  Object.keys(data).forEach((k) => {
    if (data[k] === undefined || data[k] === null || data[k] === "") delete data[k];
  });

  data.signature = generateSignature(data, cfg.passphrase);
  return data;
}

async function createOnsitePayment(opts) {
  const cfg = getConfig();
  if (!cfg.merchantId || !cfg.merchantKey) {
    throw new Error("PayFast merchant credentials are not configured");
  }
  const data = buildPaymentData(opts);
  const body = querystring.stringify(data);
  const url = onsiteUrl() + (cfg.sandbox ? "?testing=true" : "");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`PayFast onsite error: ${text.slice(0, 300)}`);
  }
  if (!json?.uuid) {
    throw new Error(`PayFast onsite did not return uuid: ${text.slice(0, 300)}`);
  }
  return { uuid: json.uuid, data };
}

async function validateItn(payload) {
  const body = querystring.stringify(payload);
  const res = await fetch(validateUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = (await res.text()).trim();
  return text === "VALID";
}

function verifyItnSignature(payload) {
  const cfg = getConfig();
  const received = safeStr(payload.signature);
  if (!received) return false;
  const data = { ...payload };
  delete data.signature;
  const expected = generateSignature(data, cfg.passphrase);
  return expected === received;
}

async function subscriptionApi(method, path, body = null) {
  const cfg = getConfig();
  if (!cfg.merchantId || !cfg.passphrase) {
    throw new Error("PayFast API credentials are not configured");
  }
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const headersForSig = {
    "merchant-id": cfg.merchantId,
    version: "v1",
    timestamp,
  };
  const bodyObj = body || {};
  const signature = generateApiSignature(headersForSig, bodyObj, cfg.passphrase);

  let url = `${apiBase()}${path}`;
  if (cfg.sandbox) url += (url.includes("?") ? "&" : "?") + "testing=true";

  const headers = {
    "merchant-id": cfg.merchantId,
    version: "v1",
    timestamp,
    signature,
    "Content-Type": "application/json",
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body && method !== "GET" ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`PayFast API ${method} ${path} failed: ${text.slice(0, 400)}`);
  }
  return json;
}

async function fetchSubscription(token) {
  return subscriptionApi("GET", `/${encodeURIComponent(token)}/fetch`);
}

async function pauseSubscription(token, cycles = 0) {
  return subscriptionApi("PUT", `/${encodeURIComponent(token)}/pause`, { cycles: Number(cycles) || 0 });
}

async function unpauseSubscription(token) {
  return subscriptionApi("PUT", `/${encodeURIComponent(token)}/unpause`);
}

async function cancelSubscription(token) {
  return subscriptionApi("PUT", `/${encodeURIComponent(token)}/cancel`);
}

async function updateSubscription(token, updates) {
  const body = {};
  if (updates.cycles != null) body.cycles = Number(updates.cycles);
  if (updates.frequency != null) body.frequency = Number(updates.frequency);
  if (updates.run_date) body.run_date = safeStr(updates.run_date);
  if (updates.amount != null) body.amount = Number(updates.amount); // cents
  return subscriptionApi("PATCH", `/${encodeURIComponent(token)}/update`, body);
}

function cardUpdateUrl(token, returnUrl) {
  const host = isSandbox() ? "https://sandbox.payfast.co.za" : "https://www.payfast.co.za";
  const ret = returnUrl ? `?return=${encodeURIComponent(returnUrl)}` : "";
  return `${host}/eng/recurring/update/${encodeURIComponent(token)}${ret}`;
}

function centsToZar(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function zarToCents(zar) {
  return Math.round(Number(zar || 0) * 100);
}

module.exports = {
  getConfig,
  isSandbox,
  processUrl,
  onsiteUrl,
  generateSignature,
  buildPaymentData,
  createOnsitePayment,
  validateItn,
  verifyItnSignature,
  fetchSubscription,
  pauseSubscription,
  unpauseSubscription,
  cancelSubscription,
  updateSubscription,
  cardUpdateUrl,
  centsToZar,
  zarToCents,
};
