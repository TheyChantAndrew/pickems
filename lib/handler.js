// Shared wrapper for the /api functions: method check, storage check, error -> JSON.
const {send} = require('./http');
const {getRedis} = require('./redis');
let clock = () => Date.now();
function setClockForTests(fn) { clock = fn || (() => Date.now()); }
function now() { return clock(); }

function handler(methods, fn, opts = {}) {
  return async (req, res) => {
    try {
      if (!methods.includes(req.method)) return send(res, 405, {ok: false, error: 'Method not allowed'}, {Allow: methods.join(', ')});
      let redis = null;
      if (opts.storage !== false) {
        redis = getRedis();
        if (!redis) return send(res, 503, {ok: false, error: 'Picks storage is not connected yet.', code: 'NO_STORAGE'});
      }
      return await fn(req, res, redis, now());
    } catch (err) {
      if (err && (err.code || err.status) && err.message !== undefined && err.status) return send(res, err.status, {ok: false, error: err.message, code: err.code});
      if (err && err.status && err.error) return send(res, err.status, {ok: false, error: err.error, code: 'BAD'});
      console.error(err);
      return send(res, 500, {ok: false, error: 'Server error, please try again.', code: 'ERR'});
    }
  };
}
module.exports = {handler, now, setClockForTests};
