// Create / upgrade the Turso tables from the box (idempotent; the functions also do this on first request).
//   cd /workspace/pickems/vercel && TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... node scripts/migrate.mjs
// Also accepts a local file for testing: TURSO_DATABASE_URL=file:/tmp/x.db node scripts/migrate.mjs
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {migrate, config} = require('../lib/db.js');
const {SCHEMA_VERSION} = require('../lib/schema.js');
const {url, authToken} = config();
if (!url) { console.error('Set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN for a remote database).'); process.exit(2); }
const {createClient} = await import('@libsql/client');   // Node client: libsql://, https://, file:
const db = createClient({url, authToken: authToken || undefined});
await migrate(db);
const t = await db.execute("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name");
const v = await db.execute("SELECT value FROM meta WHERE key = 'schema_version'");
const n = await db.execute('SELECT week, COUNT(*) AS n FROM entries GROUP BY week ORDER BY week');
console.log(JSON.stringify({database: url.replace(/\?.*$/, ''), schema_version: Number(v.rows[0].value), expected: SCHEMA_VERSION,
  objects: t.rows.map(r => r.name), entries_per_week: Object.fromEntries(n.rows.map(r => [r.week, r.n]))}, null, 1));
db.close();
