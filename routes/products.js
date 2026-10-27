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

function createProductsRouter() {
  const router = express.Router();
  router.use(requireAuth, requireStaff);

  router.get("/api/products", async (req, res) => {
    try {
      const q = safeStr(req.query.q).toLowerCase();
      const active = safeStr(req.query.active);
      let where = "1=1";
      if (active === "true") where += " AND active=true";
      if (active === "false") where += " AND active=false";
      if (q) where += ` AND (name LIKE '%${escapeZcql(q)}%' OR description LIKE '%${escapeZcql(q)}%')`;
      const limit = Math.min(Number(req.query.limit) || 100, 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const [rows, total] = await Promise.all([
        findMany(req, "products", where, "CREATEDTIME DESC", limit, offset),
        countRows(req, "products", where),
      ]);
      return res.json({ ok: true, rows, total });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/api/products/:id", async (req, res) => {
    try {
      const product = await findByRowId(req, "products", req.params.id);
      if (!product) return res.status(404).json({ ok: false, error: "Product not found" });
      const plans = await findMany(
        req,
        "plans",
        `product_rowid='${escapeZcql(req.params.id)}'`,
        "CREATEDTIME DESC",
        100,
        0
      );
      return res.json({ ok: true, product, plans });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/api/products", async (req, res) => {
    try {
      const name = safeStr(req.body?.name);
      if (!name) return res.status(400).json({ ok: false, error: "Name is required" });
      const row = await insertRow(req, "products", {
        name,
        description: safeStr(req.body?.description),
        active: req.body?.active === false ? false : true,
        created_at: nowUtcForCatalyst(),
      });
      await logActivity(req, {
        actor_type: req.user.role,
        actor_email: req.user.email,
        action: "product.create",
        entity_type: "product",
        entity_rowid: String(row.ROWID),
        summary: `Created product ${name}`,
      });
      return res.status(201).json({ ok: true, product: row });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.put("/api/products/:id", async (req, res) => {
    try {
      const existing = await findByRowId(req, "products", req.params.id);
      if (!existing) return res.status(404).json({ ok: false, error: "Product not found" });
      const updates = {};
      if (req.body?.name !== undefined) updates.name = safeStr(req.body.name);
      if (req.body?.description !== undefined) updates.description = safeStr(req.body.description);
      if (req.body?.active !== undefined) updates.active = !!req.body.active;
      await updateRow(req, "products", req.params.id, updates);
      const product = await findByRowId(req, "products", req.params.id);
      return res.json({ ok: true, product });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  return router;
}

module.exports = { createProductsRouter };
