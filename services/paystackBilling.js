"use strict";

const { findByRowId, findOne, updateRow, escapeZcql } = require("../catalyst/datastore");
const { safeStr } = require("../utils/authUtils");
const { createInvoiceForSubscription } = require("./invoices");
const {
  findSubscriptionForPaystackEvent,
  metaSubscriptionRowId,
  applyPaystackSubscriptionSnapshot,
} = require("./paystackSubscriptions");

async function resolveInvoiceForCharge(req, data) {
  const reference = safeStr(data?.reference);
  if (!reference) return null;

  let invoice = await findOne(req, "invoices", `m_payment_id='${escapeZcql(reference)}'`);
  if (invoice) return invoice;

  const metaId = metaSubscriptionRowId(data);
  let sub = null;
  if (metaId) sub = await findByRowId(req, "subscriptions", metaId);
  if (!sub) sub = await findSubscriptionForPaystackEvent(req, data);
  if (!sub) return null;

  const client = await findByRowId(req, "clients", sub.client_rowid);
  const plan = sub.plan_rowid ? await findByRowId(req, "plans", sub.plan_rowid) : null;

  invoice = await createInvoiceForSubscription(req, {
    subscription: sub,
    client,
    plan,
    status: "sent",
  });
  await updateRow(req, "invoices", invoice.ROWID, {
    m_payment_id: reference,
    payfast_payment_id: safeStr(data.id || reference),
  });
  return findByRowId(req, "invoices", invoice.ROWID);
}

async function ensureInvoiceForPaystackInvoiceEvent(req, data) {
  const reference = safeStr(data.transaction?.reference);
  if (!reference) return null;

  const existing = await findOne(req, "invoices", `m_payment_id='${escapeZcql(reference)}'`);
  if (existing) return existing;

  const sub = await findSubscriptionForPaystackEvent(req, data);
  if (!sub) return null;

  const client = await findByRowId(req, "clients", sub.client_rowid);
  const plan = sub.plan_rowid ? await findByRowId(req, "plans", sub.plan_rowid) : null;
  const invoice = await createInvoiceForSubscription(req, {
    subscription: sub,
    client,
    plan,
    status: "sent",
  });
  await updateRow(req, "invoices", invoice.ROWID, { m_payment_id: reference });
  await applyPaystackSubscriptionSnapshot(req, sub, data.subscription || data);
  return findByRowId(req, "invoices", invoice.ROWID);
}

module.exports = {
  resolveInvoiceForCharge,
  ensureInvoiceForPaystackInvoiceEvent,
};
