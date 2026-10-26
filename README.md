# Graphwar (web)

A browser port of **Graphwar**, the artillery game where you hit enemies by typing mathematical functions
(`y = f(x)`, first- and second-order ODE modes, computer opponents, up to 10 players online).
Based on the open-source Java game by Lucas Catabriga Rocha — **GPL-3.0** (see `LICENSE`, original source in `reference/java-src`).

Works offline out of the box. Online play (lobby, chat, rooms) needs a free Supabase project.

## Run locally

```bash
npm install
npm run dev          # http://localhost:5173 — offline play works immediately
npm test             # 141 tests (game parity vs the Java original, online layer, API)
npm run typecheck && npm run build
```

## Architecture

| Part | What it does |
|---|---|
| **Vercel** | Serves the static game (Vite) and two server functions: `GET /api/rooms`, `GET /api/cron/cleanup` |
| **Supabase** | Anonymous auth, `rooms` table (Row Level Security), private Realtime channels for lobby, rooms and game traffic |
| **Upstash Redis** | Cache-aside for the public room list (5 s TTL, 60 s stale copy, lock against stampedes). If Redis fails the API reads Supabase directly; if the API fails the browser reads Supabase directly |

Online games: the room creator's browser runs the game server (as in the original, where the creator's PC was the server);
other players are guests. Channel policies decide who may read/write what, so guests cannot forge host messages or read each other's keys.
Computer players run in a Web Worker.

## Deploy

1. **Supabase**: create a project → *Authentication → Sign In / Providers →* enable **Anonymous sign-ins** →
   run `supabase/migrations/20261024000000_rooms.sql` (SQL editor, or `supabase link && supabase db push`).
2. **Upstash**: create a Redis database, copy the REST URL and token.
3. **Vercel**: import this repo (framework "Vite" is detected from `vercel.json`) and set the environment variables below.
   Then `CRON_SECRET`: any long random string (`openssl rand -hex 32`).

| Variable | Where | Secret? |
|---|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | browser | no (public by design; RLS protects data) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | server functions only | **yes** |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | server functions only | **yes** |
| `CRON_SECRET` | server functions only | **yes** |
| `SUPABASE_JWT_SECRET` | server, only for legacy projects with HS256 tokens | **yes** |

Variables without the `VITE_` prefix are never bundled into the browser code. Never put the service-role key, database password
or Upstash token in a `VITE_` variable or in source control (`.env*` is git-ignored; copy `.env.example`).
The cleanup cron runs daily (the free Vercel plan only allows daily crons); stale rooms are hidden from the list after 2 minutes regardless.

If your Supabase project uses a custom domain, add it to `connect-src` in the Content-Security-Policy in `vercel.json`.

## Security notes

- Row Level Security is enabled and forced on `rooms`; `anon` has no access; users can only create/update/delete their own room and only see fresh rooms.
- `/api/rooms` verifies the caller's Supabase JWT locally, returns only public columns, and caches one list shared by everyone (no per-user data in cache keys or values → no cross-user leaks).
- Cached and database data is re-validated before use; player names are rendered as text, never as HTML.
- Security headers + CSP are set in `vercel.json`.

## Testing and status

See `PROGRESS.md` for exactly what was tested and what was not. Short version: all logic is tested automatically
(including against a real Redis and a real Postgres for the RLS rules), but **nothing has been run against a live Supabase, Upstash or
Vercel account yet** — do the checklist in `PROGRESS.md` ("First live deploy") before relying on online play.
