"use strict";

const express = require("express");
const { findMany, countRows, escapeZcql } = require("../catalyst/datastore");
const { requireAuth, requireStaff, safeStr } = require("../utils/authUtils");

function createActivityRouter() {
  const router = express.Router();

  router.get("/api/activity", requireAuth, requireStaff, async (req, res) => {
    try {
      const q = safeStr(req.query.q);
      const entity = safeStr(req.query.entity_type);
      let where = "1=1";
      if (entity) where += ` AND entity_type='${escapeZcql(entity)}'`;
      if (q) where += ` AND (summary LIKE '%${escapeZcql(q)}%' OR actor_email LIKE '%${escapeZcql(q)}%' OR action LIKE '%${escapeZcql(q)}%')`;
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const [rows, total] = await Promise.all([
        findMany(req, "activity_log", where, "CREATEDTIME DESC", limit, offset),
        countRows(req, "activity_log", where),
      ]);
      return res.json({ ok: true, rows, total });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  return router;
}

module.exports = { createActivityRouter };
