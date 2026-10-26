// Verifies Supabase access tokens locally (no network call per request, so the cache actually saves latency).
//  * projects with asymmetric signing keys (default for new projects): public keys from <url>/auth/v1/.well-known/jwks.json
//  * legacy projects: HS256 with SUPABASE_JWT_SECRET
// Anonymous users are fine (role "authenticated"); the `anon` API key itself is NOT accepted as a user token.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface Verifier { (token: string): Promise<{ sub: string }> }

export function makeVerifier(supabaseUrl: string, hs256Secret?: string, jwks?: JWTVerifyGetKey): Verifier {
  const issuer = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1`;
  const keys = jwks ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { cooldownDuration: 30_000, cacheMaxAge: 600_000 });
  const secret = hs256Secret ? new TextEncoder().encode(hs256Secret) : null;
  return async token => {
    const opts = { issuer, audience: 'authenticated', clockTolerance: 5 } as const;
    const { payload } = secret
      ? await jwtVerify(token, secret, { ...opts, algorithms: ['HS256'] })
      : await jwtVerify(token, keys, { ...opts, algorithms: ['ES256', 'RS256', 'EdDSA'] });
    if (payload.role !== 'authenticated' || typeof payload.sub !== 'string') throw new Error('not a user token');
    return { sub: payload.sub };
  };
}

export function bearer(header: string | string[] | undefined): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  if (!h) return null;
  const m = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(h);
  return m && m[1].length <= 4096 ? m[1] : null;
}
