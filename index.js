"use strict";

require("dotenv").config();

const express = require("express");

const { createAuthRouter } = require("./routes/auth");
const { createClientsRouter } = require("./routes/clients");
const { createProductsRouter } = require("./routes/products");
const { createPlansRouter } = require("./routes/plans");
const { createSubscriptionsRouter } = require("./routes/subscriptions");
const { createInvoicesRouter } = require("./routes/invoices");
const { createPaymentsRouter } = require("./routes/payments");
const { createPayfastRouter } = require("./routes/payfast");
const { createDashboardRouter } = require("./routes/dashboard");
const { createReportsRouter } = require("./routes/reports");
const { createActivityRouter } = require("./routes/activity");
const { createSettingsRouter } = require("./routes/settings");
const { createPortalRouter } = require("./routes/portal");

const app = express();

/* ---------------------------
   CORS (local + configured origins)
---------------------------- */
const ENABLE_APP_CORS = String(process.env.ENABLE_APP_CORS || "").toLowerCase() === "true";
const ALLOWED_ORIGINS = String(process.env.CORS_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (ENABLE_APP_CORS) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Requested-With, x-internal-secret"
      );
      res.setHeader("Access-Control-Max-Age", "86400");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    return next();
  });
}

app.use((req, res, next) => {
  console.log(`[manvic-api] ${req.method} ${req.url}`);
  next();
});

/* Raw body for PayFast ITN signature verification */
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(
  express.urlencoded({
    extended: false,
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, service: "manvic-api" });
});
app.get("/api/health", (req, res) => {
  res.status(200).json({ ok: true, service: "manvic-api" });
});

app.use(createAuthRouter());
app.use(createClientsRouter());
app.use(createProductsRouter());
app.use(createPlansRouter());
app.use(createSubscriptionsRouter());
app.use(createInvoicesRouter());
app.use(createPaymentsRouter());
app.use(createPayfastRouter());
app.use(createDashboardRouter());
app.use(createReportsRouter());
app.use(createActivityRouter());
app.use(createSettingsRouter());
app.use(createPortalRouter());

app.use((err, req, res, next) => {
  console.error("unhandled_error", err);
  res.status(500).json({ ok: false, error: String(err?.message || err) });
});

const PORT = process.env.X_ZOHO_CATALYST_LISTEN_PORT || process.env.PORT || 9000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Manvic AppSail API running on port ${PORT}`);
});
