"use strict";

/** Normalize plan/invoice amounts from Catalyst (number, string, BigInt). */
function centsFromStore(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "bigint") return Number(value);
  const s = String(value).replace(/,/g, "").trim();
  const n = Math.round(Number(s));
  if (!Number.isFinite(n)) throw new Error("Invalid amount");
  return n;
}

function zarToCents(zar) {
  return Math.round(Number(zar || 0) * 100);
}

function centsToZar(cents) {
  return Number(centsFromStore(cents)) / 100;
}

module.exports = {
  centsFromStore,
  zarToCents,
  centsToZar,
};
