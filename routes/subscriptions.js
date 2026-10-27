"use strict";

const express = require("express");
const {
  findByRowId,
  findMany,
  countRows,
  insertRow,
  updateRow,
  escapeZcql,
  logActivity,
} = require("../catalyst/datastore");
const { requireAuth, requireStaff, safeStr } = require("../utils/authUtils");
const { nowUtcForCatalyst, todayYmdSa, nextRunFromFrequency } = require("../utils/dateUtils");
const {
  createOnsitePayment,
  pauseSubscription,
  unpauseSubscription,
  cancelSubscription,
  updateSubscription,
  centsToZar,
  cardUpdateUrl,
} = require("../services/payfast");
const { createInvoiceForSubscription } = require("../services/invoices");

function createSubscriptionsRouter() {
  const router = express.Router();

  router.get("/api/subscriptions", requireAuth, requireStaff, async (req, res) => {
    try {
      const status = safeStr(req.query.status);
      const clientId = safeStr(req.query.client_rowid);
      const q = safeStr(req.query.q);
      let where = "1=1";
      if (status && status !== "all") where += ` AND status='${escapeZcql(status)}'`;
      if (clientId) where += ` AND client_rowid='${escapeZcql(clientId)}'`;
      const [rows, total] = await Promise.all([
        findMany(req, "subscriptions", where, "CREATEDTIME DESC", Number(req.query.limit) || 50, Number(req.query.offset) || 0),
        countRows(req, "subscriptions", where),
      ]);

      // enrich lightly
      const enriched = [];
      for (const sub of rows) {
        const client = await findByRowId(req, "clients", sub.client_rowid);
        const plan = await findByRowId(req, "plans", sub.plan_rowid);
        if (q) {
          const hay = `${client?.name || ""} ${plan?.name || ""}`.toLowerCase();
          if (!hay.includes(q.toLowerCase())) continue;
        }
        enriched.push({ ...sub, client, plan });
      }
      return res.json({ ok: true, rows: enriched, total });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/api/subscriptions/:id", requireAuth, requireStaff, async (req, res) => {
    try {
      const sub = await findByRowId(req, "subscriptions", req.params.id);
      if (!sub) return res.status(404).json({ ok: false, error: "Subscription not found" });
      const client = await findByRowId(req, "clients", sub.client_rowid);
      const plan = await findByRowId(req, "plans", sub.plan_rowid);
      const invoices = await findMany(
        req,
        "invoices",
        `subscription_rowid='${escapeZcql(req.params.id)}'`,
        "CREATEDTIME DESC",
        50,
        0
      );
      return res.json({ ok: true, subscription: { ...sub, client, plan }, invoices });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/api/subscriptions", requireAuth, requireStaff, async (req, res) => {
    try {
      const client_rowid = safeStr(req.body?.client_rowid);
      const plan_rowid = safeStr(req.body?.plan_rowid);
      if (!client_rowid || !plan_rowid) {
        return res.status(400).json({ ok: false, error: "client_rowid and plan_rowid are required" });
      }
      const client = await findByRowId(req, "clients", client_rowid);
      const plan = await findByRowId(req, "plans", plan_rowid);
      if (!client) return res.status(400).json({ ok: false, error: "Client not found" });
      if (!plan) return res.status(400).json({ ok: false, error: "Plan not found" });

      const start_date = safeStr(req.body?.start_date) || todayYmdSa();
      const amount_cents = Math.round(Number(req.body?.amount_cents != null ? req.body.amount_cents : plan.amount_cents));
      const frequency = Number(req.body?.frequency != null ? req.body.frequency : plan.frequency || 3);
      const cycles = Number(req.body?.cycles != null ? req.body.cycles : plan.cycles || 0);

      const sub = await insertRow(req, "subscriptions", {
        client_rowid,
        plan_rowid,
        status: "pending",
        payfast_token: "",
        amount_cents,
        frequency,
        cycles,
        start_date,
        next_run_date: start_date,
        created_by: safeStr(req.user.email),
        created_at: nowUtcForCatalyst(),
        updated_at: nowUtcForCatalyst(),
      });

      const invoice = await createInvoiceForSubscription(req, {
        subscription: { ...sub, ROWID: sub.ROWID },
        client,
        plan,
        status: "sent",
      });

      await logActivity(req, {
        actor_type: req.user.role,
        actor_email: req.user.email,
        action: "subscription.create",
        entity_type: "subscription",
        entity_rowid: String(sub.ROWID),
        summary: `Created subscription for ${client.name} / ${plan.name}`,
      });

      return res.status(201).json({ ok: true, subscription: sub, invoice });
    } catch (err) {
      console.error("subscription_create_error", err);
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  /** Create PayFast Onsite checkout for this subscription */
  router.post("/api/subscriptions/:id/checkout", requireAuth, async (req, res) => {
    try {
      const sub = await findByRowId(req, "subscriptions", req.params.id);
      if (!sub) return res.status(404).json({ ok: false, error: "Subscription not found" });

      const role = safeStr(req.user.role).toLowerCase();
      if (role === "client" && String(req.user.client_rowid) !== String(sub.client_rowid)) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }
      if (role !== "client" && role !== "admin" && role !== "staff") {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }

      const client = await findByRowId(req, "clients", sub.client_rowid);
      const plan = await findByRowId(req, "plans", sub.plan_rowid);
      if (!client) return res.status(400).json({ ok: false, error: "Client missing" });

      // find unpaid invoice or create one
      let invoices = await findMany(
        req,
        "invoices",
        `subscription_rowid='${escapeZcql(sub.ROWID)}' AND status!='paid'`,
        "CREATEDTIME DESC",
        1,
        0
      );
      let invoice = invoices[0];
      if (!invoice) {
        invoice = await createInvoiceForSubscription(req, { subscription: sub, client, plan, status: "sent" });
      }

      const portalBase = safeStr(process.env.PORTAL_BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
      const apiBase = safeStr(process.env.API_PUBLIC_URL || process.env.PORTAL_BASE_URL || "http://localhost:9000").replace(
        /\/+$/,
        ""
      );

      const nameParts = safeStr(client.contact_person || client.name).split(/\s+/);
      const { uuid } = await createOnsitePayment({
        return_url: `${portalBase}/subscriptions/${sub.ROWID}?paid=1`,
        cancel_url: `${portalBase}/subscriptions/${sub.ROWID}?cancelled=1`,
        notify_url: `${apiBase}/api/payfast/itn`,
        name_first: nameParts[0] || "Client",
        name_last: nameParts.slice(1).join(" ") || "Account",
        email_address: safeStr(client.email),
        cell_number: safeStr(client.phone),
        m_payment_id: safeStr(invoice.m_payment_id) || `inv-${invoice.ROWID}`,
        amount: centsToZar(invoice.total_cents || sub.amount_cents),
        item_name: safeStr(plan?.name || "Subscription"),
        item_description: `Subscription ${sub.ROWID}`,
        subscription: !sub.payfast_token,
        billing_date: sub.start_date || todayYmdSa(),
        recurring_amount: centsToZar(sub.amount_cents),
        frequency: sub.frequency || 3,
        cycles: sub.cycles || 0,
      });

      // ensure m_payment_id stored
      if (invoice.ROWID && !invoice.m_payment_id) {
        await updateRow(req, "invoices", invoice.ROWID, { m_payment_id: `inv-${invoice.ROWID}` });
      }

      return res.json({ ok: true, uuid, invoice_id: invoice.ROWID, m_payment_id: invoice.m_payment_id });
    } catch (err) {
      console.error("checkout_error", err);
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/api/subscriptions/:id/pause", requireAuth, requireStaff, async (req, res) => {
    try {
      const sub = await findByRowId(req, "subscriptions", req.params.id);
      if (!sub) return res.status(404).json({ ok: false, error: "Subscription not found" });
      if (sub.payfast_token) {
        await pauseSubscription(sub.payfast_token, Number(req.body?.cycles || 0));
      }
      await updateRow(req, "subscriptions", sub.ROWID, { status: "paused", updated_at: nowUtcForCatalyst() });
      await logActivity(req, {
        actor_type: req.user.role,
        actor_email: req.user.email,
        action: "subscription.pause",
        entity_type: "subscription",
        entity_rowid: String(sub.ROWID),
        summary: `Paused subscription ${sub.ROWID}`,
      });
      return res.json({ ok: true, subscription: await findByRowId(req, "subscriptions", sub.ROWID) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/api/subscriptions/:id/unpause", requireAuth, requireStaff, async (req, res) => {
    try {
      const sub = await findByRowId(req, "subscriptions", req.params.id);
      if (!sub) return res.status(404).json({ ok: false, error: "Subscription not found" });
      if (sub.payfast_token) await unpauseSubscription(sub.payfast_token);
      await updateRow(req, "subscriptions", sub.ROWID, { status: "active", updated_at: nowUtcForCatalyst() });
      return res.json({ ok: true, subscription: await findByRowId(req, "subscriptions", sub.ROWID) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/api/subscriptions/:id/cancel", requireAuth, requireStaff, async (req, res) => {
    try {
      const sub = await findByRowId(req, "subscriptions", req.params.id);
      if (!sub) return res.status(404).json({ ok: false, error: "Subscription not found" });
      if (sub.payfast_token) await cancelSubscription(sub.payfast_token);
      await updateRow(req, "subscriptions", sub.ROWID, { status: "cancelled", updated_at: nowUtcForCatalyst() });
      await logActivity(req, {
        actor_type: req.user.role,
        actor_email: req.user.email,
        action: "subscription.cancel",
        entity_type: "subscription",
        entity_rowid: String(sub.ROWID),
        summary: `Cancelled subscription ${sub.ROWID}`,
      });
      return res.json({ ok: true, subscription: await findByRowId(req, "subscriptions", sub.ROWID) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/api/subscriptions/:id/upgrade", requireAuth, requireStaff, async (req, res) => {
    try {
      const sub = await findByRowId(req, "subscriptions", req.params.id);
      if (!sub) return res.status(404).json({ ok: false, error: "Subscription not found" });
      const plan_rowid = safeStr(req.body?.plan_rowid);
      const plan = plan_rowid ? await findByRowId(req, "plans", plan_rowid) : null;
      if (!plan) return res.status(400).json({ ok: false, error: "New plan required" });

      const amount_cents = Math.round(Number(plan.amount_cents));
      const frequency = Number(plan.frequency || 3);
      if (sub.payfast_token) {
        await updateSubscription(sub.payfast_token, {
          amount: amount_cents,
          frequency,
          cycles: Number(plan.cycles || 0),
        });
      }
      await updateRow(req, "subscriptions", sub.ROWID, {
        plan_rowid: plan.ROWID,
        amount_cents,
        frequency,
        cycles: Number(plan.cycles || 0),
        updated_at: nowUtcForCatalyst(),
      });
      await logActivity(req, {
        actor_type: req.user.role,
        actor_email: req.user.email,
        action: "subscription.upgrade",
        entity_type: "subscription",
        entity_rowid: String(sub.ROWID),
        summary: `Changed subscription plan to ${plan.name}`,
      });
      return res.json({ ok: true, subscription: await findByRowId(req, "subscriptions", sub.ROWID) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/api/subscriptions/:id/card-update-url", requireAuth, async (req, res) => {
    try {
      const sub = await findByRowId(req, "subscriptions", req.params.id);
      if (!sub?.payfast_token) return res.status(400).json({ ok: false, error: "No PayFast token yet" });
      const portalBase = safeStr(process.env.PORTAL_BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
      return res.json({ ok: true, url: cardUpdateUrl(sub.payfast_token, `${portalBase}/subscriptions/${sub.ROWID}`) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  return router;
}

module.exports = { createSubscriptionsRouter };
