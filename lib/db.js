// Turso (libSQL) client. Vercel env: TURSO_DATABASE_URL (libsql://<db>-<org>.turso.io) + TURSO_AUTH_TOKEN.
// Uses @libsql/client/web only (pure fetch, no native binary in the function bundle). Local tests inject a file: DB
// client via setDbForTests (test/harness.js) or point at a local sqld over http://127.0.0.1.
const {SCHEMA} = require('./schema');
let override = null, client = null, ready = null;

function findEnv(names) {
  const env = process.env;
  for (const n of names) if (env[n]) return env[n];
  for (const k of Object.keys(env).sort()) for (const n of names) if (k.endsWith('_' + n) && env[k]) return env[k];
  return '';
}
function config() {
  return {url: findEnv(['TURSO_DATABASE_URL', 'LIBSQL_URL']).trim(), authToken: findEnv(['TURSO_AUTH_TOKEN', 'LIBSQL_AUTH_TOKEN']).trim()};
}
function makeClient(url, authToken) {
  if (!/^(libsql|https):\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url))   // http only for a local sqld in tests
    throw new Error('TURSO_DATABASE_URL must start with libsql:// or https://');
  return require('@libsql/client/web').createClient({url, authToken: authToken || undefined});
}
async function migrate(c) { await c.batch(SCHEMA, 'write'); }

/** Ready-to-use client (schema ensured once per instance), or null when no database is configured. */
async function getDb() {
  let c = override;
  if (!c) {
    if (!client) {
      const {url, authToken} = config();
      if (!url) return null;
      client = makeClient(url, authToken);
    }
    c = client;
  }
  if (!ready) ready = migrate(c).catch(e => { ready = null; throw e; });
  await ready;
  return c;
}
/** Tests / local harness: inject a client (file: DB from the default @libsql/client) or null to reset. */
function setDbForTests(c) { override = c; client = null; ready = null; }
module.exports = {getDb, setDbForTests, config, makeClient, migrate};
