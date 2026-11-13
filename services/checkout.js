"use strict";

const { findByRowId, findMany, updateRow, escapeZcql } = require("../catalyst/datastore");
const { safeStr } = require("../utils/authUtils");
const { createInvoiceForSubscription } = require("./invoices");
const { initializeTransaction } = require("./paystack");

async function buildPaystackCheckout(req, { invoice, client, plan, sub, returnPath }) {
  if (!client) throw new Error("Client missing");
  const email = safeStr(client.email);
  if (!email) throw new Error("Client email is required for online payment");

  const portalBase = safeStr(process.env.PORTAL_BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
  const reference = safeStr(invoice.m_payment_id) || `inv-${invoice.ROWID}-${Date.now()}`;

  if (invoice.ROWID && safeStr(invoice.m_payment_id) !== reference) {
    await updateRow(req, "invoices", invoice.ROWID, { m_payment_id: reference });
  }

  const callbackPath = safeStr(returnPath) || `/invoices/${invoice.ROWID}?paid=1`;
  const callbackUrl = `${portalBase}${callbackPath.startsWith("/") ? callbackPath : `/${callbackPath}`}`;

  const init = await initializeTransaction({
    email,
    amountCents: Number(invoice.total_cents || sub?.amount_cents || 0),
    reference,
    callbackUrl,
    metadata: {
      invoice_rowid: String(invoice.ROWID),
      subscription_rowid: String(invoice.subscription_rowid || sub?.ROWID || ""),
      client_rowid: String(client.ROWID),
    },
  });

  return {
    authorization_url: init.authorization_url,
    access_code: init.access_code,
    reference: init.reference || reference,
    m_payment_id: reference,
    invoice_id: invoice.ROWID,
    plan_name: plan?.name,
  };
}

async function checkoutForSubscription(req, sub) {
  const client = await findByRowId(req, "clients", sub.client_rowid);
  const plan = await findByRowId(req, "plans", sub.plan_rowid);

  let invoices = await findMany(
    req,
    "invoices",
    `subscription_rowid='${escapeZcql(sub.ROWID)}' AND status!='paid'`,
    "CREATEDTIME DESC",
    1,
    0
  );
  let invoice = invoices[0];
  if (!invoice) {
    invoice = await createInvoiceForSubscription(req, { subscription: sub, client, plan, status: "sent" });
  }

  return buildPaystackCheckout(req, {
    invoice,
    client,
    plan,
    sub,
    returnPath: `/subscriptions/${sub.ROWID}?paid=1`,
  });
}

async function checkoutForInvoice(req, invoice) {
  const client = await findByRowId(req, "clients", invoice.client_rowid);
  const sub = invoice.subscription_rowid
    ? await findByRowId(req, "subscriptions", invoice.subscription_rowid)
    : null;
  const plan = sub ? await findByRowId(req, "plans", sub.plan_rowid) : null;
  return buildPaystackCheckout(req, {
    invoice,
    client,
    plan,
    sub,
    returnPath: `/invoices/${invoice.ROWID}?paid=1`,
  });
}

module.exports = {
  checkoutForSubscription,
  checkoutForInvoice,
};
