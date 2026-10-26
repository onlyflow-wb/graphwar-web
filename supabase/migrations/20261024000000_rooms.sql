-- Graphwar web: public room directory + realtime channel access rules.
--
-- Design (mirrors the original Java GlobalServer):
--   * Room list  = rows in public.rooms. The HOST's browser is the game server (as the room creator's PC was
--     in the original), so the host owns and heartbeats its own row. Nobody else can change it.
--   * Players / chat / game messages are NOT stored: they travel over Supabase Realtime (presence + broadcast),
--     exactly like the original which kept no database. Access to those channels is gated by the
--     realtime.messages policies at the bottom.
--   * Users are Supabase *anonymous* auth users (role `authenticated`); the `anon` role gets nothing.
--   * Server-side code (Vercel functions) uses the service role, which bypasses RLS; it is never sent to browsers.

create schema if not exists extensions;

-- ---------------------------------------------------------------- room codes
-- 5 chars from an unambiguous alphabet (no 0/O/1/I). ~33M combinations; collisions are retried.
create or replace function public.gen_room_code() returns text
language plpgsql volatile
set search_path = public
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
begin
  loop
    candidate := '';
    for i in 1..5 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.rooms where code = candidate);
  end loop;
  return candidate;
end;
$$;

-- ---------------------------------------------------------------- rooms
create table public.rooms (
  code        text primary key default public.gen_room_code(),
  host_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null,
  mode        smallint not null default 0,         -- 0: y=f(x)  1: y'=f(x,y)  2: y''=f(x,y,y')
  players     smallint not null default 0,         -- original limit: 10 players per room
  state       text not null default 'waiting',     -- 'waiting' (joinable) | 'playing' (original closed the socket)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),  -- heartbeat: host updates it while the room is open

  constraint rooms_code_format  check (code ~ '^[A-Z0-9]{4,8}$'),
  constraint rooms_name_length  check (char_length(name) between 1 and 20),   -- original: names <= 20 chars
  constraint rooms_name_trimmed check (name = btrim(name)),
  constraint rooms_mode_range   check (mode between 0 and 2),
  constraint rooms_players_rng  check (players between 0 and 10),
  constraint rooms_state_values check (state in ('waiting', 'playing')),
  constraint rooms_one_per_host unique (host_id)   -- a host runs one room at a time (anti-spam)
);

-- the room list query is "fresh rooms, newest first"
create index rooms_fresh_idx on public.rooms (updated_at desc);

-- every update counts as a heartbeat; code/host_id/created_at are additionally locked by column privileges
create or replace function public.rooms_touch() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger rooms_touch_trg before update on public.rooms
  for each row execute function public.rooms_touch();

-- ---------------------------------------------------------------- privileges (least privilege)
alter table public.rooms enable row level security;
alter table public.rooms force row level security;

revoke all on public.rooms from public, anon, authenticated;
grant select on public.rooms to authenticated;
-- only these columns can be written by a browser; code, host_id, created_at, updated_at are server-controlled
grant insert (name, mode)                 on public.rooms to authenticated;
grant update (name, mode, players, state) on public.rooms to authenticated;
grant delete                              on public.rooms to authenticated;

-- A room is visible while its host keeps heartbeating (stale rows are hidden even before cleanup runs).
create policy rooms_select_fresh on public.rooms
  for select to authenticated
  using (updated_at > now() - interval '2 minutes');

create policy rooms_insert_own on public.rooms
  for insert to authenticated
  with check (host_id = auth.uid());

create policy rooms_update_own on public.rooms
  for update to authenticated
  using (host_id = auth.uid())
  with check (host_id = auth.uid());

create policy rooms_delete_own on public.rooms
  for delete to authenticated
  using (host_id = auth.uid());

-- ---------------------------------------------------------------- housekeeping
-- Removes rooms whose host vanished (closed tab / lost connection). Called by a server-side job only.
create or replace function public.cleanup_stale_rooms(max_age interval default interval '5 minutes')
returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  removed integer;
begin
  delete from public.rooms where updated_at < now() - max_age;
  get diagnostics removed = row_count;
  return removed;
end;
$$;
revoke all on function public.cleanup_stale_rooms(interval) from public, anon, authenticated;
grant execute on function public.cleanup_stale_rooms(interval) to service_role;

-- ---------------------------------------------------------------- realtime channel authorization
-- Browsers must open PRIVATE channels (config: { private: true }). Topics used by the app:
--   'lobby'      global chat + online-player presence: any signed-in user.
--   'room:<CODE>' host -> everyone (S2C game messages). Anyone in the room may READ; only the HOST may WRITE,
--                so a guest can never forge "start game" / "fire" messages.
--   'in:<CODE>'   guest -> host (C2S requests). Anyone may WRITE; only the HOST may READ, so guests cannot
--                read each other's traffic (each guest authenticates to the host with a secret key sent only here).
-- A room topic is usable only while the room exists (and is fresh) in public.rooms.
create policy graphwar_realtime_read on realtime.messages
  for select to authenticated
  using (
    realtime.topic() = 'lobby'
    or exists (
      select 1 from public.rooms r
      where realtime.topic() = 'room:' || r.code
         or (realtime.topic() = 'in:' || r.code and r.host_id = auth.uid())
    )
  );

create policy graphwar_realtime_write on realtime.messages
  for insert to authenticated
  with check (
    realtime.topic() = 'lobby'
    or exists (
      select 1 from public.rooms r
      where realtime.topic() = 'in:' || r.code
         or (realtime.topic() = 'room:' || r.code and r.host_id = auth.uid())
    )
  );
