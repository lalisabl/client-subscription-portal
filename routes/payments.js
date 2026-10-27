"use strict";

const express = require("express");
const { findMany, countRows, escapeZcql } = require("../catalyst/datastore");
const { requireAuth, requireStaff, safeStr } = require("../utils/authUtils");
const { formatZAR } = require("../services/invoices");

function createPaymentsRouter() {
  const router = express.Router();

  router.get("/api/payments", requireAuth, requireStaff, async (req, res) => {
    try {
      const clientId = safeStr(req.query.client_rowid);
      let where = "1=1";
      if (clientId) where += ` AND client_rowid='${escapeZcql(clientId)}'`;
      const [rows, total] = await Promise.all([
        findMany(req, "payments", where, "CREATEDTIME DESC", Number(req.query.limit) || 50, Number(req.query.offset) || 0),
        countRows(req, "payments", where),
      ]);
      return res.json({
        ok: true,
        rows: rows.map((p) => ({ ...p, amount_label: formatZAR(p.amount_cents) })),
        total,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  return router;
}

module.exports = { createPaymentsRouter };
