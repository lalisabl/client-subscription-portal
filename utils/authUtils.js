"use strict";

const jwt = require("jsonwebtoken");

function safeStr(v) {
  return String(v == null ? "" : v).trim();
}

function getJwtSecret() {
  const secret = safeStr(process.env.JWT_SECRET);
  if (!secret || secret.length < 32) {
    throw new Error("Missing or weak JWT_SECRET (min 32 chars)");
  }
  return secret;
}

function signToken(payload, remember = false) {
  const expiresIn = remember ? "30d" : "12h";
  return jwt.sign(payload, getJwtSecret(), { expiresIn });
}

function verifyToken(token) {
  try {
    return { ok: true, payload: jwt.verify(safeStr(token), getJwtSecret()) };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

function readBearer(req) {
  const auth = safeStr(req.headers.authorization);
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return "";
}

function requireAuth(req, res, next) {
  const token = readBearer(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  const check = verifyToken(token);
  if (!check.ok) {
    return res.status(401).json({ ok: false, error: "Invalid or expired token" });
  }
  req.user = check.payload;
  return next();
}

function requireRole(...roles) {
  const allowed = roles.map((r) => String(r).toLowerCase());
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    const role = safeStr(req.user.role).toLowerCase();
    if (!allowed.includes(role)) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }
    return next();
  };
}

function requireStaff(req, res, next) {
  return requireRole("admin", "staff")(req, res, next);
}

function requireClientScope(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  const role = safeStr(req.user.role).toLowerCase();
  if (role === "admin" || role === "staff") return next();
  if (role === "client") {
    req.clientScopeId = safeStr(req.user.client_rowid || req.user.clientRowId);
    if (!req.clientScopeId) {
      return res.status(403).json({ ok: false, error: "Client account not linked" });
    }
    return next();
  }
  return res.status(403).json({ ok: false, error: "Forbidden" });
}

function requireInternalSecret(req, res) {
  const expected = safeStr(process.env.INTERNAL_API_SECRET);
  if (!expected) {
    res.status(500).json({ ok: false, error: "Missing INTERNAL_API_SECRET env var" });
    return false;
  }
  const got = safeStr(req.headers["x-internal-secret"]);
  if (!got || got !== expected) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

function isStaff(user) {
  const role = safeStr(user?.role).toLowerCase();
  return role === "admin" || role === "staff";
}

function isClient(user) {
  return safeStr(user?.role).toLowerCase() === "client";
}

module.exports = {
  safeStr,
  signToken,
  verifyToken,
  readBearer,
  requireAuth,
  requireRole,
  requireStaff,
  requireClientScope,
  requireInternalSecret,
  isStaff,
  isClient,
};
