// Minimal helpers that work on Vercel's Node runtime and on a plain node:http server (local harness/tests).
const crypto = require('crypto');
const BODY_MAX = 8192;

/** One JSON log line per outcome for routes that opted in (handler opts.route): route, HTTP status, error code, week,
 *  created/updated, name length. Never names, codes, picks, tiebreakers or IPs. */
function logOutcome(res, status, obj) {
  const L = res && res._pkLog; if (!L || L.done) return;
  L.done = true;
  const o = obj && typeof obj === 'object' ? obj : {};
  const c = L.ctx || {};
  try {
    console.log(JSON.stringify({evt: 'pickems', route: L.route, status, ok: o.ok === true, code: o.ok === true ? null : (o.code || null),
      week: Number.isFinite(c.week) ? c.week : null, result: o.ok === true && (o.status === 'created' || o.status === 'updated') ? o.status : null,
      name_len: Number.isFinite(c.name_len) ? c.name_len : null}));
  } catch (_e) { /* never let logging break a response */ }
}
/** Safe log context from a request body: week number + name length only. */
function logCtx(b) {
  b = b && typeof b === 'object' ? b : {};
  const w = Number(b.week);
  return {week: Number.isFinite(w) && w > 0 ? w : null, name_len: b.name == null ? 0 : String(b.name).trim().length};
}

function send(res, status, obj, headers) {
  logOutcome(res, status, obj);
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!headers || !headers['Content-Type']) res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v);
  res.end(body);
}

function query(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  const u = new URL(req.url || '/', 'http://x');
  return Object.fromEntries(u.searchParams.entries());
}

/** JSON body as an object, or throws {status, error}. Accepts Vercel's pre-parsed req.body or reads the stream. */
async function jsonBody(req) {
  const len = Number(req.headers['content-length'] || 0);
  if (len > BODY_MAX) throw {status: 413, error: 'That request is too big.'};
  let raw;
  if ('body' in req) {               // Vercel's helpers pre-read + parse the body (getter throws on bad JSON)
    try { raw = req.body; } catch (e) { throw {status: 400, error: 'Could not read that request (bad JSON).'}; }
    if (raw === undefined || raw === null) raw = '';
  } else {
    raw = await new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > BODY_MAX) { reject({status: 413, error: 'That request is too big.'}); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw === 'string') {
    if (raw.length > BODY_MAX) throw {status: 413, error: 'That request is too big.'};
    try { raw = raw ? JSON.parse(raw) : {}; } catch (e) { throw {status: 400, error: 'Could not read that request (bad JSON).'}; }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw {status: 400, error: 'Could not read that request.'};
  if (JSON.stringify(raw).length > BODY_MAX) throw {status: 413, error: 'That request is too big.'};
  return raw;
}

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || String(req.headers['x-real-ip'] || '') || (req.socket && req.socket.remoteAddress) || 'unknown';
}
const ipHash = ip => crypto.createHash('sha256').update('fbp:' + ip).digest('hex').slice(0, 16);

module.exports = {logCtx, logOutcome, send, query, jsonBody, clientIp, ipHash, BODY_MAX};
