"use strict";

const express = require("express");
const { findOne, findByRowId, updateRow, escapeZcql } = require("../catalyst/datastore");
const { requireAuth, safeStr } = require("../utils/authUtils");
const { verifyTransaction, verifyWebhookSignature } = require("../services/paystack");
const {
  recordWebhookEvent,
  fulfillSuccessfulPayment,
  fulfillFailedPayment,
} = require("../services/paymentFulfillment");
const { resolveInvoiceForCharge, ensureInvoiceForPaystackInvoiceEvent } = require("../services/paystackBilling");
const {
  syncPaystackSubscriptionOnCreate,
  syncPaystackSubscriptionStatus,
  applyPaystackSubscriptionSnapshot,
  findSubscriptionForPaystackEvent,
  resolveAndPersistPaystackSubscriptionLink,
} = require("../services/paystackSubscriptions");

async function processChargeEvent(req, event, data, signatureValid, eventRow) {
  const reference = safeStr(data?.reference);
  const status = safeStr(data?.status).toLowerCase();
  const providerId = safeStr(data?.id || reference);
  if (!reference) {
    if (eventRow?.ROWID) {
      await updateRow(req, "payfast_webhook_events", eventRow.ROWID, {
        processed: true,
        process_error: "Missing reference",
      });
    }
    return;
  }

  let invoice = await findOne(req, "invoices", `m_payment_id='${escapeZcql(reference)}'`);
  if (!invoice) {
    try {
      invoice = await resolveInvoiceForCharge(req, data);
    } catch (err) {
      console.error("resolve_invoice_for_charge", err);
    }
  }

  if (!invoice) {
    if (eventRow?.ROWID) {
      await updateRow(req, "payfast_webhook_events", eventRow.ROWID, {
        processed: true,
        process_error: "Invoice not found for reference",
      });
    }
    return;
  }

  if (status === "success" && (event === "charge.success" || event === "transaction.success")) {
    await fulfillSuccessfulPayment(req, invoice, {
      reference,
      providerId,
      amountCents: Number(data?.amount) || 0,
      channel: data?.channel,
      rawPayload: data,
    });
  } else if (status === "failed" || event === "charge.failed") {
    await fulfillFailedPayment(req, invoice, {
      reference,
      providerId,
      amountCents: Number(data?.amount) || 0,
      channel: data?.channel,
      rawPayload: data,
    });
  }

  if (eventRow?.ROWID) {
    await updateRow(req, "payfast_webhook_events", eventRow.ROWID, { processed: true });
  }
}

async function processSubscriptionEvent(req, event, data, eventRow) {
  try {
    if (event === "subscription.create") {
      await syncPaystackSubscriptionOnCreate(req, data);
    } else if (event === "subscription.disable") {
      await syncPaystackSubscriptionStatus(req, data, "cancelled");
    } else if (event === "subscription.not_renew") {
      const sub = await findSubscriptionForPaystackEvent(req, data);
      const target =
        sub && safeStr(sub.status).toLowerCase() === "cancelled" ? "cancelled" : "paused";
      await syncPaystackSubscriptionStatus(req, data, target);
    } else if (event === "invoice.create") {
      await ensureInvoiceForPaystackInvoiceEvent(req, data);
    } else if (event === "invoice.payment_failed") {
      const sub = await syncPaystackSubscriptionStatus(req, data, "failed");
      if (sub && data?.transaction?.reference) {
        const invoice = await findOne(
          req,
          "invoices",
          `m_payment_id='${escapeZcql(data.transaction.reference)}'`,
        );
        if (invoice) {
          await fulfillFailedPayment(req, invoice, {
            reference: safeStr(data.transaction.reference),
            providerId: safeStr(data.transaction.id || data.transaction.reference),
            amountCents: Number(data.amount) || 0,
            channel: "",
            rawPayload: data,
          });
        }
      }
    } else if (event === "invoice.update" && data?.paid === true) {
      const sub = await findSubscriptionForPaystackEvent(req, data);
      if (sub) await applyPaystackSubscriptionSnapshot(req, sub, data.subscription || data);
    }
  } catch (err) {
    console.error("paystack_subscription_event_error", event, err);
    if (eventRow?.ROWID) {
      await updateRow(req, "payfast_webhook_events", eventRow.ROWID, {
        process_error: String(err?.message || err).slice(0, 500),
      });
    }
  }

  if (eventRow?.ROWID) {
    await updateRow(req, "payfast_webhook_events", eventRow.ROWID, { processed: true });
  }
}

function createPaystackRouter() {
  const router = express.Router();

  /** Paystack webhook — public, JSON body. */
  router.post("/api/paystack/webhook", async (req, res) => {
    try {
      const rawBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body || {});
      const sig =
        safeStr(req.headers["paystack-signature"]) || safeStr(req.headers["x-paystack-signature"]);
      const signatureValid = verifyWebhookSignature(rawBody, sig);
      const body = req.body || {};
      const event = safeStr(body.event);
      const data = body.data || {};
      const reference = safeStr(data.reference || data.transaction?.reference);
      const providerId = safeStr(data.id || data.transaction?.id || reference);
      const status = safeStr(data.status || event).toUpperCase();

      const recorded = await recordWebhookEvent(req, {
        reference: reference || `${event}-${providerId}`,
        providerId,
        status,
        signatureValid,
        payload: body,
      });

      if (recorded.duplicate) {
        return res.status(200).json({ ok: true });
      }

      if (!signatureValid) {
        await updateRow(req, "payfast_webhook_events", recorded.row.ROWID, {
          processed: true,
          process_error: "Invalid webhook signature",
        });
        return res.status(401).json({ ok: false, error: "Invalid signature" });
      }

      if (
        event === "charge.success" ||
        event === "transaction.success" ||
        event === "charge.failed"
      ) {
        await processChargeEvent(req, event, data, signatureValid, recorded.row);
      } else if (
        event === "subscription.create" ||
        event === "subscription.disable" ||
        event === "subscription.not_renew" ||
        event === "invoice.create" ||
        event === "invoice.payment_failed" ||
        event === "invoice.update"
      ) {
        await processSubscriptionEvent(req, event, data, recorded.row);
      } else {
        await updateRow(req, "payfast_webhook_events", recorded.row.ROWID, {
          processed: true,
          process_error: `Unhandled event: ${event || "unknown"}`,
        });
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("paystack_webhook_error", err);
      return res.status(200).json({ ok: true });
    }
  });

  /** Verify payment after customer returns from Paystack (backup if webhook is delayed). */
  router.get("/api/paystack/verify", requireAuth, async (req, res) => {
    try {
      const reference = safeStr(req.query.reference || req.query.trxref);
      if (!reference) return res.status(400).json({ ok: false, error: "reference is required" });

      const data = await verifyTransaction(reference);
      const status = safeStr(data.status).toLowerCase();
      let invoice = await findOne(req, "invoices", `m_payment_id='${escapeZcql(reference)}'`);
      if (!invoice) invoice = await resolveInvoiceForCharge(req, data);
      if (!invoice) return res.status(404).json({ ok: false, error: "Invoice not found for reference" });

      if (status === "success") {
        await fulfillSuccessfulPayment(req, invoice, {
          reference,
          providerId: safeStr(data.id || reference),
          amountCents: Number(data.amount) || 0,
          channel: data.channel,
          rawPayload: data,
        });
        if (invoice.subscription_rowid) {
          const sub = await findByRowId(req, "subscriptions", invoice.subscription_rowid);
          if (sub) await resolveAndPersistPaystackSubscriptionLink(req, sub);
        }
      }

      return res.json({
        ok: true,
        status,
        invoice_id: invoice.ROWID,
        invoice_status: status === "success" ? "paid" : invoice.status,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  return router;
}

module.exports = { createPaystackRouter };
