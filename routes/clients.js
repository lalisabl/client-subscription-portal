"use strict";

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const {
  findByRowId,
  findMany,
  findOne,
  countRows,
  insertRow,
  updateRow,
  escapeZcql,
  logActivity,
} = require("../catalyst/datastore");
const { requireAuth, requireStaff, safeStr } = require("../utils/authUtils");
const { nowUtcForCatalyst } = require("../utils/dateUtils");
const { sendClientCredentialsEmail } = require("../services/email");

function createClientsRouter() {
  const router = express.Router();

  router.use(requireAuth, requireStaff);

  router.get("/api/clients", async (req, res) => {
    try {
      const q = safeStr(req.query.q).toLowerCase();
      const status = safeStr(req.query.status);
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);

      let where = "1=1";
      if (status && status !== "all") where += ` AND status='${escapeZcql(status)}'`;
      if (q) {
        const like = escapeZcql(q);
        where += ` AND (name LIKE '%${like}%' OR contact_person LIKE '%${like}%' OR email LIKE '%${like}%')`;
      }

      const [rows, total] = await Promise.all([
        findMany(req, "clients", where, "CREATEDTIME DESC", limit, offset),
        countRows(req, "clients", where),
      ]);
      return res.json({ ok: true, rows, total, limit, offset });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/api/clients/:id", async (req, res) => {
    try {
      const row = await findByRowId(req, "clients", req.params.id);
      if (!row) return res.status(404).json({ ok: false, error: "Client not found" });
      const subscriptions = await findMany(
        req,
        "subscriptions",
        `client_rowid='${escapeZcql(req.params.id)}'`,
        "CREATEDTIME DESC",
        100,
        0
      );
      return res.json({ ok: true, client: row, subscriptions });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/api/clients", async (req, res) => {
    try {
      const body = req.body || {};
      const name = safeStr(body.name);
      const email = safeStr(body.email).toLowerCase();
      if (!name) return res.status(400).json({ ok: false, error: "Name is required" });

      const row = await insertRow(req, "clients", {
        name,
        contact_person: safeStr(body.contact_person),
        email,
        phone: safeStr(body.phone),
        vat_number: safeStr(body.vat_number),
        billing_address: safeStr(body.billing_address),
        status: safeStr(body.status) || "active",
        created_at: nowUtcForCatalyst(),
      });

      let credentials = null;
      if (body.create_login && email) {
        const existing = await findOne(req, "users", `email='${escapeZcql(email)}'`);
        if (!existing) {
          const password = safeStr(body.password) || crypto.randomBytes(6).toString("base64url");
          const password_hash = await bcrypt.hash(password, 10);
          await insertRow(req, "users", {
            email,
            name: safeStr(body.contact_person) || name,
            role: "client",
            password_hash,
            client_rowid: String(row.ROWID),
            status: "active",
            last_login: "",
            created_at: nowUtcForCatalyst(),
          });
          credentials = { email, password };
          const loginUrl = `${safeStr(process.env.PORTAL_BASE_URL || "http://localhost:5173").replace(/\/+$/, "")}/login`;
          await sendClientCredentialsEmail({
            to: email,
            name: safeStr(body.contact_person) || name,
            email,
            password,
            loginUrl,
          });
        }
      }

      await logActivity(req, {
        actor_type: req.user.role,
        actor_email: req.user.email,
        action: "client.create",
        entity_type: "client",
        entity_rowid: String(row.ROWID),
        summary: `Created client ${name}`,
      });

      return res.status(201).json({ ok: true, client: row, credentials });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.put("/api/clients/:id", async (req, res) => {
    try {
      const existing = await findByRowId(req, "clients", req.params.id);
      if (!existing) return res.status(404).json({ ok: false, error: "Client not found" });
      const body = req.body || {};
      const updates = {};
      ["name", "contact_person", "phone", "vat_number", "billing_address", "status"].forEach((k) => {
        if (body[k] !== undefined) updates[k] = safeStr(body[k]);
      });
      if (body.email !== undefined) updates.email = safeStr(body.email).toLowerCase();
      await updateRow(req, "clients", req.params.id, updates);
      const client = await findByRowId(req, "clients", req.params.id);
      await logActivity(req, {
        actor_type: req.user.role,
        actor_email: req.user.email,
        action: "client.update",
        entity_type: "client",
        entity_rowid: String(req.params.id),
        summary: `Updated client ${client?.name || req.params.id}`,
      });
      return res.json({ ok: true, client });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  return router;
}

module.exports = { createClientsRouter };
