#!/bin/sh
# Applies the migrations to a scratch database on ANY Postgres 15+ and runs the RLS assertions.
# Needs standard libpq env vars (PGHOST, PGPORT, PGUSER, ...). Creates and drops database "graphwar_rls_test".
# Supabase-provided objects (auth.uid(), roles, realtime.messages) are stubbed by 00_stubs.sql.
set -eu
cd "$(dirname "$0")/../.."
DB=graphwar_rls_test
psql -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
trap 'psql -q -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
export PGDATABASE=$DB PGOPTIONS='--client-min-messages=notice'
psql -q -v ON_ERROR_STOP=1 -f supabase/tests/00_stubs.sql
for f in supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -f "$f"; done
psql -q -t -A -v ON_ERROR_STOP=1 -f supabase/tests/10_rls_tests.sql 2>&1 | grep -E "NOTICE|FAIL|ERROR|PASSED" | sed -E 's/^psql:[^ ]+ NOTICE:  //'
