// Redis access for the functions. Upstash's REST client is used in production; anything implementing `Cache` works.
// Every operation is time-limited and the service treats errors as "cache unavailable", never as request failure.
import { Redis } from '@upstash/redis';

export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  /** SET key value NX EX ttl -> true when this caller created the key (used as a short refresh lock) */
  setNX(key: string, value: string, ttlSec: number): Promise<boolean>;
  del(...keys: string[]): Promise<void>;
}

export function upstashCache(url: string, token: string): Cache {
  // we store plain JSON strings ourselves; turn the client's automatic (de)serialisation off so values round-trip exactly
  const r = new Redis({ url, token, automaticDeserialization: false, retry: false });
  return {
    async get(key) { const v = await r.get<string | null>(key); return typeof v === 'string' ? v : null; },
    async set(key, value, ttlSec) { await r.set(key, value, { ex: ttlSec }); },
    async setNX(key, value, ttlSec) { return (await r.set(key, value, { nx: true, ex: ttlSec })) === 'OK'; },
    async del(...keys) { if (keys.length) await r.del(...keys); },
  };
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/** wraps a Cache so each call is bounded by `ms` and failures are reported instead of thrown */
export class SafeCache {
  /** set to true by any failed call; the service reports it as X-Cache: bypass */
  failed = false;
  constructor(private inner: Cache, private ms = 800, private onError: (m: string) => void = m => console.warn(m)) {}

  private async run<T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try { return await withTimeout(fn(), this.ms, `redis ${name}`); }
    catch (e) { this.failed = true; this.onError(`cache ${name} failed: ${e instanceof Error ? e.message : String(e)}`); return fallback; }
  }
  get(key: string) { return this.run('get', () => this.inner.get(key), null as string | null); }
  set(key: string, v: string, ttl: number) { return this.run('set', () => this.inner.set(key, v, ttl), undefined); }
  /** on failure returns true so the caller proceeds to refresh itself instead of waiting for a lock that cannot exist */
  setNX(key: string, v: string, ttl: number) { return this.run('setnx', () => this.inner.setNX(key, v, ttl), true); }
  del(...keys: string[]) { return this.run('del', () => this.inner.del(...keys), undefined); }
}
