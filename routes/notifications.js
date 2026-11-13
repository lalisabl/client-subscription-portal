"use strict";

const express = require("express");
const { findMany, findByRowId, escapeZcql } = require("../catalyst/datastore");
const { requireAuth, isStaff, safeStr } = require("../utils/authUtils");
const { formatZAR } = require("../services/invoices");

/** Staff bell: client-facing events only (payments, invoices needing client action) — not admin CRUD. */
async function staffNotifications(req) {
  const items = [];
  const clientCache = new Map();
  const invoiceCache = new Map();

  async function clientName(clientRowid) {
    const key = String(clientRowid || "");
    if (!key) return "Client";
    if (clientCache.has(key)) return clientCache.get(key);
    const row = await findByRowId(req, "clients", key);
    const name = safeStr(row?.name) || safeStr(row?.contact_person) || "Client";
    clientCache.set(key, name);
    return name;
  }

  async function invoiceBrief(invoiceRowid) {
    const key = String(invoiceRowid || "");
    if (!key) return null;
    if (invoiceCache.has(key)) return invoiceCache.get(key);
    const row = await findByRowId(req, "invoices", key);
    const brief = row ? { ROWID: row.ROWID, invoice_number: row.invoice_number } : null;
    invoiceCache.set(key, brief);
    return brief;
  }

  const [paid, failed] = await Promise.all([
    findMany(req, "payments", "status='complete'", "CREATEDTIME DESC", 20, 0),
    findMany(req, "payments", "status='failed'", "CREATEDTIME DESC", 10, 0),
  ]);

  for (const p of paid) {
    const name = await clientName(p.client_rowid);
    const inv = await invoiceBrief(p.invoice_rowid);
    items.push({
      id: `staff-payment-${p.ROWID}`,
      title: `${name} paid online`,
      message: inv ? `${inv.invoice_number} · ${formatZAR(p.amount_cents)}` : formatZAR(p.amount_cents),
      at: safeStr(p.created_at || p.CREATEDTIME),
      tone: "success",
      href: inv ? `/invoices/${inv.ROWID}` : p.invoice_rowid ? `/invoices/${p.invoice_rowid}` : "",
    });
  }

  for (const p of failed) {
    const name = await clientName(p.client_rowid);
    const inv = await invoiceBrief(p.invoice_rowid);
    items.push({
      id: `staff-payment-failed-${p.ROWID}`,
      title: `${name} — payment failed`,
      message: inv ? `${inv.invoice_number} · ${formatZAR(p.amount_cents)}` : formatZAR(p.amount_cents),
      at: safeStr(p.created_at || p.CREATEDTIME),
      tone: "warning",
      href: inv ? `/invoices/${inv.ROWID}` : "",
    });
  }

  const openInvoices = await findMany(
    req,
    "invoices",
    `status='sent' OR status='failed' OR status='overdue'`,
    "due_date ASC",
    15,
    0
  );
  for (const inv of openInvoices) {
    const name = await clientName(inv.client_rowid);
    items.push({
      id: `staff-invoice-open-${inv.ROWID}`,
      title: `${name} — invoice awaiting payment`,
      message: `${inv.invoice_number} · due ${inv.due_date || "—"} · ${formatZAR(inv.total_cents)}`,
      at: safeStr(inv.CREATEDTIME || inv.issue_date),
      tone: "warning",
      href: `/invoices/${inv.ROWID}`,
    });
  }

  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return items.slice(0, 25);
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
