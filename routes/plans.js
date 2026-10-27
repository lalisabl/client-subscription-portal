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
const { nowUtcForCatalyst } = require("../utils/dateUtils");

function createPlansRouter() {
  const router = express.Router();
  router.use("/api/plans", requireAuth, requireStaff);

  router.get("/api/plans", async (req, res) => {
    try {
      const productId = safeStr(req.query.product_rowid);
      const active = safeStr(req.query.active);
      let where = "1=1";
      if (productId) where += ` AND product_rowid='${escapeZcql(productId)}'`;
      if (active === "true") where += " AND active=true";
      if (active === "false") where += " AND active=false";
      const [rows, total] = await Promise.all([
        findMany(req, "plans", where, "CREATEDTIME DESC", Number(req.query.limit) || 100, Number(req.query.offset) || 0),
        countRows(req, "plans", where),
      ]);
      return res.json({ ok: true, rows, total });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/api/plans/:id", async (req, res) => {
    try {
      const plan = await findByRowId(req, "plans", req.params.id);
      if (!plan) return res.status(404).json({ ok: false, error: "Plan not found" });
      return res.json({ ok: true, plan });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/api/plans", async (req, res) => {
    try {
      const body = req.body || {};
      const name = safeStr(body.name);
      const product_rowid = safeStr(body.product_rowid);
      const amount_cents = Math.round(Number(body.amount_cents));
      const frequency = Number(body.frequency || 3);
      if (!name || !product_rowid) return res.status(400).json({ ok: false, error: "Name and product are required" });
      if (!Number.isFinite(amount_cents) || amount_cents < 500) {
        return res.status(400).json({ ok: false, error: "amount_cents must be at least 500 (R5.00)" });
      }
      if (![3, 4, 5, 6].includes(frequency)) {
        return res.status(400).json({ ok: false, error: "frequency must be 3,4,5 or 6 (monthly…annual)" });
      }

      const product = await findByRowId(req, "products", product_rowid);
      if (!product) return res.status(400).json({ ok: false, error: "Product not found" });

      const features =
        typeof body.features_json === "string" ? body.features_json : JSON.stringify(body.features || body.features_json || []);

      const row = await insertRow(req, "plans", {
        product_rowid,
        name,
        amount_cents,
        currency: safeStr(body.currency) || "ZAR",
        frequency,
        cycles: Number(body.cycles != null ? body.cycles : 0),
        vat_inclusive: body.vat_inclusive === true || body.vat_inclusive === "true",
        features_json: features,
        active: body.active === false ? false : true,
        created_at: nowUtcForCatalyst(),
      });

      await logActivity(req, {
        actor_type: req.user.role,
        actor_email: req.user.email,
        action: "plan.create",
        entity_type: "plan",
        entity_rowid: String(row.ROWID),
        summary: `Created plan ${name}`,
      });

      return res.status(201).json({ ok: true, plan: row });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.put("/api/plans/:id", async (req, res) => {
    try {
      const existing = await findByRowId(req, "plans", req.params.id);
      if (!existing) return res.status(404).json({ ok: false, error: "Plan not found" });
      const body = req.body || {};
      const updates = {};
      if (body.name !== undefined) updates.name = safeStr(body.name);
      if (body.amount_cents !== undefined) updates.amount_cents = Math.round(Number(body.amount_cents));
      if (body.frequency !== undefined) updates.frequency = Number(body.frequency);
      if (body.cycles !== undefined) updates.cycles = Number(body.cycles);
      if (body.vat_inclusive !== undefined) updates.vat_inclusive = !!body.vat_inclusive;
      if (body.active !== undefined) updates.active = !!body.active;
      if (body.features_json !== undefined || body.features !== undefined) {
        updates.features_json =
          typeof body.features_json === "string" ? body.features_json : JSON.stringify(body.features || body.features_json || []);
      }
      if (body.product_rowid !== undefined) updates.product_rowid = safeStr(body.product_rowid);
      await updateRow(req, "plans", req.params.id, updates);
      const plan = await findByRowId(req, "plans", req.params.id);
      return res.json({ ok: true, plan });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  return router;
}

module.exports = { createPlansRouter };
