// Builds the real dependencies from environment variables, once per warm function instance.
import { makeVerifier } from './auth.js';
import { SafeCache, upstashCache } from './cache.js';
import { cleanupRpc, roomsQuery } from './db.js';

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] as const;

function need(env: NodeJS.ProcessEnv) {
  const missing = REQUIRED.filter(k => !env[k]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`); // names only, never values
  return env as Record<(typeof REQUIRED)[number], string> & NodeJS.ProcessEnv;
}

let cached: ReturnType<typeof build> | null = null;
function build(env: NodeJS.ProcessEnv) {
  const e = need(env);
  const url = e.SUPABASE_URL.replace(/\/+$/, '');
  return {
    verify: makeVerifier(url, e.SUPABASE_JWT_SECRET || undefined),
    fetchRooms: roomsQuery(url, e.SUPABASE_SERVICE_ROLE_KEY),
    cleanup: cleanupRpc(url, e.SUPABASE_SERVICE_ROLE_KEY),
    cronSecret: e.CRON_SECRET || undefined,
    redis: upstashCache(e.UPSTASH_REDIS_REST_URL, e.UPSTASH_REDIS_REST_TOKEN),
  };
}

/** a fresh SafeCache per request (it carries the per-request "failed" flag) over the shared Redis client */
export function runtime(env: NodeJS.ProcessEnv = process.env) {
  cached ??= build(env);
  return { ...cached, cache: new SafeCache(cached.redis) };
}
