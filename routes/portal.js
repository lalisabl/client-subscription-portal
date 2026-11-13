"use strict";

const express = require("express");
const { findByRowId, findMany, updateRow, escapeZcql } = require("../catalyst/datastore");
const { requireAuth, requireClientScope, isStaff, safeStr } = require("../utils/authUtils");
const { formatZAR } = require("../services/invoices");
const { cancelPaystackSubscriptionRemote } = require("../services/paystackSubscriptions");
const { nowUtcForCatalyst } = require("../utils/dateUtils");
const { logActivity } = require("../catalyst/datastore");

function createPortalRouter() {
  const router = express.Router();

  function clientId(req) {
    if (isStaff(req.user)) return safeStr(req.query.client_rowid || req.user.client_rowid);
    return safeStr(req.user.client_rowid);
  }

  router.get("/api/portal/me", requireAuth, requireClientScope, async (req, res) => {
    try {
      const id = clientId(req);
      if (!id) return res.status(400).json({ ok: false, error: "No client linked" });
      const client = await findByRowId(req, "clients", id);
      if (!client) return res.status(404).json({ ok: false, error: "Client not found" });
      return res.json({ ok: true, client });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/api/portal/subscriptions/:id", requireAuth, requireClientScope, async (req, res) => {
    try {
      const clientIdVal = clientId(req);
      const sub = await findByRowId(req, "subscriptions", req.params.id);
      if (!sub) return res.status(404).json({ ok: false, error: "Subscription not found" });
      if (String(sub.client_rowid) !== String(clientIdVal)) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }
      const plan = sub.plan_rowid ? await findByRowId(req, "plans", sub.plan_rowid) : null;
      const client = await findByRowId(req, "clients", clientIdVal);
      const invoices = await findMany(
        req,
        "invoices",
        `subscription_rowid='${escapeZcql(req.params.id)}'`,
        "CREATEDTIME DESC",
        50,
        0,
      );
      return res.json({
        ok: true,
        subscription: {
          ...sub,
          plan,
          client: client ? { ROWID: client.ROWID, name: client.name, email: client.email } : null,
          amount_label: formatZAR(sub.amount_cents),
        },
        invoices,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  /** Client cancels own subscription; disables Paystack recurring when linked. */
  router.post("/api/portal/subscriptions/:id/cancel", requireAuth, requireClientScope, async (req, res) => {
    try {
      const clientIdVal = clientId(req);
      const sub = await findByRowId(req, "subscriptions", req.params.id);
      if (!sub) return res.status(404).json({ ok: false, error: "Subscription not found" });
      if (String(sub.client_rowid) !== String(clientIdVal)) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }
      if (safeStr(sub.status).toLowerCase() === "cancelled") {
        return res.json({ ok: true, subscription: sub, paystack: { skipped: true, reason: "Already cancelled" } });
      }

      let paystack = { skipped: true };
      try {
        paystack = await cancelPaystackSubscriptionRemote(req, sub);
      } catch (psErr) {
        console.error("portal_paystack_cancel_failed", psErr);
        return res.status(502).json({ ok: false, error: String(psErr?.message || psErr) });
      }

      await updateRow(req, "subscriptions", sub.ROWID, { status: "cancelled", updated_at: nowUtcForCatalyst() });
      await logActivity(req, {
        actor_type: "client",
        actor_email: safeStr(req.user.email),
        action: "subscription.cancel",
        entity_type: "subscription",
        entity_rowid: String(sub.ROWID),
        summary: `Client cancelled subscription ${sub.ROWID}`,
      });

      const updated = await findByRowId(req, "subscriptions", sub.ROWID);
      return res.json({ ok: true, subscription: updated, paystack });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/api/portal/subscriptions", requireAuth, requireClientScope, async (req, res) => {
    try {
      const id = clientId(req);
      const rows = await findMany(
        req,
        "subscriptions",
        `client_rowid='${escapeZcql(id)}'`,
        "CREATEDTIME DESC",
        100,
        0
      );
      const enriched = [];
      for (const sub of rows) {
        const plan = await findByRowId(req, "plans", sub.plan_rowid);
        enriched.push({ ...sub, plan, amount_label: formatZAR(sub.amount_cents) });
      }
      return res.json({ ok: true, rows: enriched });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/api/portal/invoices", requireAuth, requireClientScope, async (req, res) => {
    try {
      const id = clientId(req);
      const rows = await findMany(req, "invoices", `client_rowid='${escapeZcql(id)}'`, "CREATEDTIME DESC", 100, 0);
      return res.json({
        ok: true,
        rows: rows.map((inv) => ({ ...inv, total_label: formatZAR(inv.total_cents) })),
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  return router;
}

module.exports = { createPortalRouter };
