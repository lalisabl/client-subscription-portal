"use strict";

const { findByRowId, findMany, updateRow, escapeZcql } = require("../catalyst/datastore");
const { safeStr } = require("../utils/authUtils");
const { createInvoiceForSubscription } = require("./invoices");
const { initializeTransaction } = require("./paystack");
const { ensurePaystackPlan } = require("./paystackSubscriptions");

function mintPaymentReference(invoice) {
  const id = safeStr(invoice?.ROWID) || "new";
  return `inv-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Validates Paystack recurring checkout can be built — does not call Paystack initialize (avoids duplicate references). */
async function preparePaystackCheckout(req, { client, plan: planIn, sub, usePaystackSubscription = false }) {
  let plan = planIn;
  if (!client) throw new Error("Client missing");
  const email = safeStr(client.email);
  if (!email) throw new Error("Client email is required for online payment");

  let planCode = "";
  if (usePaystackSubscription && plan) {
    planCode = safeStr(plan.paystack_plan_code);
    if (!planCode) {
      planCode = await ensurePaystackPlan(req, plan);
      plan = await findByRowId(req, "plans", plan.ROWID);
    }
  }

  if (usePaystackSubscription && !planCode) {
    throw new Error("Paystack recurring checkout could not be prepared (missing plan code)");
  }

  return {
    paystack_subscription_checkout: !!usePaystackSubscription && !!planCode,
    paystack_plan_code: planCode || undefined,
    plan_name: plan?.name,
  };
}

async function buildPaystackCheckout(
  req,
  { invoice, client, plan: planIn, sub, returnPath, usePaystackSubscription = false },
) {
  let plan = planIn;
  if (!client) throw new Error("Client missing");
  const email = safeStr(client.email);
  if (!email) throw new Error("Client email is required for online payment");

  const portalBase = safeStr(process.env.PORTAL_BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
  const reference = mintPaymentReference(invoice);

  if (invoice.ROWID) {
    await updateRow(req, "invoices", invoice.ROWID, { m_payment_id: reference });
  }

  const callbackPath = safeStr(returnPath) || `/invoices/${invoice.ROWID}?paid=1`;
  const callbackUrl = `${portalBase}${callbackPath.startsWith("/") ? callbackPath : `/${callbackPath}`}`;

  let planCode = "";
  if (usePaystackSubscription && plan) {
    planCode = safeStr(plan.paystack_plan_code);
    if (!planCode) {
      planCode = await ensurePaystackPlan(req, plan);
      plan = await findByRowId(req, "plans", plan.ROWID);
    }
  }

  const init = await initializeTransaction({
    email,
    amountCents: Number(invoice.total_cents || sub?.amount_cents || 0),
    reference,
    callbackUrl,
    currency: safeStr(plan?.currency) || "ZAR",
    planCode: usePaystackSubscription ? planCode : "",
    metadata: {
      invoice_rowid: String(invoice.ROWID),
      subscription_rowid: String(invoice.subscription_rowid || sub?.ROWID || ""),
      client_rowid: String(client.ROWID),
      catalyst_subscription_rowid: String(sub?.ROWID || invoice.subscription_rowid || ""),
    },
  });

  return {
    authorization_url: init.authorization_url,
    access_code: init.access_code,
    reference: init.reference || reference,
    m_payment_id: reference,
    invoice_id: invoice.ROWID,
    plan_name: plan?.name,
    paystack_subscription_checkout: !!usePaystackSubscription && !!planCode,
    paystack_plan_code: planCode || undefined,
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

  const usePaystackSubscription = shouldUsePaystackSubscriptionCheckout(sub);

  return buildPaystackCheckout(req, {
    invoice,
    client,
    plan,
    sub,
    returnPath: `/subscriptions/${sub.ROWID}?paid=1`,
    usePaystackSubscription,
  });
}

function shouldUsePaystackSubscriptionCheckout(sub) {
  if (!sub) return false;
  if (safeStr(sub.paystack_subscription_code)) return false;
  const st = safeStr(sub.status).toLowerCase();
  if (st === "cancelled") return false;
  return true;
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
    usePaystackSubscription: shouldUsePaystackSubscriptionCheckout(sub),
  });
}

module.exports = {
  mintPaymentReference,
  preparePaystackCheckout,
  buildPaystackCheckout,
  checkoutForSubscription,
  checkoutForInvoice,
  shouldUsePaystackSubscriptionCheckout,
};
