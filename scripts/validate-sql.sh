#!/bin/sh
# Validate the PostgreSQL schema against a real server (uses the libpq PG* environment variables).
#   ./scripts/validate-sql.sh [database-name]
# Applies every migration twice (processes re-apply them on boot, so they must be idempotent),
# checks that no column can hold a secret value, and exercises the schema's safety constraints.
set -eu
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
DB_NAME="${1:-browser_fabric_validation_$$}"
createdb "$DB_NAME"
cleanup() { dropdb --if-exists "$DB_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
run_sql() { psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$DB_NAME" "$@" >/dev/null; }
for pass in 1 2; do
  for migration in deploy/postgres/*.sql; do run_sql --file "$migration"; done
done
count="$(psql --no-psqlrc --tuples-only --no-align --dbname "$DB_NAME" -c "SELECT count(*) FROM pg_tables WHERE schemaname='public'")"
[ "$count" -eq 23 ] || { echo "expected 23 Fabric tables, got $count" >&2; exit 1; }
if psql --no-psqlrc --tuples-only --no-align --dbname "$DB_NAME" -c "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND column_name ~ '(password|cookie|secret|token)' AND column_name !~ '(_ref$|_hash$|public_key|certificate|encryption)'" | grep -q .; then
  echo "secret-value-like columns found in Fabric schema" >&2
  exit 1
fi
run_sql <<'SQL'
DO $$
BEGIN
  -- The deployment-wide lease counter accepts MAX_ACTIVE_BROWSER_LEASES (8) and nothing above.
  UPDATE fabric_capacity SET active_browser_leases = 8 WHERE id = 1;
  BEGIN
    UPDATE fabric_capacity SET active_browser_leases = 9 WHERE id = 1;
    RAISE EXCEPTION 'fabric_capacity accepted more than eight active browser leases';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE fabric_capacity SET active_browser_leases = 0 WHERE id = 1;

  INSERT INTO fabric_projects(id, name) VALUES ('project_validation', 'Validation');
  INSERT INTO fabric_workers(id, certificate_fingerprint, endpoint, cdp_relay_endpoint, runtime_families, recipe_refs, capacity, cpu_milli, memory_mib, pids, shm_mib, temporary_storage_mib, health, last_heartbeat_at)
    VALUES ('worker_validation', 'fingerprint', 'https://worker.internal.example', 'http://fabric-browser-{leaseId}:9223', '{chrome}', '{recipe_chrome@1}', 4, 1000, 1024, 128, 512, 1024, 'healthy', now());
  BEGIN
    UPDATE fabric_workers SET capacity = 5 WHERE id = 'worker_validation';
    RAISE EXCEPTION 'fabric_workers accepted a capacity above four';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO fabric_workers(id, certificate_fingerprint, endpoint, cdp_relay_endpoint, runtime_families, recipe_refs, capacity, is_local, cpu_milli, memory_mib, pids, shm_mib, temporary_storage_mib, health, last_heartbeat_at)
      VALUES ('worker_local', 'fingerprint-local', 'https://local.internal.example', 'http://127.0.0.1:9223', '{chrome}', '{}', 2, true, 1000, 1024, 128, 512, 1024, 'healthy', now());
    RAISE EXCEPTION 'a federated local worker accepted more than one lease';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Every artifact, lease-bound input request and attempt hangs off a real session or job.
  INSERT INTO fabric_recipes(ref, family, version, immutable_hash, runtime, definition) VALUES ('recipe_chrome@1', 'chrome', 1, 'sha256:x', 'chrome', '{}');
  INSERT INTO fabric_egress_policies(ref, family, version, immutable_hash, definition) VALUES ('egress_direct@1', 'direct', 1, 'x', '{}');
  INSERT INTO fabric_artifact_policies(ref, retention_days, allowed_kinds) VALUES ('artifact-policy_standard-30-days@1', 30, '{screenshot}');
  INSERT INTO fabric_jobs(id, project_id, idempotency_key, recipe_ref, runtime, operation, lease_mode, egress_policy_ref, artifact_policy_ref, status, worker_id, expires_at)
    VALUES ('job_validation', 'project_validation', 'k', 'recipe_chrome@1', 'chrome', '{}', 'writer', 'egress_direct@1', 'artifact-policy_standard-30-days@1', 'running', 'worker_validation', now() + interval '1 hour');
  INSERT INTO fabric_browser_leases(id, job_id, project_id, worker_id, mode, status, expires_at)
    VALUES ('browser-lease_validation', 'job_validation', 'project_validation', 'worker_validation', 'writer', 'active', now() + interval '1 hour');
  BEGIN
    INSERT INTO fabric_browser_leases(id, job_id, project_id, worker_id, mode, status, expires_at)
      VALUES ('browser-lease_second', 'job_validation', 'project_validation', 'worker_validation', 'writer', 'active', now() + interval '1 hour');
    RAISE EXCEPTION 'a job accepted a second active lease';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  INSERT INTO fabric_artifacts(id, project_id, job_id, kind, object_key, sha256, mime_type, size_bytes, expires_at)
    VALUES ('artifact_shot', 'project_validation', 'job_validation', 'screenshot', 'screenshots/a', 'sha256:' || repeat('a', 64), 'image/png', 10, now() + interval '30 days');
  BEGIN
    INSERT INTO fabric_artifacts(id, project_id, kind, object_key, sha256, mime_type, size_bytes, expires_at)
      VALUES ('artifact_orphan', 'project_validation', 'screenshot', 'screenshots/b', 'sha256:' || repeat('a', 64), 'image/png', 10, now() + interval '30 days');
    RAISE EXCEPTION 'an ownerless artifact was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO fabric_artifacts(id, project_id, job_id, kind, object_key, sha256, mime_type, size_bytes, expires_at)
      VALUES ('artifact_kind', 'project_validation', 'job_validation', 'cookie_jar', 'jars/a', 'sha256:' || repeat('a', 64), 'application/json', 10, now() + interval '30 days');
    RAISE EXCEPTION 'an unknown artifact kind was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO fabric_ephemeral_input_requests(id, project_id, job_id, lease_id, field, field_type, status, expires_at)
    VALUES ('input_ok', 'project_validation', 'job_validation', 'browser-lease_validation', 'password', 'password', 'pending', now());
  BEGIN
    INSERT INTO fabric_ephemeral_input_requests(id, project_id, job_id, field, field_type, status, expires_at)
      VALUES ('input_no_lease', 'project_validation', 'job_validation', 'password', 'password', 'pending', now());
    RAISE EXCEPTION 'an input request without a lease was accepted';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO fabric_ephemeral_input_requests(id, project_id, job_id, lease_id, field, field_type, status, expires_at)
      VALUES ('input_unknown', 'project_validation', 'job_validation', 'browser-lease_validation', 'f', 'cookie_jar', 'pending', now());
    RAISE EXCEPTION 'an unknown input field type was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
SQL
echo "SQL validation passed ($count tables; idempotent re-apply, secret-free columns and safety constraints verified)"
