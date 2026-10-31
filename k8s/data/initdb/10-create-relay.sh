#!/bin/sh
# Postgres's first-start script (step 2.3): creates the app's own login "relay" and the
# database "relay" owned by it. "relay" is NOT a superuser: it can work in its own database,
# but can't create roles or databases, read the server's files or run programs on it.
#
# Runs ONCE: the postgres image starts it from /docker-entrypoint-initdb.d only on an empty
# volume, while a temporary server listens on the local socket only. Changing this file later
# changes nothing in an existing database.
# The same file runs on the laptop (mounted into the container) and in CI (2.6), so tests use
# the same login as production.
#
# The password never appears on a command line, in the output or in Postgres's log.
set -eu

# Stop with a clear message if the password is missing. Without this, psql's \getenv would
# silently leave :pw unset and the SQL would fail with a confusing error instead.
: "${RELAY_DB_PASSWORD:?RELAY_DB_PASSWORD is missing}"

# -X: ignore any .psqlrc (it could turn on echoing). ON_ERROR_STOP: stop at the first error.
# <<'SQL' (quoted): the shell changes nothing inside, so the SQL arrives exactly as written.
psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
-- Read the password from this process's environment into the psql variable "pw".
-- (psql -v pw=... would put it on the command line, where "ps" shows it.)
\getenv pw RELAY_DB_PASSWORD

-- If a statement below fails, Postgres would normally write its full text, password included,
-- to its log, which the deployer's pods/log right can read. "panic" = only statements that
-- crash the whole server get logged.
SET log_min_error_statement = panic;

-- The app's login, with the password from :'pw' (psql quotes it as a value, so a quote or a
-- semicolon in it can't change the SQL). The NO... flags are the defaults, written out.
CREATE ROLE relay WITH LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE DATABASE relay OWNER relay;

SQL

# Check that it worked, so a mistake fails loudly on the very first start, not later as a
# confusing login error in the API.
ok=$(psql -X -At --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c "
  select count(*) from pg_database d join pg_roles r on r.oid = d.datdba
  where d.datname = 'relay' and r.rolname = 'relay' and r.rolcanlogin and not r.rolsuper")
if [ "$ok" != 1 ]; then
  echo "10-create-relay.sh: the login or the database relay is missing or wrong" >&2
  exit 1
fi
echo "10-create-relay.sh: created the login relay and its database"
