// Upstash Redis over REST. Works with the Vercel Marketplace names (KV_REST_API_URL / KV_REST_API_TOKEN),
// Upstash's own (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN), and either with a custom prefix (FOO_KV_REST_API_URL).
let override = null;

function findEnv(names) {
  const env = process.env;
  for (const n of names) if (env[n]) return env[n];
  for (const k of Object.keys(env).sort()) for (const n of names) if (k.endsWith('_' + n) && env[k]) return env[k];
  return '';
}
function config() {
  return {url: findEnv(['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL']),
          token: findEnv(['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN'])};
}
let client = null;
function getRedis() {
  if (override) return override;
  if (client) return client;
  const {url, token} = config();
  if (!url || !token) return null;
  const {Redis} = require('@upstash/redis');
  client = new Redis({url, token, automaticDeserialization: false});   // we store JSON strings ourselves
  return client;
}
/** Tests / local harness: inject a fake client (or null to reset). */
function setRedisForTests(fake) { override = fake; client = null; }
module.exports = {getRedis, setRedisForTests, config};
