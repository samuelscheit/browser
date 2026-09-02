#!/bin/sh
set -eu
DB_NAME="${1:-browser_fabric_validation_$$}"
createdb "$DB_NAME"
cleanup() { dropdb --if-exists "$DB_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
for migration in deploy/postgres/*.sql; do
  psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$DB_NAME" --file "$migration" >/dev/null
done
count="$(psql --no-psqlrc --tuples-only --no-align --dbname "$DB_NAME" -c "SELECT count(*) FROM pg_tables WHERE schemaname='public'")"
[ "$count" -ge 22 ] || { echo "expected at least 22 Fabric tables, got $count" >&2; exit 1; }
if psql --no-psqlrc --tuples-only --no-align --dbname "$DB_NAME" -c "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND column_name ~ '(password|cookie|secret|token)' AND column_name !~ '(_ref$|_hash$|public_key|certificate|encryption)'" | grep -q .; then
  echo "secret-value-like columns found in Fabric schema" >&2
  exit 1
fi
echo "SQL validation passed ($count tables)"
