"use strict";

const express = require("express");
const {
  findByRowId,
  findMany,
  countRows,
  escapeZcql,
  logActivity,
} = require("../catalyst/datastore");
const { requireAuth, requireStaff, isStaff, safeStr } = require("../utils/authUtils");
const { buildInvoicePdfBuffer, formatZAR } = require("../services/invoices");
const { sendInvoiceEmail } = require("../services/email");

function createInvoicesRouter() {
  const router = express.Router();

  router.get("/api/invoices", requireAuth, async (req, res) => {
    try {
      const status = safeStr(req.query.status);
      const clientId = safeStr(req.query.client_rowid);
      let where = "1=1";
      if (!isStaff(req.user)) {
        where += ` AND client_rowid='${escapeZcql(req.user.client_rowid)}'`;
      } else if (clientId) {
        where += ` AND client_rowid='${escapeZcql(clientId)}'`;
      }
      if (status && status !== "all") where += ` AND status='${escapeZcql(status)}'`;

      const [rows, total] = await Promise.all([
        findMany(req, "invoices", where, "CREATEDTIME DESC", Number(req.query.limit) || 50, Number(req.query.offset) || 0),
        countRows(req, "invoices", where),
      ]);

      const enriched = [];
      for (const inv of rows) {
        const client = await findByRowId(req, "clients", inv.client_rowid);
        enriched.push({ ...inv, client, total_label: formatZAR(inv.total_cents) });
      }
      return res.json({ ok: true, rows: enriched, total });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/api/invoices/:id", requireAuth, async (req, res) => {
    try {
      const invoice = await findByRowId(req, "invoices", req.params.id);
      if (!invoice) return res.status(404).json({ ok: false, error: "Invoice not found" });
      if (!isStaff(req.user) && String(invoice.client_rowid) !== String(req.user.client_rowid)) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }
      const client = await findByRowId(req, "clients", invoice.client_rowid);
      const lines = await findMany(
        req,
        "invoice_line_items",
        `invoice_rowid='${escapeZcql(invoice.ROWID)}'`,
        "ROWID ASC",
        50,
        0
      );
      const payments = await findMany(
        req,
        "payments",
        `invoice_rowid='${escapeZcql(invoice.ROWID)}'`,
        "CREATEDTIME DESC",
        20,
        0
      );
      return res.json({ ok: true, invoice: { ...invoice, client, lines, payments } });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/api/invoices/:id/pdf", requireAuth, async (req, res) => {
    try {
      const invoice = await findByRowId(req, "invoices", req.params.id);
      if (!invoice) return res.status(404).json({ ok: false, error: "Invoice not found" });
      if (!isStaff(req.user) && String(invoice.client_rowid) !== String(req.user.client_rowid)) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }
      const pdf = await buildInvoicePdfBuffer(req, invoice);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${invoice.invoice_number}.pdf"`);
      return res.send(pdf);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/api/invoices/:id/send", requireAuth, requireStaff, async (req, res) => {
    try {
      const invoice = await findByRowId(req, "invoices", req.params.id);
      if (!invoice) return res.status(404).json({ ok: false, error: "Invoice not found" });
      const client = await findByRowId(req, "clients", invoice.client_rowid);
      if (!client?.email) return res.status(400).json({ ok: false, error: "Client has no email" });
      const pdf = await buildInvoicePdfBuffer(req, invoice);
      const portalUrl = `${safeStr(process.env.PORTAL_BASE_URL || "http://localhost:5173").replace(/\/+$/, "")}/invoices/${invoice.ROWID}`;
      const result = await sendInvoiceEmail({
        to: client.email,
        name: client.contact_person || client.name,
        invoiceNumber: invoice.invoice_number,
        pdfBuffer: pdf,
        portalUrl,
      });
      await logActivity(req, {
        actor_type: req.user.role,
        actor_email: req.user.email,
        action: "invoice.send",
        entity_type: "invoice",
        entity_rowid: String(invoice.ROWID),
        summary: `Emailed invoice ${invoice.invoice_number} to ${client.email}`,
      });
      return res.json({ ok: true, result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  return router;
}

module.exports = { createInvoicesRouter };
