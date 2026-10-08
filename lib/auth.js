// Admin auth. Only SHA-256 hashes of the tokens live in the repo; the tokens themselves stay on Andy's box.
//   admin token  (sync, CSV export, delete, reset-code): /workspace/pickems/.pickems_admin_key.  Override: env ADMIN_TOKEN_SHA256
//   portal token (Andy's /admin paid toggles only):      /workspace/pickems/.pickems_portal_link. Override: env PORTAL_TOKEN_SHA256
// A 256-bit random token's SHA-256 can't be reversed, so publishing the hash is safe; the env vars (64 hex chars) only exist to
// rotate a token without a code change. Both checks fail closed if the configured hash is malformed.
const crypto = require('crypto');
const ADMIN_TOKEN_SHA256 = '15216e92fc5b87a64ef6c02d124cbe1e22aca2a69fa280640cd886ef9cf62d1b';
const PORTAL_TOKEN_SHA256 = '9a5bddbaae7708b46e00844cc7e0aaac8fee8c3a708bb1969639ba93a38789a4';

function hashFrom(envName, fallback) {
  const env = String(process.env[envName] || '').trim().toLowerCase();
  const h = /^[0-9a-f]{64}$/.test(env) ? env : fallback;
  return /^[0-9a-f]{64}$/.test(h) ? Buffer.from(h, 'hex') : null;   // null => fail closed
}
/** Constant-time check of a presented token against a hash (compares SHA-256 digests, so lengths always match). */
function matches(token, want) {
  if (!want || typeof token !== 'string' || token.length < 16 || token.length > 512) return false;
  const got = crypto.createHash('sha256').update(token, 'utf8').digest();
  return crypto.timingSafeEqual(got, want);
}
const tokenOk = token => matches(token, hashFrom('ADMIN_TOKEN_SHA256', ADMIN_TOKEN_SHA256));
const portalTokenOk = token => matches(token, hashFrom('PORTAL_TOKEN_SHA256', PORTAL_TOKEN_SHA256));
/** /api/admin/paid: Andy's portal token, or the box admin token (set_paid.py). Both are always evaluated (no early exit). */
function paidTokenOk(token) { const a = portalTokenOk(token), b = tokenOk(token); return a || b; }

/** Bearer header always; ?key= only where allowQuery (CSV link Andy opens in a browser). */
function requestToken(req, query, allowQuery) {
  const h = String((req.headers && req.headers.authorization) || '');
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  if (m) return m[1];
  if (allowQuery && query && typeof query.key === 'string') return query.key;
  return '';
}

module.exports = {tokenOk, portalTokenOk, paidTokenOk, requestToken, ADMIN_TOKEN_SHA256, PORTAL_TOKEN_SHA256};
