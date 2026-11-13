"use strict";

const { findByRowId, findOne, updateRow, escapeZcql } = require("../catalyst/datastore");
const { safeStr } = require("../utils/authUtils");
const { nowUtcForCatalyst, nextRunFromFrequency } = require("../utils/dateUtils");
const {
  createPlan,
  updatePlan,
  disableSubscription,
  enableSubscription,
} = require("./paystack");

function frequencyToPaystackInterval(frequency) {
  const f = Number(frequency);
  if (f === 4) return "quarterly";
  if (f === 5) return "biannually";
  if (f === 6) return "annually";
  return "monthly";
}

function paystackIntervalToFrequency(interval) {
  const s = safeStr(interval).toLowerCase();
  if (s === "quarterly") return 4;
  if (s === "biannually") return 5;
  if (s === "annually" || s === "annual") return 6;
  return 3;
}

function isoToYmd(iso) {
  const s = safeStr(iso);
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

function mapPaystackSubStatus(psStatus) {
  const s = safeStr(psStatus).toLowerCase();
  if (s === "active") return "active";
  if (s === "non-renewing" || s === "non_renewing") return "paused";
  if (s === "attention") return "failed";
  if (s === "completed" || s === "cancelled" || s === "canceled") return "cancelled";
  return "pending";
}

function parseMetadata(data) {
  const raw = data?.metadata;
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

function metaSubscriptionRowId(data) {
  const meta = parseMetadata(data);
  return safeStr(
    meta.subscription_rowid ||
      meta.catalyst_subscription_rowid ||
      meta.custom_fields?.find?.((f) => f.variable_name === "subscription_rowid")?.value
  );
}

/**
 * Create or update a Paystack plan for a Catalyst plan row. Requires `paystack_plan_code` on plans table.
 */
async function ensurePaystackPlan(req, plan) {
  if (!plan) throw new Error("Plan missing");
  const amount = Math.round(Number(plan.amount_cents));
  if (!Number.isFinite(amount) || amount < 100) throw new Error("Plan amount invalid for Paystack");

  const interval = frequencyToPaystackInterval(plan.frequency);
  const currency = safeStr(plan.currency) || "ZAR";
  const cycles = Number(plan.cycles || 0);
  const invoice_limit = cycles > 0 ? cycles : undefined;
  const name = safeStr(plan.name) || "Subscription plan";

  const existingCode = safeStr(plan.paystack_plan_code);
  let planCode = existingCode;

  if (existingCode) {
    await updatePlan(existingCode, {
      name,
      amount,
      interval,
      currency,
      invoice_limit,
      update_existing_subscriptions: false,
    });
  } else {
    const created = await createPlan({
      name,
      amount,
      interval,
      currency,
      invoice_limit,
      send_invoices: false,
      send_sms: false,
    });
    planCode = safeStr(created.plan_code);
    if (!planCode) throw new Error("Paystack plan_code missing from response");
    try {
      await updateRow(req, "plans", plan.ROWID, { paystack_plan_code: planCode });
    } catch (err) {
      console.error("plan_paystack_code_save_failed", err);
    }
  }

  return planCode;
}

async function findSubscriptionForPaystackEvent(req, data) {
  const metaId = metaSubscriptionRowId(data);
  if (metaId) {
    const sub = await findByRowId(req, "subscriptions", metaId);
    if (sub) return sub;
  }

  const code = safeStr(data.subscription_code || data.subscription?.subscription_code);
  if (code) {
    const sub = await findOne(req, "subscriptions", `paystack_subscription_code='${escapeZcql(code)}'`);
    if (sub) return sub;
  }

  const planCode = safeStr(data.plan?.plan_code || data.plan_code);
  const email = safeStr(data.customer?.email || data.email);
  if (planCode && email) {
    const plan = await findOne(req, "plans", `paystack_plan_code='${escapeZcql(planCode)}'`);
    if (plan) {
      const clients = await findOne(req, "clients", `email='${escapeZcql(email)}'`);
      if (clients) {
        const sub = await findOne(
          req,
          "subscriptions",
          `client_rowid='${escapeZcql(clients.ROWID)}' AND plan_rowid='${escapeZcql(plan.ROWID)}'`,
        );
        if (sub) return sub;
      }
    }
  }

  return null;
}

async function applyPaystackSubscriptionSnapshot(req, sub, data) {
  if (!sub) return null;
  const code = safeStr(data.subscription_code || data.subscription?.subscription_code);
  const emailToken = safeStr(data.email_token || data.subscription?.email_token);
  const authCode = safeStr(data.authorization?.authorization_code || data.authorization_code);
  const nextPay = isoToYmd(data.next_payment_date || data.subscription?.next_payment_date);
  const psStatus = safeStr(data.status || data.subscription?.status);

  const updates = {
    updated_at: nowUtcForCatalyst(),
  };
  if (code) updates.paystack_subscription_code = code;
  if (emailToken) updates.paystack_email_token = emailToken;
  if (authCode) updates.paystack_authorization_code = authCode;
  if (nextPay) updates.next_run_date = nextPay;
  if (psStatus) updates.status = mapPaystackSubStatus(psStatus);

  await updateRow(req, "subscriptions", sub.ROWID, updates);
  return findByRowId(req, "subscriptions", sub.ROWID);
}

async function syncPaystackSubscriptionOnCreate(req, data) {
  const sub = await findSubscriptionForPaystackEvent(req, data);
  if (!sub) {
    console.warn("paystack_subscription_create_unlinked", data?.subscription_code || data?.email);
    return null;
  }
  return applyPaystackSubscriptionSnapshot(req, sub, data);
}

async function syncPaystackSubscriptionStatus(req, data, localStatus) {
  const sub = await findSubscriptionForPaystackEvent(req, data);
  if (!sub) return null;

  const updates = {
    status: localStatus,
    updated_at: nowUtcForCatalyst(),
  };
  const nextPay = isoToYmd(data.next_payment_date || data.subscription?.next_payment_date);
  if (nextPay) updates.next_run_date = nextPay;

  await updateRow(req, "subscriptions", sub.ROWID, updates);
  return findByRowId(req, "subscriptions", sub.ROWID);
}

async function cancelPaystackSubscriptionRemote(sub) {
  const code = safeStr(sub.paystack_subscription_code);
  const token = safeStr(sub.paystack_email_token);
  if (!code || !token) return { skipped: true, reason: "No Paystack subscription linked" };
  await disableSubscription({ code, token });
  return { skipped: false };
}

async function resumePaystackSubscriptionRemote(sub) {
  const code = safeStr(sub.paystack_subscription_code);
  const token = safeStr(sub.paystack_email_token);
  if (!code || !token) return { skipped: true, reason: "No Paystack subscription linked" };
  await enableSubscription({ code, token });
  return { skipped: false };
}

/** After a successful charge, advance dates when not fully driven by Paystack webhooks yet. */
function nextRunFallback(sub, data) {
  const fromPs = isoToYmd(data.next_payment_date || data.subscription?.next_payment_date);
  if (fromPs) return fromPs;
  return nextRunFromFrequency(sub.frequency, sub.next_run_date || sub.start_date);
}

module.exports = {
  frequencyToPaystackInterval,
  paystackIntervalToFrequency,
  isoToYmd,
  mapPaystackSubStatus,
  metaSubscriptionRowId,
  parseMetadata,
  ensurePaystackPlan,
  findSubscriptionForPaystackEvent,
  applyPaystackSubscriptionSnapshot,
  syncPaystackSubscriptionOnCreate,
  syncPaystackSubscriptionStatus,
  cancelPaystackSubscriptionRemote,
  resumePaystackSubscriptionRemote,
  nextRunFallback,
};
