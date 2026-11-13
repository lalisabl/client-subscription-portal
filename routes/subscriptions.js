"use strict";

const express = require("express");
const {
  findByRowId,
  findMany,
  countRows,
  insertRow,
  updateRow,
  deleteRow,
  escapeZcql,
  logActivity,
} = require("../catalyst/datastore");
const { requireAuth, requireStaff, safeStr } = require("../utils/authUtils");
const { nowUtcForCatalyst, todayYmdSa, nextRunFromFrequency } = require("../utils/dateUtils");
const {
  checkoutForSubscription,
  preparePaystackCheckout,
  shouldUsePaystackSubscriptionCheckout,
} = require("../services/checkout");
const { createInvoiceForSubscription } = require("../services/invoices");
const { parseListPagination, listMeta } = require("../utils/pagination");
const {
  ensurePaystackPlan,
  preparePaystackForNewSubscription,
  cancelPaystackSubscriptionRemote,
  resumePaystackSubscriptionRemote,
  syncSubscriptionWithPaystack,
  resolveAndPersistPaystackSubscriptionLink,
} = require("../services/paystackSubscriptions");

function createSubscriptionsRouter() {
  const router = express.Router();

  router.get("/api/subscriptions", requireAuth, requireStaff, async (req, res) => {
    try {
      const status = safeStr(req.query.status);
      const clientId = safeStr(req.query.client_rowid);
      const q = safeStr(req.query.q);
      const { limit, offset } = parseListPagination(req);
      let where = "1=1";
      if (status && status !== "all") where += ` AND status='${escapeZcql(status)}'`;
      if (clientId) where += ` AND client_rowid='${escapeZcql(clientId)}'`;
      if (q) {
        const like = escapeZcql(q);
        const [clientHits, planHits] = await Promise.all([
          findMany(req, "clients", `name LIKE '%${like}%'`, "CREATEDTIME DESC", 300, 0),
          findMany(req, "plans", `name LIKE '%${like}%'`, "CREATEDTIME DESC", 300, 0),
        ]);
        const orParts = [
          ...clientHits.map((c) => `client_rowid='${escapeZcql(c.ROWID)}'`),
          ...planHits.map((p) => `plan_rowid='${escapeZcql(p.ROWID)}'`),
        ];
        if (orParts.length === 0) {
          return res.json({ ok: true, rows: [], ...listMeta(limit, offset, 0) });
        }
        where += ` AND (${orParts.join(" OR ")})`;
      }
      const [rows, total] = await Promise.all([
        findMany(req, "subscriptions", where, "CREATEDTIME DESC", limit, offset),
        countRows(req, "subscriptions", where),
      ]);

      const enriched = [];
      for (const sub of rows) {
        const client = await findByRowId(req, "clients", sub.client_rowid);
        const plan = await findByRowId(req, "plans", sub.plan_rowid);
        enriched.push({ ...sub, client, plan });
      }
      return res.json({ ok: true, rows: enriched, ...listMeta(limit, offset, total) });
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
      let plan = await findByRowId(req, "plans", plan_rowid);
      if (!client) return res.status(400).json({ ok: false, error: "Client not found" });
      if (!plan) return res.status(400).json({ ok: false, error: "Plan not found" });

      try {
        const ready = await preparePaystackForNewSubscription(req, { client, plan });
        plan = ready.plan;
      } catch (psErr) {
        return res.status(502).json({
          ok: false,
          error: `Cannot create subscription: ${String(psErr?.message || psErr)}`,
        });
      }

      const start_date = safeStr(req.body?.start_date) || todayYmdSa();
      const amount_cents = Math.round(Number(req.body?.amount_cents != null ? req.body.amount_cents : plan.amount_cents));
      const frequency = Number(req.body?.frequency != null ? req.body.frequency : plan.frequency || 3);
      const cycles = Number(req.body?.cycles != null ? req.body.cycles : plan.cycles || 0);

      const sub = await insertRow(req, "subscriptions", {
        client_rowid,
        plan_rowid,
        status: "pending",
        paystack_authorization_code: "",
        amount_cents,
        frequency,
        cycles,
        start_date,
        next_run_date: start_date,
        created_by: safeStr(req.user.email),
        created_at: nowUtcForCatalyst(),
        updated_at: nowUtcForCatalyst(),
      });

      let invoice;
      try {
        invoice = await createInvoiceForSubscription(req, {
          subscription: { ...sub, ROWID: sub.ROWID },
          client,
          plan,
          status: "sent",
        });
      } catch (invErr) {
        await deleteRow(req, "subscriptions", sub.ROWID).catch(() => {});
        return res.status(500).json({
          ok: false,
          error: `Subscription not created: invoice failed (${invErr?.message || invErr})`,
        });
      }

      let paystack_checkout;
      try {
        paystack_checkout = await preparePaystackCheckout(req, {
          client,
          plan,
          sub: { ...sub, ROWID: sub.ROWID },
          usePaystackSubscription: shouldUsePaystackSubscriptionCheckout(sub),
        });
      } catch (checkoutErr) {
        await deleteRow(req, "subscriptions", sub.ROWID).catch(() => {});
        if (invoice?.ROWID) {
          await deleteRow(req, "invoices", invoice.ROWID).catch(() => {});
        }
        return res.status(502).json({
          ok: false,
          error: `Subscription not created: ${String(checkoutErr?.message || checkoutErr)}`,
        });
      }

      await logActivity(req, {
        actor_type: req.user.role,
        actor_email: req.user.email,
        action: "subscription.create",
        entity_type: "subscription",
        entity_rowid: String(sub.ROWID),
        summary: `Created subscription for ${client.name} / ${plan.name}`,
      });

      return res.status(201).json({
        ok: true,
        subscription: sub,
        invoice,
        paystack_plan_code: plan.paystack_plan_code,
        paystack_checkout,
        message:
          "Subscription created. Customer must complete Pay with Paystack once; Paystack will then create the recurring subscription (SUB_…).",
      });
    } catch (err) {
      console.error("subscription_create_error", err);
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  /** Initialize Paystack checkout for this subscription */
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

      const checkout = await checkoutForSubscription(req, sub);
      if (
        !checkout.paystack_subscription_checkout &&
        !safeStr(sub.paystack_subscription_code) &&
        safeStr(sub.status).toLowerCase() !== "cancelled"
      ) {
        return res.status(502).json({
          ok: false,
          error:
            "Paystack recurring checkout could not be prepared (missing plan code?). Edit the plan, save to sync Paystack, then try again.",
          checkout,
        });
      }
      return res.json({ ok: true, ...checkout });
    } catch (err) {
      console.error("checkout_error", err);
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/api/subscriptions/:id/pause", requireAuth, requireStaff, async (req, res) => {
    try {
      const sub = await findByRowId(req, "subscriptions", req.params.id);
      if (!sub) return res.status(404).json({ ok: false, error: "Subscription not found" });
      let paystack = { skipped: true };
      try {
        paystack = await cancelPaystackSubscriptionRemote(req, sub);
      } catch (psErr) {
        console.error("paystack_pause_failed", psErr);
        return res.status(502).json({ ok: false, error: String(psErr?.message || psErr) });
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
      return res.json({
        ok: true,
        subscription: await findByRowId(req, "subscriptions", sub.ROWID),
        paystack,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/api/subscriptions/:id/unpause", requireAuth, requireStaff, async (req, res) => {
    try {
      const sub = await findByRowId(req, "subscriptions", req.params.id);
      if (!sub) return res.status(404).json({ ok: false, error: "Subscription not found" });
      let paystack = { skipped: true };
      try {
        paystack = await resumePaystackSubscriptionRemote(req, sub);
      } catch (psErr) {
        console.error("paystack_unpause_failed", psErr);
        return res.status(502).json({ ok: false, error: String(psErr?.message || psErr) });
      }
      await updateRow(req, "subscriptions", sub.ROWID, { status: "active", updated_at: nowUtcForCatalyst() });
      return res.json({
        ok: true,
        subscription: await findByRowId(req, "subscriptions", sub.ROWID),
        paystack,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/api/subscriptions/:id/cancel", requireAuth, requireStaff, async (req, res) => {
    try {
      let sub = await findByRowId(req, "subscriptions", req.params.id);
      if (!sub) return res.status(404).json({ ok: false, error: "Subscription not found" });
      sub = await resolveAndPersistPaystackSubscriptionLink(req, sub);
      let paystack = { skipped: true };
      try {
        paystack = await cancelPaystackSubscriptionRemote(req, sub);
      } catch (psErr) {
        console.error("paystack_cancel_failed", psErr);
        return res.status(502).json({
          ok: false,
          error: String(psErr?.message || psErr),
          subscription: await findByRowId(req, "subscriptions", sub.ROWID),
        });
      }
      if (paystack.skipped && safeStr(sub.paystack_subscription_code)) {
        return res.status(502).json({
          ok: false,
          error:
            "Paystack subscription linked in portal but disable was skipped (missing email token). Try Sync Paystack or cancel in Paystack dashboard.",
          paystack,
        });
      }
      if (paystack.skipped) {
        return res.status(502).json({
          ok: false,
          error:
            "No Paystack subscription found for this client/plan — payment may be one-off only, or link failed. Cancel in Paystack manually if needed.",
          paystack,
        });
      }
      await updateRow(req, "subscriptions", sub.ROWID, { status: "cancelled", updated_at: nowUtcForCatalyst() });
      await logActivity(req, {
        actor_type: req.user.role,
        actor_email: req.user.email,
        action: "subscription.cancel",
        entity_type: "subscription",
        entity_rowid: String(sub.ROWID),
        summary: `Cancelled subscription ${sub.ROWID}`,
      });
      const updated = await findByRowId(req, "subscriptions", sub.ROWID);
      let sync = null;
      try {
        sync = await syncSubscriptionWithPaystack(req, updated, { retryDisable: false });
      } catch (syncErr) {
        console.error("paystack_sync_after_cancel", syncErr);
      }
      return res.json({ ok: true, subscription: updated, paystack, sync });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  /** Staff: align portal with Paystack (re-disable if portal cancelled but Paystack still active). */
  router.post("/api/subscriptions/:id/paystack-sync", requireAuth, requireStaff, async (req, res) => {
    try {
      const sub = await findByRowId(req, "subscriptions", req.params.id);
      if (!sub) return res.status(404).json({ ok: false, error: "Subscription not found" });
      const result = await syncSubscriptionWithPaystack(req, sub, { retryDisable: true });
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(502).json({ ok: false, error: String(err?.message || err) });
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

  return router;
}

module.exports = { createSubscriptionsRouter };
