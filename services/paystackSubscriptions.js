"use strict";

const { findByRowId, findOne, updateRow, escapeZcql } = require("../catalyst/datastore");
const { safeStr } = require("../utils/authUtils");
const { nowUtcForCatalyst, nextRunFromFrequency } = require("../utils/dateUtils");
const { centsFromStore } = require("../utils/money");
const {
  createPlan,
  updatePlan,
  disableSubscription,
  enableSubscription,
  fetchPlan,
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

function metaInvoiceRowId(data) {
  const meta = parseMetadata(data);
  return safeStr(meta.invoice_rowid);
}

/**
 * Must pass before creating a portal subscription — ensures Paystack plan exists and client can checkout.
 * (Paystack SUB_… is still created on first successful payment.)
 */
async function preparePaystackForNewSubscription(req, { client, plan }) {
  if (!client) throw new Error("Client not found");
  const email = safeStr(client.email);
  if (!email || !email.includes("@")) {
    throw new Error("Client must have an email before starting a Paystack subscription");
  }
  if (!plan) throw new Error("Plan not found");

  await ensurePaystackPlan(req, plan);
  const freshPlan = await findByRowId(req, "plans", plan.ROWID);
  const planCode = safeStr(freshPlan?.paystack_plan_code);
  if (!planCode) {
    throw new Error("Paystack plan code missing — save the plan again or check Data Store column paystack_plan_code");
  }

  let remote;
  try {
    remote = await fetchPlan(planCode);
  } catch (err) {
    throw new Error(`Paystack plan ${planCode} could not be loaded: ${err?.message || err}`);
  }
  if (!remote || !safeStr(remote.plan_code)) {
    throw new Error(`Paystack plan ${planCode} not found on Paystack`);
  }

  return { plan: freshPlan, planCode, remote };
}

/**
 * Create or update a Paystack plan for a Catalyst plan row. Requires `paystack_plan_code` on plans table.
 */
async function ensurePaystackPlan(req, plan) {
  if (!plan) throw new Error("Plan missing");
  const amount = centsFromStore(plan.amount_cents);
  if (!Number.isFinite(amount) || amount < 100) {
    throw new Error("Plan amount invalid for Paystack (use cents, e.g. R99 = 9900)");
  }

  const interval = frequencyToPaystackInterval(plan.frequency);
  const currency = safeStr(plan.currency) || "ZAR";
  const cycles = Number(plan.cycles || 0);
  const invoice_limit = cycles > 0 ? cycles : undefined;
  const name = safeStr(plan.name) || "Subscription plan";

  const existingCode = safeStr(plan.paystack_plan_code);
  let planCode = existingCode;

  if (existingCode) {
    try {
      await updatePlan(existingCode, {
        name,
        amount,
        interval,
        currency,
        invoice_limit,
        update_existing_subscriptions: false,
      });
    } catch (err) {
      console.error("paystack_plan_update_skipped", existingCode, err?.message || err);
    }
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

  if (planCode) {
    try {
      const remote = await fetchPlan(planCode);
      const remoteAmount = Math.round(Number(remote.amount));
      if (remoteAmount > 0 && remoteAmount !== amount) {
        console.warn("paystack_plan_amount_mismatch", {
          plan_code: planCode,
          portal_cents: amount,
          paystack_cents: remoteAmount,
        });
        try {
          await updatePlan(planCode, {
            name,
            amount,
            interval,
            currency,
            invoice_limit,
            update_existing_subscriptions: true,
          });
        } catch (fixErr) {
          console.error("paystack_plan_amount_fix_failed", fixErr?.message || fixErr);
        }
      }
    } catch (err) {
      console.error("paystack_plan_verify_failed", err);
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

async function ensurePaystackSubscriptionTokens(req, sub) {
  const code = safeStr(sub.paystack_subscription_code);
  let token = safeStr(sub.paystack_email_token);
  if (!code) return { code: "", token: "" };
  if (!token) {
    try {
      const remote = await fetchSubscription(code);
      token = safeStr(remote.email_token);
      if (token && req && sub.ROWID) {
        await updateRow(req, "subscriptions", sub.ROWID, { paystack_email_token: token });
      }
    } catch (err) {
      console.error("paystack_fetch_subscription_failed", code, err);
    }
  }
  return { code, token };
}

async function cancelPaystackSubscriptionRemote(req, sub) {
  const { code, token } = await ensurePaystackSubscriptionTokens(req, sub);
  if (!code) return { skipped: true, reason: "No Paystack subscription linked" };
  if (!token) {
    throw new Error("Paystack subscription token missing — wait for webhook or retry after first payment");
  }
  await disableSubscription({ code, token });
  return { skipped: false, code };
}

async function resumePaystackSubscriptionRemote(req, sub) {
  const { code, token } = await ensurePaystackSubscriptionTokens(req, sub);
  if (!code) return { skipped: true, reason: "No Paystack subscription linked" };
  if (!token) throw new Error("Paystack subscription token missing");
  await enableSubscription({ code, token });
  return { skipped: false, code };
}

/**
 * Fetch Paystack subscription; optionally re-run disable when portal is cancelled/paused but Paystack still renews.
 */
async function syncSubscriptionWithPaystack(req, sub, { retryDisable = true } = {}) {
  const code = safeStr(sub.paystack_subscription_code);
  if (!code) return { skipped: true, reason: "No Paystack subscription linked" };

  await ensurePaystackSubscriptionTokens(req, sub);
  const fresh = await findByRowId(req, "subscriptions", sub.ROWID);
  const token = safeStr(fresh?.paystack_email_token);
  let remote = await fetchSubscription(code);
  let remoteStatus = safeStr(remote.status).toLowerCase();
  const localStatus = safeStr(fresh.status).toLowerCase();

  let disabled = false;
  if (
    retryDisable &&
    token &&
    (localStatus === "cancelled" || localStatus === "paused") &&
    (remoteStatus === "active" || remoteStatus === "attention")
  ) {
    await disableSubscription({ code, token });
    disabled = true;
    remote = await fetchSubscription(code);
    remoteStatus = safeStr(remote.status).toLowerCase();
  }

  const updates = {
    updated_at: nowUtcForCatalyst(),
    next_run_date: isoToYmd(remote.next_payment_date) || fresh.next_run_date,
  };
  if (token) updates.paystack_email_token = token;

  if (localStatus === "cancelled") {
    updates.status = "cancelled";
  } else if (localStatus === "paused") {
    updates.status = remoteStatus === "non-renewing" || remoteStatus === "non_renewing" ? "paused" : fresh.status;
  } else {
    updates.status = mapPaystackSubStatus(remote.status);
  }

  await updateRow(req, "subscriptions", fresh.ROWID, updates);
  const updated = await findByRowId(req, "subscriptions", fresh.ROWID);

  return {
    skipped: false,
    disabled,
    paystack_status: remote.status,
    paystack_non_renewing: remoteStatus === "non-renewing" || remoteStatus === "non_renewing",
    subscription: updated,
    message:
      remoteStatus === "active" && localStatus === "cancelled" && !disabled
        ? "Paystack still active — retry disable or check API keys"
        : remoteStatus === "non-renewing" || remoteStatus === "non_renewing"
          ? "Paystack will not charge again; dashboard may still show Active until the period ends"
          : "",
  };
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
  metaInvoiceRowId,
  parseMetadata,
  preparePaystackForNewSubscription,
  ensurePaystackPlan,
  findSubscriptionForPaystackEvent,
  applyPaystackSubscriptionSnapshot,
  syncPaystackSubscriptionOnCreate,
  syncPaystackSubscriptionStatus,
  ensurePaystackSubscriptionTokens,
  cancelPaystackSubscriptionRemote,
  resumePaystackSubscriptionRemote,
  syncSubscriptionWithPaystack,
  nextRunFallback,
};
