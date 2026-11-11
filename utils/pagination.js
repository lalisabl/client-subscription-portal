"use strict";

function parseListPagination(req, defaultLimit = 25) {
  const limit = Math.min(Math.max(Number(req.query.limit) || defaultLimit, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  return { limit, offset };
}

function listMeta(limit, offset, total) {
  return { total: Number(total) || 0, limit, offset };
}

module.exports = { parseListPagination, listMeta };
