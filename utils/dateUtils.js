"use strict";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function todayYmd() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function todayYmdSa() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value || "";
  const m = parts.find((p) => p.type === "month")?.value || "";
  const d = parts.find((p) => p.type === "day")?.value || "";
  if (!y || !m || !d) return todayYmd();
  return `${y}-${m}-${d}`;
}

function nowUtcForCatalyst() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function parseYmd(ymd) {
  const m = String(ymd || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

function ymdFromParts(y, mo, d) {
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

function addMonthsYmd(ymd, months) {
  const p = parseYmd(ymd);
  if (!p) return "";
  const date = new Date(Date.UTC(p.y, p.mo - 1 + Number(months || 0), p.d));
  return ymdFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function addYearsYmd(ymd, years) {
  const p = parseYmd(ymd);
  if (!p) return "";
  return ymdFromParts(p.y + Number(years || 0), p.mo, p.d);
}

/** PayFast frequency: 3=monthly, 4=quarterly, 5=biannual, 6=annual */
function nextRunFromFrequency(frequency, fromYmd) {
  const base = fromYmd || todayYmdSa();
  const f = Number(frequency);
  if (f === 3) return addMonthsYmd(base, 1);
  if (f === 4) return addMonthsYmd(base, 3);
  if (f === 5) return addMonthsYmd(base, 6);
  if (f === 6) return addYearsYmd(base, 1);
  return addMonthsYmd(base, 1);
}

function frequencyLabel(frequency) {
  const map = {
    1: "Daily",
    2: "Weekly",
    3: "Monthly",
    4: "Quarterly",
    5: "Biannually",
    6: "Annually",
  };
  return map[Number(frequency)] || "Monthly";
}

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return "";
  }
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = {
  todayYmd,
  todayYmdSa,
  nowUtcForCatalyst,
  parseYmd,
  ymdFromParts,
  addMonthsYmd,
  addYearsYmd,
  nextRunFromFrequency,
  frequencyLabel,
  safeJsonStringify,
  escapeHtml,
};
