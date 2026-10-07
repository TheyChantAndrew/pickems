// Admin auth. Only the SHA-256 of the admin token lives in the repo; the token itself stays on Andy's box
// (/workspace/pickems/.pickems_admin_key). Optional override: env ADMIN_TOKEN_SHA256 (64 hex chars).
const crypto = require('crypto');
const ADMIN_TOKEN_SHA256 = '15216e92fc5b87a64ef6c02d124cbe1e22aca2a69fa280640cd886ef9cf62d1b';

function expectedHash() {
  const env = String(process.env.ADMIN_TOKEN_SHA256 || '').trim().toLowerCase();
  const h = /^[0-9a-f]{64}$/.test(env) ? env : ADMIN_TOKEN_SHA256;
  return /^[0-9a-f]{64}$/.test(h) ? Buffer.from(h, 'hex') : null;   // null => fail closed
}

/** Constant-time check of a presented token (compares SHA-256 digests, so lengths always match). */
function tokenOk(token) {
  const want = expectedHash();
  if (!want || typeof token !== 'string' || token.length < 16 || token.length > 512) return false;
  const got = crypto.createHash('sha256').update(token, 'utf8').digest();
  return crypto.timingSafeEqual(got, want);
}

/** Bearer header always; ?key= only where allowQuery (CSV link Andy opens in a browser). */
function requestToken(req, query, allowQuery) {
  const h = String((req.headers && req.headers.authorization) || '');
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  if (m) return m[1];
  if (allowQuery && query && typeof query.key === 'string') return query.key;
  return '';
}

module.exports = {tokenOk, requestToken, ADMIN_TOKEN_SHA256};
