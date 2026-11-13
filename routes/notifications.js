"use strict";

const express = require("express");
const { findMany, findByRowId, escapeZcql } = require("../catalyst/datastore");
const { requireAuth, isStaff, safeStr } = require("../utils/authUtils");
const { formatZAR } = require("../services/invoices");

function toneForAction(action) {
  const a = safeStr(action).toLowerCase();
  if (a.includes("fail") || a.includes("cancel")) return "warning";
  if (a.includes("payment") || a.includes("paid") || a.includes("complete")) return "success";
  return "info";
}

function hrefForEntity(entityType, entityRowid) {
  const id = safeStr(entityRowid);
  if (!id) return "";
  const t = safeStr(entityType).toLowerCase();
  if (t === "invoice") return `/invoices/${id}`;
  if (t === "subscription") return `/subscriptions/${id}`;
  if (t === "client") return `/clients/${id}`;
  return "";
}

async function staffNotifications(req) {
  const rows = await findMany(req, "activity_log", "", "CREATEDTIME DESC", 25, 0);
  return rows.map((a) => ({
    id: `activity-${a.ROWID}`,
    title: safeStr(a.summary) || safeStr(a.action) || "Activity",
    message: safeStr(a.actor_email) || safeStr(a.actor_type),
    at: safeStr(a.created_at || a.CREATEDTIME),
    tone: toneForAction(a.action),
    href: hrefForEntity(a.entity_type, a.entity_rowid),
  }));
}

async function clientNotifications(req, clientRowid) {
  const id = escapeZcql(clientRowid);
  const items = [];

  const openInvoices = await findMany(
    req,
    "invoices",
    `client_rowid='${id}' AND (status='sent' OR status='failed' OR status='overdue')`,
    "due_date ASC",
    10,
    0
  );
  for (const inv of openInvoices) {
    items.push({
      id: `invoice-open-${inv.ROWID}`,
      title: `Invoice ${inv.invoice_number} awaiting payment`,
      message: `Due ${inv.due_date || "—"} · ${formatZAR(inv.total_cents)}`,
      at: safeStr(inv.CREATEDTIME || inv.issue_date),
      tone: "warning",
      href: `/invoices/${inv.ROWID}`,
    });
  }

  const payments = await findMany(req, "payments", `client_rowid='${id}'`, "CREATEDTIME DESC", 10, 0);
  for (const p of payments) {
    if (safeStr(p.status).toLowerCase() !== "complete") continue;
    items.push({
      id: `payment-${p.ROWID}`,
      title: "Payment received",
      message: formatZAR(p.amount_cents),
      at: safeStr(p.created_at || p.CREATEDTIME),
      tone: "success",
      href: p.invoice_rowid ? `/invoices/${p.invoice_rowid}` : "",
    });
  }

  const subs = await findMany(
    req,
    "subscriptions",
    `client_rowid='${id}' AND (status='pending' OR status='failed')`,
    "CREATEDTIME DESC",
    5,
    0
  );
  for (const s of subs) {
    const plan = s.plan_rowid ? await findByRowId(req, "plans", s.plan_rowid) : null;
    items.push({
      id: `sub-${s.ROWID}`,
      title: `Subscription needs payment`,
      message: plan?.name ? `${plan.name} · ${formatZAR(s.amount_cents)}` : formatZAR(s.amount_cents),
      at: safeStr(s.CREATEDTIME || s.start_date),
      tone: "warning",
      href: `/subscriptions/${s.ROWID}`,
    });
  }

  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return items.slice(0, 25);
}

function createNotificationsRouter() {
  const router = express.Router();

  router.get("/api/notifications", requireAuth, async (req, res) => {
    try {
      let items = [];
      if (isStaff(req.user)) {
        items = await staffNotifications(req);
      } else {
        const clientRowid = safeStr(req.user.client_rowid);
        if (!clientRowid) return res.json({ ok: true, items: [], unreadHint: 0 });
        items = await clientNotifications(req, clientRowid);
      }
      return res.json({
        ok: true,
        items,
        unreadHint: items.filter((i) => i.tone === "warning").length,
      });
    } catch (err) {
      console.error("notifications_error", err);
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  return router;
}

module.exports = { createNotificationsRouter };
