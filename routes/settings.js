"use strict";

const express = require("express");
const { findMany, findOne, insertRow, updateRow, escapeZcql } = require("../catalyst/datastore");
const { requireAuth, requireStaff, safeStr } = require("../utils/authUtils");
const { isSmtpConfigured } = require("../services/email");
const { getConfig } = require("../services/payfast");

function createSettingsRouter() {
  const router = express.Router();

  async function upsertSetting(req, key, value) {
    const existing = await findOne(req, "settings", `key_name='${escapeZcql(key)}'`);
    const value_json = typeof value === "string" ? value : JSON.stringify(value);
    if (existing) {
      await updateRow(req, "settings", existing.ROWID, { value_json });
      return { ...existing, value_json };
    }
    return insertRow(req, "settings", { key_name: key, value_json });
  }

  router.get("/api/settings", requireAuth, requireStaff, async (req, res) => {
    try {
      const rows = await findMany(req, "settings", "1=1", "key_name ASC", 100, 0);
      const map = {};
      for (const r of rows) {
        try {
          map[r.key_name] = JSON.parse(r.value_json);
        } catch {
          map[r.key_name] = r.value_json;
        }
      }
      return res.json({ ok: true, settings: map });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.put("/api/settings", requireAuth, requireStaff, async (req, res) => {
    try {
      const body = req.body || {};
      if (body.company !== undefined) await upsertSetting(req, "company", body.company);
      if (body.vat_rate !== undefined) await upsertSetting(req, "vat_rate", Number(body.vat_rate));
      if (body.invoice_prefix !== undefined) await upsertSetting(req, "invoice_prefix", safeStr(body.invoice_prefix));
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/api/settings/integrations-health", requireAuth, requireStaff, async (req, res) => {
    try {
      const pf = getConfig();
      const services = [
        {
          key: "payfast",
          name: "PayFast",
          ready: !!(pf.merchantId && pf.merchantKey && pf.passphrase),
          detail: pf.sandbox ? "Sandbox mode" : "Live mode",
        },
        {
          key: "smtp",
          name: "Email (SMTP)",
          ready: isSmtpConfigured(),
          detail: isSmtpConfigured() ? safeStr(process.env.SMTP_HOST) : "Not configured",
        },
        {
          key: "datastore",
          name: "Catalyst Datastore",
          ready: true,
          detail: "AppSail connected",
        },
      ];
      return res.json({
        ok: true,
        readyCount: services.filter((s) => s.ready).length,
        total: services.length,
        services,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  return router;
}

module.exports = { createSettingsRouter };
