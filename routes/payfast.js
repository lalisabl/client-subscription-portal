"use strict";

const express = require("express");
const {
  findOne,
  findByRowId,
  insertRow,
  updateRow,
  escapeZcql,
  logActivity,
} = require("../catalyst/datastore");
const { requireAuth, requireStaff, safeStr } = require("../utils/authUtils");
const { nowUtcForCatalyst, nextRunFromFrequency, safeJsonStringify } = require("../utils/dateUtils");
const {
  createOnsitePayment,
  verifyItnSignature,
  validateItn,
  zarToCents,
  centsToZar,
} = require("../services/payfast");
const { markInvoicePaid, formatZAR } = require("../services/invoices");
const { sendPaymentReceiptEmail } = require("../services/email");

function createPayfastRouter() {
  const router = express.Router();

  /** Staff helper: generate onsite uuid for arbitrary payment (rarely used; prefer subscription checkout) */
  router.post("/api/payfast/onsite", requireAuth, requireStaff, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await createOnsitePayment({
        ...body,
        subscription: !!body.subscription,
      });
      return res.json({ ok: true, uuid: result.uuid });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  /**
   * PayFast ITN webhook — public endpoint (no JWT).
   * PayFast posts application/x-www-form-urlencoded.
   */
  router.post("/api/payfast/itn", async (req, res) => {
    // Acknowledge quickly; process after basic checks
    const payload = req.body || {};
    const mPaymentId = safeStr(payload.m_payment_id);
    const pfPaymentId = safeStr(payload.pf_payment_id);
    const paymentStatus = safeStr(payload.payment_status).toUpperCase();
    const token = safeStr(payload.token);

    try {
      const signatureValid = verifyItnSignature(payload);
      let serverValid = false;
      try {
        serverValid = await validateItn(payload);
      } catch (e) {
        console.error("itn_validate_error", e);
      }

      // idempotency
      const existing = pfPaymentId
        ? await findOne(req, "payfast_webhook_events", `pf_payment_id='${escapeZcql(pfPaymentId)}'`)
        : null;
      if (existing && String(existing.processed) === "true") {
        return res.status(200).send("OK");
      }

      const eventRow = await insertRow(req, "payfast_webhook_events", {
        m_payment_id: mPaymentId,
        pf_payment_id: pfPaymentId,
        payment_status: paymentStatus,
        token,
        signature_valid: signatureValid && serverValid,
        payload_json: safeJsonStringify(payload),
        received_at: nowUtcForCatalyst(),
        processed: false,
        process_error: "",
      });

      if (!signatureValid || !serverValid) {
        await updateRow(req, "payfast_webhook_events", eventRow.ROWID, {
          process_error: "Invalid signature or PayFast validation failed",
          processed: true,
        });
        return res.status(200).send("OK");
      }

      const invoice = mPaymentId
        ? await findOne(req, "invoices", `m_payment_id='${escapeZcql(mPaymentId)}'`)
        : null;

      if (paymentStatus === "COMPLETE" && invoice) {
        await markInvoicePaid(req, invoice, { pf_payment_id: pfPaymentId });
        await insertRow(req, "payments", {
          invoice_rowid: String(invoice.ROWID),
          subscription_rowid: String(invoice.subscription_rowid || ""),
          client_rowid: String(invoice.client_rowid || ""),
          payfast_payment_id: pfPaymentId,
          m_payment_id: mPaymentId,
          amount_cents: zarToCents(payload.amount_gross || payload.amount),
          status: "complete",
          method: safeStr(payload.payment_method || "cc"),
          raw_json: safeJsonStringify(payload),
          created_at: nowUtcForCatalyst(),
        });

        if (invoice.subscription_rowid) {
          const sub = await findByRowId(req, "subscriptions", invoice.subscription_rowid);
          if (sub) {
            const updates = {
              status: "active",
              updated_at: nowUtcForCatalyst(),
              next_run_date: nextRunFromFrequency(sub.frequency, sub.next_run_date || sub.start_date),
            };
            if (token) updates.payfast_token = token;
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
            });
          }
        } catch (mailErr) {
          console.error("receipt_email_failed", mailErr);
        }

        await logActivity(req, {
          actor_type: "payfast",
          actor_email: "",
          action: "payment.complete",
          entity_type: "invoice",
          entity_rowid: String(invoice.ROWID),
          summary: `Payment complete for ${invoice.invoice_number}`,
        });
      } else if (paymentStatus === "FAILED" && invoice) {
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
          payfast_payment_id: pfPaymentId,
          m_payment_id: mPaymentId,
          amount_cents: zarToCents(payload.amount_gross || payload.amount),
          status: "failed",
          method: safeStr(payload.payment_method || "cc"),
          raw_json: safeJsonStringify(payload),
          created_at: nowUtcForCatalyst(),
        });
      } else if (paymentStatus === "CANCELLED" && invoice?.subscription_rowid) {
        await updateRow(req, "subscriptions", invoice.subscription_rowid, {
          status: "cancelled",
          updated_at: nowUtcForCatalyst(),
        });
      }

      await updateRow(req, "payfast_webhook_events", eventRow.ROWID, { processed: true });
      return res.status(200).send("OK");
    } catch (err) {
      console.error("itn_error", err);
      // still 200 so PayFast does not retry forever on our bugs — but log it
      return res.status(200).send("OK");
    }
  });

  return router;
}

module.exports = { createPayfastRouter };
