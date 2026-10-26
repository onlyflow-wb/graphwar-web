# Graphwar Web — Progress File
(Resume here. Work is done ONE POINT per session. Update this file at the end of each.)

## Source of truth
Base = original **Graphwar** (Java Swing, GPL-3.0, github repo supplied by user), NOT the Godot "Graphwar II" APK
(that APK zip had no .pck, so its content was unrecoverable). Java source kept in `reference/java-src/` for porting.
Port is a derivative work => project is **GPL-3.0** (LICENSE included, keep copyright headers: Lucas Catabriga Rocha 2011).

## Roadmap (ONE point per session; update this file at the end of each)
Audited 2026-10-24 (typecheck + vitest actually run):
- [x] P1  Feature inventory + migration plan (below)
- [x] P2  Scaffold: Vite 5 + TS + vitest, tsconfig, stage scaler (existing, from earlier session)
- [x] P3  Core engine in `src/core/`: constants, rng, parser (+evaluator), terrain mask, shot physics (normal/RK4/RK4-2) — 76 parity tests vs ORIGINAL Java output (`test/golden/`) PASS
- [x] P4  Game logic: `server.ts` (GraphServer port: teams/ready/countdown/turns/skip/leader), `client.ts` (GameData port), `entities.ts`, `protocol.ts`, `session.ts` (in-page local session)
- [x] P5  AI `ai.ts` (ComputerBrain, genetic algo). Game test plays full rounds to a winner in all 3 modes — PASS (13 tests, ~18s; AI still runs on main thread, NOT yet in a Worker)
- [x] P6  UI with original PNGs: menu, pregame, game, plane (canvas), dom, preload, css, app.ts
- [x] P7  (done 2026-10-24) typecheck fixed; wrote `src/ui/lobby-screen.ts` + `src/main.ts` (was missing); `scripts/e2e-offline.mjs` drives headless Chromium: menu->create->add PC->ready->game->fire: passes, 0 console errors, screenshots reviewed. Dev-only `window.__app` hook is absent from prod bundle (verified).
- [x] P8  (done 2026-10-24) Supabase: `supabase/migrations/20261024000000_rooms.sql` + `supabase/config.toml` (anon sign-ins on).
      * `public.rooms` (code, host_id, name, mode, players, state, heartbeat updated_at); RLS + column-level grants:
        browsers can only insert (name, mode) and update (name, mode, players, state) THEIR room; code/host_id/updated_at server-controlled;
        1 room per host; constraints mirror Java limits (name<=20, players<=10, mode 0-2); rooms w/ heartbeat >2 min old are invisible;
        `cleanup_stale_rooms()` is service_role only (for the Vercel cron in P10); `anon` role has zero access.
      * `realtime.messages` policies: private channels `lobby` and `room:<CODE>` (room must exist) for signed-in users only.
      * Tests: `npm run test:db` (needs PG* env vars to ANY Postgres 15+; creates/drops scratch DB). 20 checks PASS on local Postgres 16.
        Mutation-checked: weakening the update policy or the freshness filter makes the suite fail.
      * NOT verified: real Supabase (auth.uid()/realtime.* are STUBS in `supabase/tests/00_stubs.sql`), the Supabase CLI `db push`, anonymous-user cleanup.
- [x] P9  (done 2026-10-24) `src/net/online.ts` (+ `main.ts` wiring via VITE_SUPABASE_URL/ANON_KEY, `.env.example`, `.gitignore`):
      * Lobby: private Realtime channel `lobby` (presence = online players, broadcast = chat); room list = polled every 5 s via `/api/rooms` (cached, P10), falling back to a direct select from `rooms`.
      * Room = host's browser runs `GraphServer` (as original). Two private channels: `room:<CODE>` host->all (ONLY host may write: guests can't forge host msgs) and `in:<CODE>` guest->host (ONLY host may read: guest secret keys stay private). Guest address = sha256(key)[0:16]. SQL policies updated + tested accordingly (`npm run test:db`, 25 checks).
      * Keepalive/drop mirror Java (5 s ping / 30 s drop); host token-bucket rate limit (40 msg/s, burst 60); host heartbeat updates the room row every 15 s; closing the room kicks guests + deletes the row; computer players run on the browser that added them.
      * Tests `test/online.test.ts` (20) use an in-memory Supabase fake (`test/fakes.ts`) enforcing the same access rules. Mutation-checked (rate limit, drop timer, addressing). Whole suite: 109 pass.
      * NOT verified (needs a live Supabase project): (a) how real Realtime treats a guest joining write-only `in:<CODE>` (code tolerates join failure and relies on supabase-js HTTP broadcast fallback), (b) private-channel auth with anonymous users, (c) real latency/rate limits (free tier msg/s caps), (d) host tab backgrounded => browser timer throttling could stall turn timers/keepalives.
      * Known limitation: guests are authenticated to the host only by their secret key; a guest could still cheat by modified client (as in the Java original), host is trusted like the old room server.
- [x] P10 DONE Vercel API + Upstash cache-aside (see "P10 details" below)
- [x] P11 DONE AI in a Web Worker, benchmarks, touch check (see "P11 details")
- [x] P12 DONE README, CSP, security scan (see "P12 details"). ALL ROADMAP POINTS DONE; remaining work = first live deploy checklist below

NOTE: on 2026-10-24 I (Claude) overwrote the previous PROGRESS.md by mistake before reading it; this version was rebuilt from the code + a fresh audit. Dates of existing code: 2026-10-22/23.

## Status facts (verified 2026-10-24)
- `npx vitest run`: 109/109 pass (3 files). `npx tsc --noEmit`: clean. `vite build` OK (~68 kB JS).
- Offline game verified in real Chromium. Lobby verified ONLY with a fake net client (no backend yet).
- e2e caveat: AI player got named "10" because the chat field came first among visible inputs (test-script issue, not app). Default team on join is random, same as Java.
- Nothing yet verified against real Supabase/Upstash (no credentials available in this sandbox).

## FEATURE INVENTORY (from Java source)
### Core game
- Arena 770x450 px = 50x30 game units (x∈[-25,25], y∈[-15,15]); canvas stage 800x600; bg RGB(158,215,155).
- Two teams (1 left, 2 right; team 2 view is mirrored). Max 10 players, 4 soldiers/player, default 2 soldiers.
- Terrain: ~N(15,7) black circles, radius ~N(40,25) (neg re-rolled); destroyed by explosion r=12.
- Soldiers placed per team half, ≥20px box apart, outside circles+15px. Soldier radius 7.
- Turn order alternates teams (reorderPlayers, random first team); random start player; turn time 60s; next-turn delay 3s after impact.
- 3 modes: NORMAL y=f(x)+c ; FST_ODE y'=f(x,y) via RK4 ; SND_ODE y''=f(x,y,y') RK4, angle set with Up/Down (accelerating, ±90°).
- Shot: sampled at adaptive step (max 20000 steps, 0.01 base), starts at soldier edge along tangent angle; hits all soldiers within r=7 (friendly fire included, shooter's own soldier excluded); stops on terrain/out-of-bounds/NaN/Inf; explosion at end.
- Draw speed 1500 steps/s; function fades 1s; soldier death anim; win = one team has no soldiers; "X won the game".
- Parser: x, y, y', + - * / ^, sqrt log(ln10) ln abs sin(sen) cos tan(tg) exp e pi; implicit multiplication; "," as decimal; unary minus; case-insens.
- Malformed function => rejected. Chat commands: -skip, -sayfunc, -stopsayfunc, -shownext, -stopshownext.
- Live function preview of the shooter shown to others; angle sync.
### Players/AI
- Local players (hotseat, name ≤20), computer players (level = generations, "Over 9000" mode, random names list), genetic algorithm (50 funcs, 5 kept, 25 mutated, rest crossover; fitness: +2e6 enemy hit, -2e6 friendly, else closeness).
- Pre-game: team switch arrows, add/remove soldier (X), ready toggle, mode buttons, chat, 5s countdown, leader role (transfer on leave), everyone-ready start.
### Online (original used 3 raw-TCP Java servers: Global/Room/Graph)
- Global lobby: online players list, room list (name, #players, mode), global chat, create room, join room, back.
- Direct IP/port join & host a local server  -> NOT portable to browsers (see decisions).
### Assets: ~94 PNGs (buttons w/ Over states + masks, backgrounds, soldiers+anims, explosions) + layout .txt files, monkey.au sound (unused in code paths seen).
### Android-APK-only (Graphwar II wrapper): Play Billing, AdMob, MediaStore -> NOT part of the open-source base; not ported.

## MIGRATION PLAN / DECISIONS
| Original | Web replacement |
|---|---|
| Swing panels + sprite PNG buttons | DOM/canvas stage 800x600 scaled to viewport, same PNGs (public/rsc) |
| Java threads/timers | requestAnimationFrame loop; AI in Web Worker |
| BufferedImage terrain + getRGB collision | Canvas for display + Uint8Array mask for collision (faster, testable in Node) |
| java.util.Random | seeded PRNG (mulberry32) -> start state = tiny seed message, reproducible tests |
| Global/Room/Graph TCP servers | Supabase Realtime broadcast+presence per room; rooms table in Postgres; host client = leader. All clients simulate deterministically (same as original: server only relays start state + fire msgs) |
| Raw IP:port join, local server | Dropped (browser can't open raw TCP); replaced by room codes. Documented. |
| Names only, no accounts | Supabase anonymous auth (guest) so RLS can bind rows to auth.uid() |
| Room list polling | Vercel fn /api/rooms w/ Upstash cache-aside (TTL 5s; no invalidate-on-write because browsers write to Supabase directly, TTL bounds staleness; cron purges), fallback to Supabase |
| Mobile | touch: on-screen function field, Up/Down angle buttons (new, needed for phones) |
- Not inventing features: no leaderboards/accounts/payments/ads.
- Security: service-role + Redis creds only in Vercel env (server fns); client gets only anon key; RLS on all tables; cache keys never include per-user data (room list is public data).
- Honest limits: cannot test against live Supabase/Upstash here (no credentials). Will test SQL on local Postgres, and API logic with local redis-server + mocks; will state exactly what was/wasn't tested.

## Environment notes
Node 22, npm OK (registry reachable), local postgres 16 + redis-server + java present, Playwright+Chromium at /opt/pw-browsers.

## P10 details (Vercel API + Upstash)
- `api/rooms.ts` GET: Bearer Supabase access token verified locally with `jose` (JWKS for signing-key projects; HS256 if `SUPABASE_JWT_SECRET` set; issuer/audience/role checked). Cache keys `rooms:v1` (5 s), `rooms:v1:stale` (60 s), `rooms:v1:lock` (3 s NX, stampede guard). Same public list for everyone, no user data in keys/values. Redis calls time-limited (800 ms) -> Redis failure = serve from DB (`X-Cache: bypass`); DB failure = stale copy or 503. Cached data is re-sanitised on read.
- `api/cron/cleanup.ts`: `CRON_SECRET` bearer (constant-time), calls `cleanup_stale_rooms` RPC, purges cache keys. `vercel.json` cron is daily (`0 3 * * *`, Hobby limit); rooms are hidden by RLS after 2 min anyway, cleanup only reclaims rows.
- Client: `OnlineClient` uses `/api/rooms` first, falls back to direct Supabase select on network error / non-200 / malformed body.
- Tests: `test/api.test.ts` (23) against a REAL `redis-server` via an Upstash-REST shim (`test/redis-shim.ts`) and the real `@upstash/redis` client; Supabase mocked. 8 deliberate mutants all caught. Full suite 132 tests green (repeated runs); build OK.
- NOT tested: live Upstash, live Supabase, real Vercel runtime/cron, JWKS fetch over the network (local JWKS used), `npm run test:db` not re-run (no SQL changed in P10). `api/rooms.ts` / `api/cron/cleanup.ts` thin adapters are only typechecked, not executed on Vercel. Perf numbers for cached vs direct polling still to measure in P11.
- `.env.example` has `SUPABASE_JWT_SECRET` (optional) and `CRON_SECRET`.

## P11 details (Worker AI, performance, touch)
- Code: `src/core/ai-engine.ts` (snapshot -> brain, runs inside the worker, unit-testable), `ai-worker.ts` (entry), `ai-host.ts` (`AiLink`, `WorkerBrain`, `createBrain`). `ComputerBrain` now depends on the small `AiView` interface (GameData satisfies it). The world is frozen during the AI's turn, so one snapshot per turn is enough; the evolved population persists in the worker between turns.
- Safety: answers carry a per-think token and are dropped if stale, after `stop()`, after the game ended, or if it is no longer that player's turn. If the Worker cannot be created or errors, brains fall back to the in-thread `ComputerBrain`. A seeded RNG (all tests) or `?ai=main` in the URL forces the in-thread path (debug/benchmark switch).
- Tests: `test/ai-worker.test.ts` (9): worker engine finds the *identical* shot to the in-thread brain for the same seed on 3 terrains (incl. replayed explosions), cloneable snapshot, stale/stop/ended-game/old-token drops, fallback. 5 mutants checked (2 initially survived -> tests strengthened -> caught). Full suite 141 green twice; production build emits `ai-worker-*.js` and a headless run showed the worker running with no console errors.
- Measurements (this sandbox, software-rendered headless Chromium, so compare only relatively; `scripts/bench-ai-browser.mjs`, dev server, level 300, 25 s windows, 3 runs each, same build with `?ai=main` as "before"):
  * main-thread stall (setInterval 4 ms gaps), p99: worker 6.0 / 8.5 / 10.8 ms vs in-thread 10.1 / 12.9 / 15.7 ms; max gap: worker 15 / 19 / 32 ms vs in-thread 27 / 26 / 33 ms. Earlier single runs saw in-thread outliers of 105-197 ms (one 148 ms long task) that did not reproduce in the 3-run set. Conclusion: worker gives a modest, noisy improvement; the old 10 ms time-slicing was already smooth on this machine. Real phones were NOT measured.
  * `npm run bench` (Node): one AI generation ~14-17 ms CPU; whole turn ~0.14 s (level 10), ~1.6 s (100), ~5.2 s (300) of CPU, which now sits off the UI thread.
  * Room list (100 clients x 5 polls, mock DB 40 ms latency, real Redis): 500 database reads direct vs 5 via the cache (100x fewer). Latency is NOT better with a mock DB (median 116 ms vs 40 ms under 100 concurrent in-process requests); the win is database load. No live-network latency was measured.
- Touch (`scripts/e2e-touch.mjs`, emulated 844x390 touch phone, dev server): coarse pointer detected, stage fits with no horizontal scroll, create/add-PC/ready by tap, touch bar (23 buttons) does not overlap the stage, keypad inserts text, backspace works, angle buttons tap without errors, Fire by tap sends the function. All passed; screenshots viewed. NOT tested: real devices, holding an angle button in 2nd-order mode, iOS Safari.
- Known touch caveat (not changed, to avoid inventing UI): the keypad has no digit keys, so numbers need the soft keyboard, which covers much of a landscape phone screen. Candidate for a later polish pass.

## P12 details (README, security review)
- Scan results: no server-only variable name appears anywhere in `src/`, `dist/` or `index.html`; `src/` never imports `api/`; browser reads only `VITE_SUPABASE_URL/ANON_KEY`; no `innerHTML`/`eval`/`new Function`; `.env*` git-ignored (only `.env.example`); `npm audit --omit=dev`: 0 vulnerabilities.
- Added Content-Security-Policy (+ nosniff, referrer policy, X-Frame-Options) in `vercel.json`; `vite preview` serves the same headers (`vite.config.ts` reads vercel.json). Offline game with the worker AI ran under this CSP in headless Chromium with zero console errors. NOT tested: CSP with a live Supabase (wss connections); custom Supabase domains need `connect-src` edited.
- README written (run, architecture, deploy steps, env table, security notes, honest status).

## First live deploy checklist (nothing below has been done or tested)
1. Supabase: enable anonymous sign-ins; apply the migration; confirm `anon` cannot read `rooms` and an anonymous user can.
2. Check private Realtime channels work for anonymous users (`lobby`, `room:CODE`, `in:CODE`), including the write-only `in:CODE` guest join (relies on supabase-js HTTP fallback).
3. Vercel: set env vars, deploy, `curl /api/rooms` without token = 401, with an anonymous user's token = 200 and `X-Cache: miss` then `hit`; confirm Upstash shows keys `rooms:v1*`.
4. Trigger `/api/cron/cleanup` with the secret once; check wrong secret = 401.
5. Two real browsers (ideally one phone): create/join a room, play a round; watch Realtime rate limits and host-tab throttling when the host tab is in the background.
6. Check Supabase anonymous-user growth / cleanup policy.
7. Re-run `npm run test:db` (needs a scratch Postgres) if the SQL is ever edited.
- Test note: the 50-concurrent-request test flaked twice under CPU load (waiters give up after 1 s and read the DB themselves, which is by design); the test now allows waiters 8 s. Production waitMs stays 1 s.
