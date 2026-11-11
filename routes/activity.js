"use strict";

const express = require("express");
const { findMany, countRows, escapeZcql } = require("../catalyst/datastore");
const { requireAuth, requireStaff, safeStr } = require("../utils/authUtils");
const { parseListPagination, listMeta } = require("../utils/pagination");

function createActivityRouter() {
  const router = express.Router();

  router.get("/api/activity", requireAuth, requireStaff, async (req, res) => {
    try {
      const q = safeStr(req.query.q);
      const entity = safeStr(req.query.entity_type);
      let where = "1=1";
      if (entity) where += ` AND entity_type='${escapeZcql(entity)}'`;
      if (q) where += ` AND (summary LIKE '%${escapeZcql(q)}%' OR actor_email LIKE '%${escapeZcql(q)}%' OR action LIKE '%${escapeZcql(q)}%')`;
      const { limit, offset } = parseListPagination(req);
      const [rows, total] = await Promise.all([
        findMany(req, "activity_log", where, "CREATEDTIME DESC", limit, offset),
        countRows(req, "activity_log", where),
      ]);
      return res.json({ ok: true, rows, ...listMeta(limit, offset, total) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  return router;
}

module.exports = { createActivityRouter };
