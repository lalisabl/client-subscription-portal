"use strict";

const express = require("express");
const { findOne, updateRow, escapeZcql } = require("../catalyst/datastore");
const { requireAuth, safeStr } = require("../utils/authUtils");
const { verifyTransaction, verifyWebhookSignature } = require("../services/paystack");
const {
  recordWebhookEvent,
  fulfillSuccessfulPayment,
  fulfillFailedPayment,
} = require("../services/paymentFulfillment");

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

  const invoice = await findOne(req, "invoices", `m_payment_id='${escapeZcql(reference)}'`);
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
      const reference = safeStr(data.reference);
      const providerId = safeStr(data.id || reference);
      const status = safeStr(data.status || event).toUpperCase();

      const recorded = await recordWebhookEvent(req, {
        reference,
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

      await processChargeEvent(req, event, data, signatureValid, recorded.row);
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
      const invoice = await findOne(req, "invoices", `m_payment_id='${escapeZcql(reference)}'`);
      if (!invoice) return res.status(404).json({ ok: false, error: "Invoice not found for reference" });

      if (status === "success") {
        await fulfillSuccessfulPayment(req, invoice, {
          reference,
          providerId: safeStr(data.id || reference),
          amountCents: Number(data.amount) || 0,
          channel: data.channel,
          rawPayload: data,
        });
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
