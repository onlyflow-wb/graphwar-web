-- Assertions for supabase/migrations/20261024000000_rooms.sql.  Run with ON_ERROR_STOP: any failed check aborts.
\set ON_ERROR_STOP on
\set QUIET on

create function pg_temp.as_user(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, false);
  execute 'set role authenticated';
end $$;

create function pg_temp.expect_fail(sql text, needle text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    if position(lower(needle) in lower(sqlerrm)) = 0 then
      raise exception 'FAIL: "%" failed with wrong error: %', sql, sqlerrm;
    end if;
    return;
  end;
  raise exception 'FAIL: expected error containing "%" but statement succeeded: %', needle, sql;
end $$;

create function pg_temp.check_(ok boolean, what text) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAIL: %', what; end if;
  raise notice 'ok   %', what;
end $$;

insert into auth.users (id) values
  ('aaaaaaaa-0000-0000-0000-000000000001'), ('bbbbbbbb-0000-0000-0000-000000000002');
grant execute on all functions in schema pg_temp to public;

-- ---------------------------------------------------------------- anon role has no access at all
set role anon;
select pg_temp.expect_fail('select * from public.rooms', 'permission denied');
select pg_temp.expect_fail($q$insert into public.rooms (name) values ('x')$q$, 'permission denied');
reset role;
select pg_temp.check_(true, 'anon role is denied select/insert');

-- ---------------------------------------------------------------- host A creates a room
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
insert into public.rooms (name, mode) values ('Alice room', 1);
select pg_temp.check_((select code ~ '^[A-HJ-NP-Z2-9]{5}$' and host_id = 'aaaaaaaa-0000-0000-0000-000000000001' and players = 0 and state = 'waiting'
                       from public.rooms), 'insert: code generated server-side, host_id = auth.uid(), defaults applied');
select pg_temp.expect_fail($q$insert into public.rooms (name) values ('second')$q$, 'rooms_one_per_host');
select pg_temp.expect_fail($q$insert into public.rooms (name, host_id) values ('spoof', 'bbbbbbbb-0000-0000-0000-000000000002')$q$, 'permission denied');
select pg_temp.expect_fail($q$insert into public.rooms (name, code) values ('spoof', 'AAAAA')$q$, 'permission denied');
select pg_temp.check_(true, 'insert: one room per host, cannot set host_id or code');

-- ---------------------------------------------------------------- host can update the allowed columns only
update public.rooms set players = 3, mode = 2, state = 'playing', name = 'Renamed';
select pg_temp.check_((select players = 3 and mode = 2 and state = 'playing' and name = 'Renamed' from public.rooms), 'host updates name/mode/players/state');
select pg_temp.expect_fail($q$update public.rooms set code = 'ZZZZZ'$q$, 'permission denied');
select pg_temp.expect_fail($q$update public.rooms set host_id = 'bbbbbbbb-0000-0000-0000-000000000002'$q$, 'permission denied');
select pg_temp.expect_fail($q$update public.rooms set updated_at = now() + interval '1 year'$q$, 'permission denied');
select pg_temp.check_(true, 'host cannot touch code / host_id / updated_at');

-- ---------------------------------------------------------------- constraints
select pg_temp.expect_fail($q$update public.rooms set mode = 3$q$, 'rooms_mode_range');
select pg_temp.expect_fail($q$update public.rooms set players = 11$q$, 'rooms_players_rng');
select pg_temp.expect_fail($q$update public.rooms set players = -1$q$, 'rooms_players_rng');
select pg_temp.expect_fail($q$update public.rooms set state = 'hacked'$q$, 'rooms_state_values');
select pg_temp.expect_fail($q$update public.rooms set name = ''$q$, 'rooms_name_length');
select pg_temp.expect_fail($q$update public.rooms set name = repeat('x', 21)$q$, 'rooms_name_length');
select pg_temp.expect_fail($q$update public.rooms set name = ' padded '$q$, 'rooms_name_trimmed');
select pg_temp.check_(true, 'constraints reject bad mode/players/state/name');
update public.rooms set state = 'waiting', players = 1, name = 'Alice room';

-- ---------------------------------------------------------------- user B: can read, cannot modify
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
select pg_temp.check_((select count(*) = 1 from public.rooms), 'other signed-in users can list rooms');
with u as (update public.rooms set players = 9 returning 1) select pg_temp.check_((select count(*) = 0 from u), 'other user cannot update host''s room (0 rows)');
with d as (delete from public.rooms returning 1) select pg_temp.check_((select count(*) = 0 from d), 'other user cannot delete host''s room (0 rows)');
select pg_temp.expect_fail($q$insert into public.rooms (name) values ('b room'), ('b room 2')$q$, 'rooms_one_per_host');
insert into public.rooms (name) values ('Bob room');
select pg_temp.check_((select count(*) = 2 from public.rooms), 'B can host its own room; both visible');
select pg_temp.expect_fail($q$select public.cleanup_stale_rooms()$q$, 'permission denied');
select pg_temp.check_(true, 'browsers cannot run cleanup_stale_rooms');

-- ---------------------------------------------------------------- stale rooms are hidden, then cleaned by service role
reset role;
set session_replication_role = replica;   -- bypass heartbeat trigger so we can fake an old heartbeat
update public.rooms set updated_at = now() - interval '3 minutes' where name = 'Alice room';
set session_replication_role = origin;
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
select pg_temp.check_((select count(*) = 1 and bool_and(name = 'Bob room') from public.rooms), 'room with heartbeat older than 2 min is hidden');
reset role;
set role service_role;
select pg_temp.check_(public.cleanup_stale_rooms(interval '5 minutes') = 0, 'cleanup keeps rooms younger than max_age');
reset role;
set session_replication_role = replica;
update public.rooms set updated_at = now() - interval '10 minutes' where name = 'Alice room';
set session_replication_role = origin;
set role service_role;
select pg_temp.check_(public.cleanup_stale_rooms(interval '5 minutes') = 1, 'service_role cleanup deletes the stale room');
reset role;
select pg_temp.check_((select count(*) = 1 from public.rooms), 'only the live room remains');

-- heartbeat: any update refreshes updated_at
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
reset role;
set session_replication_role = replica;
update public.rooms set updated_at = now() - interval '100 seconds';
set session_replication_role = origin;
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
update public.rooms set players = 2;
select pg_temp.check_((select updated_at > now() - interval '5 seconds' from public.rooms), 'update acts as heartbeat');

-- ---------------------------------------------------------------- code generation avoids collisions
reset role;
select pg_temp.check_((select count(distinct public.gen_room_code()) from generate_series(1, 2000)) > 1990, 'gen_room_code gives (practically) unique codes');

-- ---------------------------------------------------------------- realtime channel policies
-- Bob hosts a room (see above); Alice (a different user) is a guest of it.
reset role;
select set_config('test.code', (select code from public.rooms where name = 'Bob room'), false);
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');   -- Bob = host
select set_config('realtime.topic', 'lobby', false);
insert into realtime.messages (topic) values ('lobby');
select pg_temp.check_((select count(*) = 1 from realtime.messages), 'signed-in user can use the lobby channel');
select set_config('realtime.topic', 'room:' || current_setting('test.code'), false);
insert into realtime.messages (topic, payload) values ('room:' || current_setting('test.code'), '{"from":"host"}');
select pg_temp.check_(true, 'host can write host->all topic room:CODE');
select set_config('realtime.topic', 'in:' || current_setting('test.code'), false);
insert into realtime.messages (topic, payload) values ('in:' || current_setting('test.code'), '{"from":"bob"}');
select pg_temp.check_((select count(*) >= 1 from realtime.messages where topic like 'in:%'), 'host can read guest->host topic in:CODE');

reset role;
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');   -- Alice = guest
select set_config('realtime.topic', 'room:' || current_setting('test.code'), false);
select pg_temp.check_(true, 'guest context ready');
select pg_temp.expect_fail($q$insert into realtime.messages (topic) values ('room:' || current_setting('test.code'))$q$, 'row-level security');
select pg_temp.check_(true, 'guest CANNOT write room:CODE (cannot forge host messages)');
select pg_temp.check_((select count(*) >= 1 from realtime.messages where topic = 'room:' || current_setting('test.code')), 'guest can read room:CODE');
select set_config('realtime.topic', 'in:' || current_setting('test.code'), false);
insert into realtime.messages (topic, payload) values ('in:' || current_setting('test.code'), '{"from":"alice"}');
select pg_temp.check_(true, 'guest can write in:CODE');
select pg_temp.check_((select count(*) = 0 from realtime.messages where topic = 'in:' || current_setting('test.code')), 'guest CANNOT read in:CODE (cannot see other guests)');

select set_config('realtime.topic', 'room:NOPE1', false);
select pg_temp.expect_fail($q$insert into realtime.messages (topic) values ('x')$q$, 'row-level security');
select set_config('realtime.topic', 'in:NOPE1', false);
select pg_temp.expect_fail($q$insert into realtime.messages (topic) values ('x')$q$, 'row-level security');
select set_config('realtime.topic', 'something-else', false);
select pg_temp.expect_fail($q$insert into realtime.messages (topic) values ('x')$q$, 'row-level security');
reset role;
set role anon;
select pg_temp.expect_fail($q$insert into realtime.messages (topic) values ('lobby')$q$, 'permission denied');
reset role;
select pg_temp.check_(true, 'unknown rooms/topics and the anon role are blocked on realtime.messages');

\echo ALL RLS CHECKS PASSED
