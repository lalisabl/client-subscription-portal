"use strict";

const {
  findByRowId,
  findOne,
  insertRow,
  updateRow,
  escapeZcql,
  logActivity,
} = require("../catalyst/datastore");
const { safeStr } = require("../utils/authUtils");
const { nowUtcForCatalyst, nextRunFromFrequency, safeJsonStringify } = require("../utils/dateUtils");
const { markInvoicePaid, formatZAR } = require("./invoices");
const { sendPaymentReceiptEmail } = require("./email");

async function recordWebhookEvent(req, { reference, providerId, status, signatureValid, payload }) {
  const existing = providerId
    ? await findOne(req, "payfast_webhook_events", `pf_payment_id='${escapeZcql(providerId)}'`)
    : null;
  if (existing && String(existing.processed) === "true") {
    return { duplicate: true, row: existing };
  }

  const row = await insertRow(req, "payfast_webhook_events", {
    m_payment_id: reference,
    pf_payment_id: providerId,
    payment_status: status,
    token: "",
    signature_valid: !!signatureValid,
    payload_json: safeJsonStringify(payload),
    received_at: nowUtcForCatalyst(),
    processed: false,
    process_error: "",
  });
  return { duplicate: false, row };
}

async function fulfillSuccessfulPayment(req, invoice, { reference, providerId, amountCents, channel, rawPayload }) {
  if (String(invoice.status).toLowerCase() === "paid") {
    return { alreadyPaid: true };
  }

  await markInvoicePaid(req, invoice, { provider_id: providerId || reference });
  await insertRow(req, "payments", {
    invoice_rowid: String(invoice.ROWID),
    subscription_rowid: String(invoice.subscription_rowid || ""),
    client_rowid: String(invoice.client_rowid || ""),
    payfast_payment_id: safeStr(providerId || reference),
    m_payment_id: safeStr(reference),
    amount_cents: Number(amountCents) || Number(invoice.total_cents) || 0,
    status: "complete",
    method: safeStr(channel || "card"),
    raw_json: safeJsonStringify(rawPayload),
    created_at: nowUtcForCatalyst(),
  });

  if (invoice.subscription_rowid) {
    const sub = await findByRowId(req, "subscriptions", invoice.subscription_rowid);
    if (sub) {
      const authCode = safeStr(rawPayload?.authorization?.authorization_code);
      const updates = {
        status: "active",
        updated_at: nowUtcForCatalyst(),
        next_run_date: nextRunFromFrequency(sub.frequency, sub.next_run_date || sub.start_date),
      };
      if (authCode) updates.payfast_token = authCode;
      await updateRow(req, "subscriptions", sub.ROWID, updates);
    }
  }

  try {
    const client = await findByRowId(req, "clients", invoice.client_rowid);
    if (client?.email) {
      await sendPaymentReceiptEmail({
        to: client.email,
        name: client.contact_person || client.name,
        invoiceNumber: invoice.invoice_number,
        amountLabel: formatZAR(invoice.total_cents),
        req,
        invoiceId: String(invoice.ROWID),
      });
    }
  } catch (mailErr) {
    console.error("receipt_email_failed", mailErr);
  }

  await logActivity(req, {
    actor_type: "paystack",
    actor_email: "",
    action: "payment.complete",
    entity_type: "invoice",
    entity_rowid: String(invoice.ROWID),
    summary: `Payment complete for ${invoice.invoice_number}`,
  });

  return { alreadyPaid: false };
}

async function fulfillFailedPayment(req, invoice, { reference, providerId, amountCents, channel, rawPayload }) {
  await updateRow(req, "invoices", invoice.ROWID, { status: "failed" });
  if (invoice.subscription_rowid) {
    await updateRow(req, "subscriptions", invoice.subscription_rowid, {
      status: "failed",
      updated_at: nowUtcForCatalyst(),
    });
  }
  await insertRow(req, "payments", {
    invoice_rowid: String(invoice.ROWID),
    subscription_rowid: String(invoice.subscription_rowid || ""),
    client_rowid: String(invoice.client_rowid || ""),
    payfast_payment_id: safeStr(providerId || reference),
    m_payment_id: safeStr(reference),
    amount_cents: Number(amountCents) || Number(invoice.total_cents) || 0,
    status: "failed",
    method: safeStr(channel || "card"),
    raw_json: safeJsonStringify(rawPayload),
    created_at: nowUtcForCatalyst(),
  });
}

module.exports = {
  recordWebhookEvent,
  fulfillSuccessfulPayment,
  fulfillFailedPayment,
};
