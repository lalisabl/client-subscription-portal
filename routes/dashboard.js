"use strict";

const express = require("express");
const { findMany, findAll, countRows, escapeZcql } = require("../catalyst/datastore");
const { requireAuth, requireStaff } = require("../utils/authUtils");
const { todayYmdSa, parseYmd } = require("../utils/dateUtils");

function createDashboardRouter() {
  const router = express.Router();

  router.get("/api/dashboard", requireAuth, requireStaff, async (req, res) => {
    try {
      const activeClients = await countRows(req, "clients", "status='active'");
      const activeSubs = await countRows(req, "subscriptions", "status='active'");
      const pendingSubs = await countRows(req, "subscriptions", "status='pending'");
      const pausedSubs = await countRows(req, "subscriptions", "status='paused'");
      const cancelledSubs = await countRows(req, "subscriptions", "status='cancelled'");
      const failedSubs = await countRows(req, "subscriptions", "status='failed'");
      const trialSubs = await countRows(req, "subscriptions", "status='trial'");

      const activeList = await findAll(req, "subscriptions", "status='active'", "CREATEDTIME DESC");
      let mrrCents = 0;
      for (const s of activeList) {
        const freq = Number(s.frequency || 3);
        const amount = Number(s.amount_cents || 0);
        // normalize to monthly
        if (freq === 3) mrrCents += amount;
        else if (freq === 4) mrrCents += Math.round(amount / 3);
        else if (freq === 5) mrrCents += Math.round(amount / 6);
        else if (freq === 6) mrrCents += Math.round(amount / 12);
        else mrrCents += amount;
      }

      const overdueInvoices = await findMany(
        req,
        "invoices",
        `(status='sent' OR status='overdue' OR status='failed') AND due_date<'${escapeZcql(todayYmdSa())}'`,
        "due_date ASC",
        200,
        0
      );
      const overdueCents = overdueInvoices.reduce((sum, i) => sum + Number(i.total_cents || 0), 0);

      const plans = await findMany(req, "plans", "active=true", "CREATEDTIME DESC", 100, 0);
      const planMix = [];
      for (const p of plans) {
        const count = await countRows(req, "subscriptions", `plan_rowid='${escapeZcql(p.ROWID)}' AND status='active'`);
        if (count > 0) planMix.push({ name: p.name, subs: count, plan_rowid: p.ROWID });
      }

      const today = parseYmd(todayYmdSa());
      const in7 = new Date(Date.UTC(today.y, today.mo - 1, today.d + 7));
      const in30 = new Date(Date.UTC(today.y, today.mo - 1, today.d + 30));
      const ymd = (d) =>
        `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      const d7 = ymd(in7);
      const d30 = ymd(in30);
      const now = todayYmdSa();

      const renew7 = await findMany(
        req,
        "subscriptions",
        `status='active' AND next_run_date>='${escapeZcql(now)}' AND next_run_date<='${escapeZcql(d7)}'`,
        "next_run_date ASC",
        200,
        0
      );
      const renew30 = await findMany(
        req,
        "subscriptions",
        `status='active' AND next_run_date>'${escapeZcql(d7)}' AND next_run_date<='${escapeZcql(d30)}'`,
        "next_run_date ASC",
        200,
        0
      );
      const renewLater = await findMany(
        req,
        "subscriptions",
        `status='active' AND next_run_date>'${escapeZcql(d30)}'`,
        "next_run_date ASC",
        200,
        0
      );

      const activity = await findMany(req, "activity_log", "1=1", "CREATEDTIME DESC", 10, 0);

      // simple 12-month revenue trend from paid invoices (best-effort)
      const paid = await findAll(req, "invoices", "status='paid'", "issue_date ASC");
      const byMonth = {};
      for (const inv of paid) {
        const key = String(inv.issue_date || "").slice(0, 7);
        if (!key) continue;
        byMonth[key] = (byMonth[key] || 0) + Number(inv.total_cents || 0);
      }
      const revenueTrend = Object.keys(byMonth)
        .sort()
        .slice(-12)
        .map((label) => ({ label, value: Math.round(byMonth[label] / 100) }));

      return res.json({
        ok: true,
        kpis: {
          activeClients,
          activeSubscriptions: activeSubs,
          mrrCents,
          overdueCents,
          overdueInvoices: overdueInvoices.length,
        },
        subscriptionStatus: [
          { key: "active", label: "Active", count: activeSubs, color: "#22c55e" },
          { key: "pending", label: "Pending", count: pendingSubs, color: "#3b82f6" },
          { key: "paused", label: "Paused", count: pausedSubs, color: "#f59e0b" },
          { key: "failed", label: "Failed", count: failedSubs, color: "#ef3b44" },
          { key: "cancelled", label: "Cancelled", count: cancelledSubs, color: "#71717a" },
          { key: "trial", label: "Trial", count: trialSubs, color: "#a78bfa" },
        ].filter((s) => s.count > 0 || ["active", "paused", "cancelled"].includes(s.key)),
        renewals: [
          {
            window: "Next 7 days",
            count: renew7.length,
            amountCents: renew7.reduce((s, r) => s + Number(r.amount_cents || 0), 0),
            color: "#ef3b44",
          },
          {
            window: "8 to 30 days",
            count: renew30.length,
            amountCents: renew30.reduce((s, r) => s + Number(r.amount_cents || 0), 0),
            color: "#f59e0b",
          },
          {
            window: "Later",
            count: renewLater.length,
            amountCents: renewLater.reduce((s, r) => s + Number(r.amount_cents || 0), 0),
            color: "#52525b",
          },
        ],
        planMix,
        activity: activity.map((a) => ({
          title: a.summary || a.action,
          sub: a.actor_email || a.actor_type,
          time: a.created_at || "",
          tone: a.action?.includes("fail") || a.action?.includes("cancel") ? "amber" : "green",
        })),
        revenueTrend,
      });
    } catch (err) {
      console.error("dashboard_error", err);
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  return router;
}

module.exports = { createDashboardRouter };
