"use strict";

const catalystSDK = require("zcatalyst-sdk-node");

function getCatalyst(req) {
  // AppSail injects Catalyst project headers only when run via `catalyst serve` / deployed AppSail.
  // Plain `node index.js` / nodemon has no context — initialize() fails and the SDK module
  // itself has no .zcql(), which surfaces as "catalyst.zcql is not a function".
  if (!req || typeof req !== "object") {
    throw new Error('Catalyst request context missing. Start the API with: cd backend && catalyst serve');
  }
  try {
    return catalystSDK.initialize(req);
  } catch (err) {
    const msg = String(err?.message || err);
    throw new Error(
      `Catalyst SDK init failed: ${msg}. Run AppSail via "catalyst serve" (not "npm run dev" / nodemon).`
    );
  }
}

function escapeZcql(value) {
  return String(value == null ? "" : value).replace(/'/g, "''");
}

function unwrapRow(result, tableName) {
  if (!Array.isArray(result) || result.length === 0) return null;
  const row = result[0];
  return row?.[tableName] || row || null;
}

function unwrapRows(result, tableName) {
  if (!Array.isArray(result)) return [];
  return result.map((row) => row?.[tableName] || row).filter(Boolean);
}

async function zcqlQuery(req, query) {
  const catalyst = getCatalyst(req);
  const zcql = catalyst.zcql();
  return zcql.executeZCQLQuery(query);
}

async function findByRowId(req, tableName, rowId) {
  if (!rowId) return null;
  const safe = escapeZcql(rowId);
  const out = await zcqlQuery(req, `SELECT * FROM ${tableName} WHERE ROWID='${safe}' LIMIT 1`);
  return unwrapRow(out, tableName);
}

async function findOne(req, tableName, whereClause) {
  const out = await zcqlQuery(req, `SELECT * FROM ${tableName} WHERE ${whereClause} LIMIT 1`);
  return unwrapRow(out, tableName);
}

async function findMany(req, tableName, whereClause = "1=1", orderBy = "CREATEDTIME DESC", limit = 100, offset = 0) {
  const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
  const off = Math.max(0, Number(offset) || 0);
  const out = await zcqlQuery(
    req,
    `SELECT * FROM ${tableName} WHERE ${whereClause} ORDER BY ${orderBy} LIMIT ${lim} OFFSET ${off}`
  );
  return unwrapRows(out, tableName);
}

async function countRows(req, tableName, whereClause = "1=1") {
  const out = await zcqlQuery(req, `SELECT COUNT(ROWID) FROM ${tableName} WHERE ${whereClause}`);
  if (!Array.isArray(out) || out.length === 0) return 0;
  const row = out[0];
  const nested = row?.[tableName] || row || {};
  const val =
    nested["COUNT(ROWID)"] ??
    nested.count ??
    nested.COUNT ??
    Object.values(nested).find((v) => typeof v === "number" || /^\d+$/.test(String(v)));
  return Number(val || 0);
}

async function insertRow(req, tableName, data) {
  const catalyst = getCatalyst(req);
  const table = catalyst.datastore().table(tableName);
  return table.insertRow(data);
}

async function updateRow(req, tableName, rowId, updates) {
  const catalyst = getCatalyst(req);
  const table = catalyst.datastore().table(tableName);
  return table.updateRow({ ROWID: rowId, ...updates });
}

async function deleteRow(req, tableName, rowId) {
  const catalyst = getCatalyst(req);
  const table = catalyst.datastore().table(tableName);
  return table.deleteRow(rowId);
}

async function logActivity(req, entry) {
  try {
    await insertRow(req, "activity_log", {
      actor_type: String(entry.actor_type || "system"),
      actor_email: String(entry.actor_email || ""),
      action: String(entry.action || ""),
      entity_type: String(entry.entity_type || ""),
      entity_rowid: String(entry.entity_rowid || ""),
      summary: String(entry.summary || ""),
      meta_json: typeof entry.meta_json === "string" ? entry.meta_json : JSON.stringify(entry.meta_json || {}),
      created_at: entry.created_at || require("../utils/dateUtils").nowUtcForCatalyst(),
    });
  } catch (err) {
    console.error("activity_log_insert_failed", String(err?.message || err));
  }
}

module.exports = {
  getCatalyst,
  escapeZcql,
  unwrapRow,
  unwrapRows,
  zcqlQuery,
  findByRowId,
  findOne,
  findMany,
  countRows,
  insertRow,
  updateRow,
  deleteRow,
  logActivity,
};
