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
const { parseListPagination, listMeta } = require("../utils/pagination");

function createClientsRouter() {
  const router = express.Router();

  router.use("/api/clients", requireAuth, requireStaff);

  router.get("/api/clients", async (req, res) => {
    try {
      const q = safeStr(req.query.q).toLowerCase();
      const status = safeStr(req.query.status);
      const { limit, offset } = parseListPagination(req);

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
      return res.json({ ok: true, rows, ...listMeta(limit, offset, total) });
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
      let portalUser = null;
      const email = safeStr(row.email).toLowerCase();
      if (email) {
        portalUser = await findOne(req, "users", `email='${escapeZcql(email)}' AND role='client'`);
      }
      if (!portalUser) {
        portalUser = await findOne(req, "users", `client_rowid='${escapeZcql(req.params.id)}'`);
      }
      return res.json({
        ok: true,
        client: row,
        subscriptions,
        hasPortalLogin: !!portalUser,
        portalEmail: portalUser?.email || null,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/api/clients", async (req, res) => {
    try {
      const body = req.body || {};
      const name = safeStr(body.name);
      const email = safeStr(body.email).toLowerCase();
      const wantLogin = body.create_login === true || body.create_login === "true" || body.create_login === 1;
      if (!name) return res.status(400).json({ ok: false, error: "Name is required" });
      if (wantLogin && !email) {
        return res.status(400).json({ ok: false, error: "Email is required to create a portal login" });
      }

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
      let loginStatus = "skipped";

      if (wantLogin) {
        const existing = await findOne(req, "users", `email='${escapeZcql(email)}'`);
        if (existing) {
          loginStatus = "exists";
        } else {
          const password = safeStr(body.password) || crypto.randomBytes(6).toString("base64url");
          const password_hash = await bcrypt.hash(password, 10);
          await insertRow(req, "users", {
            email,
            name: safeStr(body.contact_person) || name,
            role: "client",
            password_hash,
            client_rowid: String(row.ROWID),
            status: "active",
            created_at: nowUtcForCatalyst(),
          });
          credentials = { email, password };
          const loginUrl = `${safeStr(process.env.PORTAL_BASE_URL || "http://localhost:5173").replace(/\/+$/, "")}/login`;
          let mail = null;
          try {
            mail = await sendClientCredentialsEmail({
              to: email,
              name: safeStr(body.contact_person) || name,
              email,
              password,
              loginUrl,
            });
          } catch (mailErr) {
            console.error("client_credentials_email_failed", String(mailErr?.message || mailErr));
            mail = { ok: false, skipped: false, failed: true, error: String(mailErr?.message || mailErr) };
          }
          loginStatus = mail?.skipped
            ? "created_email_skipped"
            : mail?.failed
              ? "created_email_failed"
              : "created_emailed";
          if (credentials) {
            credentials.emailSkipped = !!mail?.skipped;
            credentials.emailFailed = !!mail?.failed;
            if (mail?.error) credentials.emailError = mail.error;
          }
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

      return res.status(201).json({ ok: true, client: row, credentials, loginStatus });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  /** Create portal login for an existing client (if missing). */
  router.post("/api/clients/:id/portal-login", async (req, res) => {
    try {
      const client = await findByRowId(req, "clients", req.params.id);
      if (!client) return res.status(404).json({ ok: false, error: "Client not found" });
      const email = safeStr(req.body?.email || client.email).toLowerCase();
      if (!email) return res.status(400).json({ ok: false, error: "Client has no email" });

      const existing = await findOne(req, "users", `email='${escapeZcql(email)}'`);
      if (existing) {
        return res.status(409).json({ ok: false, error: "A portal user already exists for this email" });
      }

      const password = safeStr(req.body?.password) || crypto.randomBytes(6).toString("base64url");
      const password_hash = await bcrypt.hash(password, 10);
      await insertRow(req, "users", {
        email,
        name: safeStr(client.contact_person) || safeStr(client.name),
        role: "client",
        password_hash,
        client_rowid: String(client.ROWID),
        status: "active",
        created_at: nowUtcForCatalyst(),
      });

      if (!client.email) {
        await updateRow(req, "clients", client.ROWID, { email });
      }

      const loginUrl = `${safeStr(process.env.PORTAL_BASE_URL || "http://localhost:5173").replace(/\/+$/, "")}/login`;
      let mail = null;
      try {
        mail = await sendClientCredentialsEmail({
          to: email,
          name: safeStr(client.contact_person) || safeStr(client.name),
          email,
          password,
          loginUrl,
        });
      } catch (mailErr) {
        console.error("portal_login_email_failed", String(mailErr?.message || mailErr));
        mail = { ok: false, skipped: false, failed: true, error: String(mailErr?.message || mailErr) };
      }

      await logActivity(req, {
        actor_type: req.user.role,
        actor_email: req.user.email,
        action: "client.portal_login",
        entity_type: "client",
        entity_rowid: String(client.ROWID),
        summary: `Created portal login for ${email}`,
      });

      return res.status(201).json({
        ok: true,
        credentials: {
          email,
          password,
          emailSkipped: !!mail?.skipped,
          emailFailed: !!mail?.failed,
          emailError: mail?.error || undefined,
        },
        loginStatus: mail?.skipped
          ? "created_email_skipped"
          : mail?.failed
            ? "created_email_failed"
            : "created_emailed",
      });
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
