"use strict";

const PDFDocument = require("pdfkit");
const {
  findByRowId,
  findOne,
  findMany,
  insertRow,
  updateRow,
  escapeZcql,
} = require("../catalyst/datastore");
const { todayYmdSa, nowUtcForCatalyst, frequencyLabel } = require("../utils/dateUtils");

function safeStr(v) {
  return String(v == null ? "" : v).trim();
}

function formatZAR(cents) {
  const n = Number(cents || 0) / 100;
  return new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(n);
}

async function getSetting(req, key, fallback = null) {
  try {
    const row = await findOne(req, "settings", `key_name='${escapeZcql(key)}'`);
    if (!row) return fallback;
    const raw = row.value_json;
    if (raw == null || raw === "") return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  } catch {
    return fallback;
  }
}

async function getVatRate(req) {
  const fromEnv = Number(process.env.DEFAULT_VAT_RATE || 15);
  const setting = await getSetting(req, "vat_rate", fromEnv);
  const n = Number(setting);
  return Number.isFinite(n) ? n : 15;
}

async function getCompanyDetails(req) {
  return (
    (await getSetting(req, "company", null)) || {
      name: "Manvic Distributors",
      address: "",
      vat_number: "",
      email: safeStr(process.env.SMTP_FROM_EMAIL),
      phone: "",
    }
  );
}

async function nextInvoiceNumber(req) {
  const prefix = safeStr((await getSetting(req, "invoice_prefix", process.env.INVOICE_PREFIX || "INV-")) || "INV-");
  const year = new Date().getFullYear();
  const likePrefix = `${prefix}${year}-`;
  let seq = 1;
  try {
    const rows = await findMany(
      req,
      "invoices",
      `invoice_number LIKE '${escapeZcql(likePrefix)}%'`,
      "invoice_number DESC",
      1,
      0
    );
    if (rows[0]?.invoice_number) {
      const parts = String(rows[0].invoice_number).split("-");
      const last = Number(parts[parts.length - 1]);
      if (Number.isFinite(last)) seq = last + 1;
    }
  } catch {
    // first invoice
  }
  return `${likePrefix}${String(seq).padStart(5, "0")}`;
}

/**
 * amounts in cents.
 * If vatInclusive: total is given, extract VAT.
 * Else: subtotal is given, add VAT.
 */
function calcVat({ amountCents, vatRate, vatInclusive }) {
  const rate = Number(vatRate) || 0;
  const amount = Math.round(Number(amountCents) || 0);
  if (vatInclusive) {
    const subtotal = Math.round(amount / (1 + rate / 100));
    const vat = amount - subtotal;
    return { subtotal_cents: subtotal, vat_cents: vat, total_cents: amount };
  }
  const vat = Math.round(amount * (rate / 100));
  return { subtotal_cents: amount, vat_cents: vat, total_cents: amount + vat };
}

async function createInvoiceForSubscription(req, { subscription, client, plan, status = "sent" }) {
  const vatRate = await getVatRate(req);
  const vatInclusive = String(plan?.vat_inclusive) === "true" || plan?.vat_inclusive === true;
  const amounts = calcVat({
    amountCents: subscription.amount_cents || plan?.amount_cents,
    vatRate,
    vatInclusive,
  });
  const invoiceNumber = await nextInvoiceNumber(req);
  const issueDate = todayYmdSa();
  const dueDate = issueDate;

  // Omit DateTime fields when unset — Catalyst rejects empty strings for datetime columns.
  const invoice = await insertRow(req, "invoices", {
    invoice_number: invoiceNumber,
    client_rowid: String(client.ROWID || subscription.client_rowid),
    subscription_rowid: String(subscription.ROWID),
    issue_date: issueDate,
    due_date: dueDate,
    status,
    subtotal_cents: amounts.subtotal_cents,
    vat_cents: amounts.vat_cents,
    total_cents: amounts.total_cents,
    currency: "ZAR",
    pdf_file_id: "",
    payfast_payment_id: "",
    m_payment_id: `sub-${subscription.ROWID}-${Date.now()}`,
    created_at: nowUtcForCatalyst(),
  });

  const invoiceRowId = invoice.ROWID || invoice.rowid;
  await insertRow(req, "invoice_line_items", {
    invoice_rowid: String(invoiceRowId),
    description: `${safeStr(plan?.name) || "Subscription"} (${frequencyLabel(subscription.frequency || plan?.frequency)})`,
    qty: 1,
    unit_amount_cents: amounts.subtotal_cents,
    vat_rate: vatRate,
    line_total_cents: amounts.subtotal_cents,
  });

  return { ...invoice, ROWID: invoiceRowId, invoice_number: invoiceNumber, ...amounts, m_payment_id: invoice.m_payment_id || `sub-${subscription.ROWID}-${Date.now()}` };
}

async function markInvoicePaid(req, invoice, paymentMeta = {}) {
  const rowId = invoice.ROWID || invoice.rowid;
  await updateRow(req, "invoices", rowId, {
    status: "paid",
    payfast_payment_id: safeStr(paymentMeta.pf_payment_id || invoice.payfast_payment_id),
    paid_at: nowUtcForCatalyst(),
  });
  return findByRowId(req, "invoices", rowId);
}

async function buildInvoicePdfBuffer(req, invoice) {
  const client = await findByRowId(req, "clients", invoice.client_rowid);
  const company = await getCompanyDetails(req);
  const lines = await findMany(req, "invoice_line_items", `invoice_rowid='${escapeZcql(invoice.ROWID)}'`, "ROWID ASC", 50, 0);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fillColor("#111").fontSize(20).text(company.name || "Manvic Distributors", { align: "left" });
    doc.fontSize(10).fillColor("#555");
    if (company.address) doc.text(company.address);
    if (company.vat_number) doc.text(`VAT: ${company.vat_number}`);
    if (company.email) doc.text(company.email);
    if (company.phone) doc.text(company.phone);

    doc.moveDown();
    doc.fillColor("#ef3b44").fontSize(18).text("TAX INVOICE", { align: "right" });
    doc.fillColor("#111").fontSize(11);
    doc.text(`Invoice: ${invoice.invoice_number}`, { align: "right" });
    doc.text(`Issue date: ${invoice.issue_date}`, { align: "right" });
    doc.text(`Due date: ${invoice.due_date}`, { align: "right" });
    doc.text(`Status: ${String(invoice.status || "").toUpperCase()}`, { align: "right" });

    doc.moveDown();
    doc.fontSize(12).text("Bill to");
    doc.fontSize(10).fillColor("#333");
    doc.text(client?.name || "Client");
    if (client?.contact_person) doc.text(client.contact_person);
    if (client?.email) doc.text(client.email);
    if (client?.billing_address) doc.text(client.billing_address);
    if (client?.vat_number) doc.text(`VAT: ${client.vat_number}`);

    doc.moveDown();
    doc.fillColor("#111").fontSize(11).text("Description", 50, doc.y, { continued: false });
    const tableTop = doc.y + 8;
    doc.font("Helvetica-Bold").text("Description", 50, tableTop);
    doc.text("Qty", 320, tableTop);
    doc.text("Amount", 400, tableTop, { width: 140, align: "right" });
    doc.moveTo(50, tableTop + 15).lineTo(545, tableTop + 15).strokeColor("#ddd").stroke();

    let y = tableTop + 25;
    doc.font("Helvetica").fillColor("#333");
    (lines.length ? lines : [{ description: "Subscription", qty: 1, line_total_cents: invoice.subtotal_cents }]).forEach((line) => {
      doc.text(safeStr(line.description), 50, y, { width: 250 });
      doc.text(String(line.qty || 1), 320, y);
      doc.text(formatZAR(line.line_total_cents || line.unit_amount_cents), 400, y, { width: 140, align: "right" });
      y += 22;
    });

    y += 10;
    doc.moveTo(300, y).lineTo(545, y).strokeColor("#ddd").stroke();
    y += 12;
    doc.text("Subtotal", 320, y);
    doc.text(formatZAR(invoice.subtotal_cents), 400, y, { width: 140, align: "right" });
    y += 18;
    doc.text("VAT", 320, y);
    doc.text(formatZAR(invoice.vat_cents), 400, y, { width: 140, align: "right" });
    y += 18;
    doc.font("Helvetica-Bold").fillColor("#111");
    doc.text("Total", 320, y);
    doc.text(formatZAR(invoice.total_cents), 400, y, { width: 140, align: "right" });

    doc.font("Helvetica").fontSize(9).fillColor("#777");
    doc.text("Thank you for your business.", 50, 750, { align: "center" });

    doc.end();
  });
}

module.exports = {
  formatZAR,
  getSetting,
  getVatRate,
  getCompanyDetails,
  nextInvoiceNumber,
  calcVat,
  createInvoiceForSubscription,
  markInvoicePaid,
  buildInvoicePdfBuffer,
};
