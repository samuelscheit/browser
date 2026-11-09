#!/bin/sh
set -eu
DB_NAME="${1:-browser_fabric_validation_$$}"
UPGRADE_DB_NAME="${DB_NAME}_upgrade"
createdb "$DB_NAME"
createdb "$UPGRADE_DB_NAME"
cleanup() {
  dropdb --if-exists "$DB_NAME" >/dev/null 2>&1 || true
  dropdb --if-exists "$UPGRADE_DB_NAME" >/dev/null 2>&1 || true
}
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

# Exercise upgrade-only constraints explicitly. Current fresh schema names both checks, whereas
# deployments created from the original 001 migration carried anonymous checks. Recreate that
# historical shape, then apply the forward-only migrations that replace it. This catches both the
# old anonymous media-artifact checks and the pre-playback input-request shape where a lease was
# mandatory and the allowed field-type check did not permit encrypted media sources.
psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$UPGRADE_DB_NAME" --file deploy/postgres/001_initial.sql >/dev/null
psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$UPGRADE_DB_NAME" <<'SQL' >/dev/null
ALTER TABLE fabric_artifacts DROP CONSTRAINT fabric_artifacts_kind_check;
ALTER TABLE fabric_artifacts ADD CHECK (kind IN ('screenshot','mhtml','trace','har','download','video','log'));
ALTER TABLE fabric_artifacts DROP CONSTRAINT fabric_artifacts_owner_check;
ALTER TABLE fabric_artifacts ADD CHECK ((session_id IS NOT NULL) <> (job_id IS NOT NULL));
ALTER TABLE fabric_workers DROP COLUMN media_playback_endpoint;
ALTER TABLE fabric_jobs DROP COLUMN media_playback_ready_at;
ALTER TABLE fabric_jobs DROP COLUMN media_playback_source_request_id;
ALTER TABLE fabric_ephemeral_input_requests DROP COLUMN media_attempt_id;
ALTER TABLE fabric_ephemeral_input_requests ALTER COLUMN lease_id SET NOT NULL;
DO $$
DECLARE legacy_constraint text;
BEGIN
  FOR legacy_constraint IN
    SELECT constraints.constraint_name
    FROM information_schema.table_constraints AS constraints
    JOIN pg_constraint AS pg_constraints ON pg_constraints.conname = constraints.constraint_name
    JOIN pg_class AS relation ON relation.oid = pg_constraints.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE constraints.table_schema = 'public'
      AND constraints.table_name = 'fabric_ephemeral_input_requests'
      AND constraints.constraint_type = 'CHECK'
      AND namespace.nspname = 'public'
      AND (
        pg_get_constraintdef(pg_constraints.oid) LIKE '%field_type%'
        OR pg_get_constraintdef(pg_constraints.oid) LIKE '%media_attempt_id%'
      )
  LOOP
    EXECUTE format('ALTER TABLE fabric_ephemeral_input_requests DROP CONSTRAINT %I', legacy_constraint);
  END LOOP;
END $$;
ALTER TABLE fabric_ephemeral_input_requests
  ADD CHECK (field_type IN ('password','otp','captcha_provider_credential','proxy_credential','form_value'));
SQL
for migration in deploy/postgres/006_media_manifest_artifacts.sql deploy/postgres/007_media_artifact_expiry.sql deploy/postgres/008_media_attempt_binding.sql deploy/postgres/009_project_scoped_media_manifests.sql deploy/postgres/010_media_playback_sessions.sql; do
  psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$UPGRADE_DB_NAME" --file "$migration" >/dev/null
done
psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$UPGRADE_DB_NAME" <<'SQL' >/dev/null
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'fabric_artifacts'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%media_manifest%'
  ) THEN
    RAISE EXCEPTION 'media_manifest artifact constraint was not installed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'fabric_workers' AND column_name = 'media_playback_endpoint'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'fabric_jobs' AND column_name = 'media_playback_ready_at'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'fabric_jobs' AND column_name = 'media_playback_source_request_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'fabric_ephemeral_input_requests' AND column_name = 'media_attempt_id'
  ) THEN
    RAISE EXCEPTION 'media playback upgrade columns were not installed';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'fabric_ephemeral_input_requests'
      AND column_name = 'lease_id'
      AND is_nullable <> 'YES'
  ) THEN
    RAISE EXCEPTION 'media playback input requests still require a browser lease';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'fabric_ephemeral_input_requests'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%media_playback_source%'
  ) THEN
    RAISE EXCEPTION 'media playback encrypted input constraint was not installed';
  END IF;
END $$;
SQL
# The deployment-wide lease counter originally carried an anonymous `BETWEEN 0 AND 4` check that
# CREATE TABLE IF NOT EXISTS never revisits. Recreate it, apply 012, and prove the raised bound
# holds (6 accepted, 9 rejected) on both a fresh and an upgraded schema.
psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$UPGRADE_DB_NAME" <<'SQL' >/dev/null
ALTER TABLE fabric_capacity DROP CONSTRAINT fabric_capacity_active_browser_leases_check;
ALTER TABLE fabric_capacity ADD CHECK (active_browser_leases BETWEEN 0 AND 4);
SQL
psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$UPGRADE_DB_NAME" --file deploy/postgres/012_browser_lease_capacity.sql >/dev/null
for database in "$DB_NAME" "$UPGRADE_DB_NAME"; do
  psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$database" <<'SQL' >/dev/null
DO $$
BEGIN
  UPDATE fabric_capacity SET active_browser_leases = 6 WHERE id = 1;
  BEGIN
    UPDATE fabric_capacity SET active_browser_leases = 9 WHERE id = 1;
    RAISE EXCEPTION 'fabric_capacity accepted more than eight active browser leases';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'fabric_capacity'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%active_browser_leases%') <> 1 THEN
    RAISE EXCEPTION 'fabric_capacity must carry exactly one lease-count check';
  END IF;
  UPDATE fabric_capacity SET active_browser_leases = 0 WHERE id = 1;
END $$;
SQL
done
echo "SQL validation passed ($count tables; legacy media-artifact, media-playback and lease-capacity upgrades verified)"
