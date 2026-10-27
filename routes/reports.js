"use strict";

const express = require("express");
const { findAll, escapeZcql } = require("../catalyst/datastore");
const { requireAuth, requireStaff, safeStr } = require("../utils/authUtils");
const { todayYmdSa } = require("../utils/dateUtils");

function createReportsRouter() {
  const router = express.Router();

  router.get("/api/reports/summary", requireAuth, requireStaff, async (req, res) => {
    try {
      const start = safeStr(req.query.start) || `${new Date().getFullYear()}-01-01`;
      const end = safeStr(req.query.end) || todayYmdSa();

      const paid = await findAll(
        req,
        "invoices",
        `status='paid' AND issue_date>='${escapeZcql(start)}' AND issue_date<='${escapeZcql(end)}'`,
        "issue_date ASC"
      );
      const overdueWhereBase = `due_date>='${escapeZcql(start)}' AND due_date<='${escapeZcql(end)}'`;
      const [overdueSent, overdueMarked, overdueFailed] = await Promise.all([
        findAll(req, "invoices", `status='sent' AND ${overdueWhereBase}`, "due_date ASC"),
        findAll(req, "invoices", `status='overdue' AND ${overdueWhereBase}`, "due_date ASC"),
        findAll(req, "invoices", `status='failed' AND ${overdueWhereBase}`, "due_date ASC"),
      ]);
      const overdue = [...overdueSent, ...overdueMarked, ...overdueFailed];
      const activeSubs = await findAll(req, "subscriptions", "status='active'", "CREATEDTIME DESC");

      let mrrCents = 0;
      for (const s of activeSubs) {
        const freq = Number(s.frequency || 3);
        const amount = Number(s.amount_cents || 0);
        if (freq === 3) mrrCents += amount;
        else if (freq === 4) mrrCents += Math.round(amount / 3);
        else if (freq === 5) mrrCents += Math.round(amount / 6);
        else if (freq === 6) mrrCents += Math.round(amount / 12);
        else mrrCents += amount;
      }

      const collectedCents = paid.reduce((s, i) => s + Number(i.total_cents || 0), 0);
      const overdueCents = overdue.reduce((s, i) => s + Number(i.total_cents || 0), 0);

      const byStatus = {};
      const allSubs = await findAll(req, "subscriptions", "", "CREATEDTIME DESC");
      for (const s of allSubs) {
        const st = s.status || "unknown";
        byStatus[st] = (byStatus[st] || 0) + 1;
      }

      return res.json({
        ok: true,
        range: { start, end },
        kpis: {
          mrrCents,
          collectedCents,
          overdueCents,
          paidInvoices: paid.length,
          overdueInvoices: overdue.length,
          activeSubscriptions: activeSubs.length,
        },
        statusMix: Object.entries(byStatus).map(([key, count]) => ({ key, count })),
        paidInvoices: paid,
        overdueInvoices: overdue,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  return router;
}

module.exports = { createReportsRouter };
