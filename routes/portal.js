"use strict";

const express = require("express");
const { findByRowId, findMany, escapeZcql } = require("../catalyst/datastore");
const { requireAuth, requireClientScope, isStaff, safeStr } = require("../utils/authUtils");
const { formatZAR } = require("../services/invoices");

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
