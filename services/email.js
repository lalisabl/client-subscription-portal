"use strict";

const nodemailer = require("nodemailer");
const { escapeHtml } = require("../utils/dateUtils");

function safeStr(v) {
  return String(v == null ? "" : v).trim();
}

function isSmtpConfigured() {
  return !!(safeStr(process.env.SMTP_HOST) && safeStr(process.env.SMTP_USER));
}

function getTransporter() {
  if (!isSmtpConfigured()) return null;
  return nodemailer.createTransport({
    host: safeStr(process.env.SMTP_HOST),
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
    auth: {
      user: safeStr(process.env.SMTP_USER),
      pass: safeStr(process.env.SMTP_PASS),
    },
  });
}

function fromAddress() {
  const email = safeStr(process.env.SMTP_FROM_EMAIL) || safeStr(process.env.SMTP_USER);
  const name = safeStr(process.env.SMTP_FROM_NAME) || "Manvic Client Portal";
  return `"${name}" <${email}>`;
}

async function sendEmail({ to, subject, html, text, attachments }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn("SMTP not configured — email skipped:", subject, "→", to);
    return { ok: false, skipped: true, messageId: "" };
  }
  const info = await transporter.sendMail({
    from: fromAddress(),
    to,
    subject,
    html,
    text: text || undefined,
    attachments: attachments || undefined,
  });
  return { ok: true, skipped: false, messageId: info.messageId || "" };
}

async function sendClientCredentialsEmail({ to, name, email, password, loginUrl }) {
  const subject = "Your Manvic Client Portal login";
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
      <h2>Welcome to Manvic Client Portal</h2>
      <p>Hi ${escapeHtml(name || "there")},</p>
      <p>Your client portal account has been created. Use the details below to sign in and view or pay your subscriptions.</p>
      <p><strong>Login URL:</strong> <a href="${escapeHtml(loginUrl)}">${escapeHtml(loginUrl)}</a></p>
      <p><strong>Email:</strong> ${escapeHtml(email)}<br/>
         <strong>Temporary password:</strong> ${escapeHtml(password)}</p>
      <p>Please sign in and change your password after your first login.</p>
      <p>— Manvic Distributors</p>
    </div>
  `;
  return sendEmail({ to, subject, html });
}

async function sendInvoiceEmail({ to, name, invoiceNumber, pdfBuffer, portalUrl }) {
  const subject = `Invoice ${invoiceNumber} from Manvic`;
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
      <p>Hi ${escapeHtml(name || "there")},</p>
      <p>Please find invoice <strong>${escapeHtml(invoiceNumber)}</strong> attached.</p>
      <p>You can also view and pay in the portal: <a href="${escapeHtml(portalUrl)}">${escapeHtml(portalUrl)}</a></p>
      <p>— Manvic Distributors</p>
    </div>
  `;
  return sendEmail({
    to,
    subject,
    html,
    attachments: pdfBuffer
      ? [{ filename: `${invoiceNumber}.pdf`, content: pdfBuffer, contentType: "application/pdf" }]
      : undefined,
  });
}

async function sendPaymentReceiptEmail({ to, name, invoiceNumber, amountLabel }) {
  const subject = `Payment received — ${invoiceNumber}`;
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
      <p>Hi ${escapeHtml(name || "there")},</p>
      <p>We received your payment of <strong>${escapeHtml(amountLabel)}</strong> for invoice <strong>${escapeHtml(invoiceNumber)}</strong>.</p>
      <p>Thank you.</p>
      <p>— Manvic Distributors</p>
    </div>
  `;
  return sendEmail({ to, subject, html });
}

async function sendPasswordResetEmail({ to, resetUrl, ttlMinutes }) {
  const subject = "Reset your Manvic portal password";
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
      <p>Click the link below to reset your password. It expires in ${Number(ttlMinutes) || 30} minutes.</p>
      <p><a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a></p>
      <p>If you did not request this, you can ignore this email.</p>
    </div>
  `;
  return sendEmail({ to, subject, html });
}

module.exports = {
  isSmtpConfigured,
  sendEmail,
  sendClientCredentialsEmail,
  sendInvoiceEmail,
  sendPaymentReceiptEmail,
  sendPasswordResetEmail,
};
