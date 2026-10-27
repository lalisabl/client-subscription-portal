"use strict";

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { findOne, insertRow, updateRow, escapeZcql, logActivity } = require("../catalyst/datastore");
const { signToken, requireAuth, safeStr } = require("../utils/authUtils");
const { nowUtcForCatalyst } = require("../utils/dateUtils");
const { sendPasswordResetEmail } = require("../services/email");

function createAuthRouter() {
  const router = express.Router();
  const TOKEN_TTL_MINUTES = Math.max(5, Number(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES || 30));

  function getResetSecret() {
    const s = safeStr(
      process.env.PASSWORD_RESET_TOKEN_SECRET || process.env.JWT_SECRET || process.env.INTERNAL_API_SECRET
    );
    if (!s || s.length < 32) throw new Error("Missing or weak PASSWORD_RESET_TOKEN_SECRET (min 32 chars)");
    return s;
  }

  function base64UrlEncode(buf) {
    return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  }

  function base64UrlDecodeToString(s) {
    const str = safeStr(s);
    const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
    return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
  }

  function signResetToken(email) {
    const now = Math.floor(Date.now() / 1000);
    const payload = { sub: safeStr(email).toLowerCase(), iat: now, exp: now + TOKEN_TTL_MINUTES * 60, typ: "pwdreset" };
    const payloadB64 = base64UrlEncode(JSON.stringify(payload));
    const sig = crypto.createHmac("sha256", getResetSecret()).update(payloadB64).digest();
    return `${payloadB64}.${base64UrlEncode(sig)}`;
  }

  function verifyResetToken(token) {
    try {
      const parts = safeStr(token).split(".");
      if (parts.length !== 2) return { ok: false, error: "Invalid token format" };
      const [payloadB64, sigB64] = parts;
      const expected = crypto.createHmac("sha256", getResetSecret()).update(payloadB64).digest();
      const a = Buffer.from(sigB64);
      const b = Buffer.from(base64UrlEncode(expected));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: "Invalid token signature" };
      const payload = JSON.parse(base64UrlDecodeToString(payloadB64));
      if (!payload?.sub || !payload?.exp || payload.typ !== "pwdreset") return { ok: false, error: "Invalid token" };
      if (Math.floor(Date.now() / 1000) >= Number(payload.exp)) return { ok: false, error: "Token expired" };
      return { ok: true, email: String(payload.sub) };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  function publicUser(row) {
    return {
      id: row.ROWID,
      email: row.email,
      name: row.name,
      role: row.role,
      client_rowid: row.client_rowid || "",
      status: row.status || "active",
    };
  }

  router.post("/api/auth/login", async (req, res) => {
    try {
      const email = safeStr(req.body?.email || req.body?.username).toLowerCase();
      const password = safeStr(req.body?.password);
      const remember = !!req.body?.remember;
      if (!email || !password) return res.status(400).json({ ok: false, error: "Email and password are required" });

      const user = await findOne(req, "users", `email='${escapeZcql(email)}'`);
      if (!user) return res.status(401).json({ ok: false, error: "Incorrect email or password" });
      if (safeStr(user.status).toLowerCase() === "disabled") {
        return res.status(403).json({ ok: false, error: "Account is disabled" });
      }

      const hash = safeStr(user.password_hash);
      const match = hash ? await bcrypt.compare(password, hash) : false;
      if (!match) return res.status(401).json({ ok: false, error: "Incorrect email or password" });

      try {
        await updateRow(req, "users", user.ROWID, { last_login: nowUtcForCatalyst() });
      } catch {
        // ignore
      }

      const token = signToken(
        {
          id: user.ROWID,
          email: user.email,
          name: user.name,
          role: user.role,
          client_rowid: user.client_rowid || "",
        },
        remember
      );

      await logActivity(req, {
        actor_type: user.role,
        actor_email: user.email,
        action: "login",
        entity_type: "user",
        entity_rowid: String(user.ROWID),
        summary: `${user.name || user.email} signed in`,
      });

      return res.status(200).json({ ok: true, token, user: publicUser(user) });
    } catch (err) {
      console.error("login_error", err);
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/api/auth/me", requireAuth, async (req, res) => {
    try {
      const user = await findOne(req, "users", `ROWID='${escapeZcql(req.user.id)}'`);
      if (!user) return res.status(401).json({ ok: false, error: "User not found" });
      return res.status(200).json({ ok: true, user: publicUser(user) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/api/auth/forgot-password", async (req, res) => {
    try {
      const email = safeStr(req.body?.email).toLowerCase();
      if (!email || !email.includes("@")) {
        return res.status(400).json({ ok: false, error: "Please provide a valid email address." });
      }
      const user = await findOne(req, "users", `email='${escapeZcql(email)}'`);
      // always return success to avoid account enumeration
      if (user) {
        const token = signResetToken(email);
        const base = safeStr(process.env.PORTAL_BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
        const resetUrl = `${base}/reset-password?token=${encodeURIComponent(token)}`;
        await sendPasswordResetEmail({ to: email, resetUrl, ttlMinutes: TOKEN_TTL_MINUTES });
      }
      return res.status(200).json({
        ok: true,
        message: `If ${email} is a registered account, a password reset link has been sent.`,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/api/auth/reset-password", async (req, res) => {
    try {
      const token = safeStr(req.body?.token);
      const newPassword = safeStr(req.body?.newPassword || req.body?.password);
      if (!token) return res.status(400).json({ ok: false, error: "Missing token" });
      if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ ok: false, error: "Password must be at least 8 characters." });
      }
      const check = verifyResetToken(token);
      if (!check.ok) return res.status(400).json({ ok: false, error: check.error });

      const user = await findOne(req, "users", `email='${escapeZcql(check.email)}'`);
      if (!user) return res.status(404).json({ ok: false, error: "User not found" });

      const password_hash = await bcrypt.hash(newPassword, 10);
      await updateRow(req, "users", user.ROWID, { password_hash });
      return res.status(200).json({ ok: true, message: "Password updated. You can sign in now." });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  /** Staff: create a user (admin/staff/client) */
  router.post("/api/auth/users", requireAuth, async (req, res) => {
    try {
      const role = safeStr(req.user.role).toLowerCase();
      if (role !== "admin" && role !== "staff") {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }
      const email = safeStr(req.body?.email).toLowerCase();
      const name = safeStr(req.body?.name);
      const userRole = safeStr(req.body?.role || "client").toLowerCase();
      const client_rowid = safeStr(req.body?.client_rowid);
      const password = safeStr(req.body?.password) || crypto.randomBytes(6).toString("base64url");
      if (!email || !name) return res.status(400).json({ ok: false, error: "Name and email are required" });
      if (!["admin", "staff", "client"].includes(userRole)) {
        return res.status(400).json({ ok: false, error: "Invalid role" });
      }
      if (userRole === "client" && !client_rowid) {
        return res.status(400).json({ ok: false, error: "client_rowid is required for client users" });
      }

      const existing = await findOne(req, "users", `email='${escapeZcql(email)}'`);
      if (existing) return res.status(409).json({ ok: false, error: "Email already registered" });

      const password_hash = await bcrypt.hash(password, 10);
      const row = await insertRow(req, "users", {
        email,
        name,
        role: userRole,
        password_hash,
        client_rowid: client_rowid || "",
        status: "active",
        last_login: "",
        created_at: nowUtcForCatalyst(),
      });

      return res.status(201).json({
        ok: true,
        user: publicUser({ ...row, email, name, role: userRole, client_rowid }),
        temporaryPassword: password,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  return router;
}

module.exports = { createAuthRouter };
