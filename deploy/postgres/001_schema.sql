-- Browser Fabric control-plane schema (PostgreSQL 15+).
-- Every process applies this file on boot, so each statement is idempotent. A schema change adds a
-- new numbered file next to it (applied in lexical order) rather than editing a released one.
-- Deliberately contains no columns for cookie/password/proxy/OTP/CAPTCHA secret bytes.
BEGIN;

CREATE TABLE IF NOT EXISTS fabric_projects (
  id text PRIMARY KEY CHECK (id ~ '^project_[A-Za-z0-9_-]+$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fabric_principals (
  id text PRIMARY KEY CHECK (id ~ '^principal_[A-Za-z0-9_-]+$'),
  display_name text NOT NULL,
  certificate_fingerprint text NOT NULL UNIQUE,
  roles text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fabric_principal_projects (
  principal_id text NOT NULL REFERENCES fabric_principals(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES fabric_projects(id) ON DELETE CASCADE,
  PRIMARY KEY (principal_id, project_id)
);
CREATE TABLE IF NOT EXISTS fabric_workers (
  id text PRIMARY KEY CHECK (id ~ '^worker_[A-Za-z0-9_-]+$'),
  certificate_fingerprint text NOT NULL UNIQUE,
  enrollment_token_hash text,
  input_encryption_public_key_pem text,
  endpoint text NOT NULL,
  cdp_relay_endpoint text NOT NULL,
  runtime_families text[] NOT NULL,
  recipe_refs text[] NOT NULL,
  browser_versions jsonb NOT NULL DEFAULT '{}',
  supported_profile_families text[] NOT NULL DEFAULT '{}',
  supports_interactive boolean NOT NULL DEFAULT false,
  capacity integer NOT NULL CHECK (capacity BETWEEN 0 AND 4),
  active_leases integer NOT NULL DEFAULT 0 CHECK (active_leases >= 0),
  is_local boolean NOT NULL DEFAULT false,
  volume_names text[] NOT NULL DEFAULT '{}',
  cpu_milli integer NOT NULL CHECK (cpu_milli > 0),
  memory_mib integer NOT NULL CHECK (memory_mib > 0),
  pids integer NOT NULL CHECK (pids > 0),
  shm_mib integer NOT NULL CHECK (shm_mib > 0),
  temporary_storage_mib integer NOT NULL CHECK (temporary_storage_mib > 0),
  health text NOT NULL CHECK (health IN ('healthy','degraded','offline','draining')),
  last_heartbeat_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_local OR capacity <= 1)
);
CREATE TABLE IF NOT EXISTS fabric_recipes (
  ref text PRIMARY KEY CHECK (ref ~ '^recipe_[A-Za-z0-9_-]+@\d+$'),
  family text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  immutable_hash text NOT NULL,
  runtime text NOT NULL,
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family, version),
  UNIQUE (ref, immutable_hash)
);
CREATE TABLE IF NOT EXISTS fabric_egress_policies (
  ref text PRIMARY KEY CHECK (ref ~ '^egress_[A-Za-z0-9_-]+@?\d*$'),
  family text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  immutable_hash text NOT NULL,
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family, version)
);
CREATE TABLE IF NOT EXISTS fabric_challenge_handler_sets (
  ref text PRIMARY KEY,
  family text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  immutable_hash text NOT NULL,
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family, version)
);
CREATE TABLE IF NOT EXISTS fabric_artifact_policies (
  ref text PRIMARY KEY,
  retention_days integer NOT NULL CHECK (retention_days = 30),
  allowed_kinds text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fabric_profiles (
  ref text PRIMARY KEY CHECK (ref ~ '^profile_[A-Za-z0-9_-]+$'),
  owner_project_id text NOT NULL REFERENCES fabric_projects(id),
  worker_id text NOT NULL REFERENCES fabric_workers(id),
  volume_name text NOT NULL,
  profile_family text NOT NULL,
  volume_generation integer NOT NULL CHECK (volume_generation > 0),
  status text NOT NULL CHECK (status IN ('active','unhealthy','relocating','revoked')),
  last_health_check_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(worker_id, volume_name)
);
CREATE TABLE IF NOT EXISTS fabric_profile_grants (
  profile_ref text NOT NULL REFERENCES fabric_profiles(ref) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES fabric_projects(id) ON DELETE CASCADE,
  granted_by text NOT NULL REFERENCES fabric_principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_ref, project_id)
);
CREATE TABLE IF NOT EXISTS fabric_volume_generations (
  id text PRIMARY KEY,
  profile_ref text NOT NULL REFERENCES fabric_profiles(ref) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation > 0),
  worker_id text NOT NULL REFERENCES fabric_workers(id),
  volume_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','relocating','retired')),
  checksum text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(profile_ref, generation)
);
CREATE TABLE IF NOT EXISTS fabric_browser_sessions (
  id text PRIMARY KEY CHECK (id ~ '^browser-session_[A-Za-z0-9_-]+$'),
  project_id text NOT NULL REFERENCES fabric_projects(id),
  idempotency_key text NOT NULL,
  runtime text NOT NULL,
  browser_recipe_ref text NOT NULL REFERENCES fabric_recipes(ref),
  profile_ref text REFERENCES fabric_profiles(ref),
  lease_mode text NOT NULL CHECK (lease_mode IN ('writer','interactive','clone')),
  egress_policy_ref text NOT NULL REFERENCES fabric_egress_policies(ref),
  artifact_policy_ref text NOT NULL REFERENCES fabric_artifact_policies(ref),
  metadata jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('queued','allocating','ready','active','releasing','released','cancelled','failed','timed_out')),
  queue_sequence bigint NOT NULL DEFAULT 0,
  worker_id text REFERENCES fabric_workers(id),
  lease_id text,
  -- cdp_endpoint is a short-lived capability URL; internal endpoint remains worker-only.
  cdp_endpoint text,
  cdp_capability_expires_at timestamptz,
  max_external_connections integer NOT NULL DEFAULT 1 CHECK (max_external_connections BETWEEN 1 AND 8),
  external_connection_count integer NOT NULL DEFAULT 0 CHECK (external_connection_count BETWEEN 0 AND max_external_connections),
  reconnect_grace_until timestamptz,
  expires_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  failure_reason text,
  UNIQUE(project_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS fabric_jobs (
  id text PRIMARY KEY CHECK (id ~ '^job_[A-Za-z0-9_-]+$'),
  project_id text NOT NULL REFERENCES fabric_projects(id),
  idempotency_key text NOT NULL,
  recipe_ref text NOT NULL REFERENCES fabric_recipes(ref),
  runtime text NOT NULL,
  operation jsonb NOT NULL,
  profile_ref text REFERENCES fabric_profiles(ref),
  lease_mode text NOT NULL CHECK (lease_mode IN ('writer','interactive','clone')),
  egress_policy_ref text NOT NULL REFERENCES fabric_egress_policies(ref),
  artifact_policy_ref text NOT NULL REFERENCES fabric_artifact_policies(ref),
  callback_url text,
  callback_secret_ref text,
  metadata jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('queued','running','awaiting_input','awaiting_manual','succeeded','failed','blocked_challenge','auth_required','timed_out','cancelled')),
  queue_sequence bigint NOT NULL DEFAULT 0,
  worker_id text REFERENCES fabric_workers(id),
  lease_id text,
  result jsonb,
  failure_reason text,
  assignment_claimed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS fabric_browser_leases (
  id text PRIMARY KEY CHECK (id ~ '^browser-lease_[A-Za-z0-9_-]+$'),
  session_id text REFERENCES fabric_browser_sessions(id) ON DELETE CASCADE,
  job_id text REFERENCES fabric_jobs(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES fabric_projects(id),
  profile_ref text REFERENCES fabric_profiles(ref),
  worker_id text NOT NULL REFERENCES fabric_workers(id),
  mode text NOT NULL CHECK (mode IN ('writer','interactive','clone')),
  clone_id text,
  status text NOT NULL CHECK (status IN ('active','releasing','released','lost')),
  expires_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  assignment_claimed_at timestamptz,
  started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CHECK ((session_id IS NOT NULL) <> (job_id IS NOT NULL))
);
-- A work item can receive another lease after an unclaimed allocation, process crash, or bounded
-- job retry. Historical released leases must remain auditable, while only one *active* lease may
-- exist for a session/job at any point.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_lease_per_session
  ON fabric_browser_leases(session_id)
  WHERE status = 'active' AND session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_lease_per_job
  ON fabric_browser_leases(job_id)
  WHERE status = 'active' AND job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_writer_per_profile
  ON fabric_browser_leases(profile_ref)
  WHERE status = 'active' AND mode IN ('writer','interactive') AND profile_ref IS NOT NULL;
CREATE TABLE IF NOT EXISTS fabric_profile_clones (
  id text PRIMARY KEY,
  source_profile_ref text NOT NULL REFERENCES fabric_profiles(ref),
  worker_id text NOT NULL REFERENCES fabric_workers(id),
  volume_name text NOT NULL UNIQUE,
  created_for_lease text NOT NULL UNIQUE REFERENCES fabric_browser_leases(id),
  status text NOT NULL CHECK (status IN ('creating','ready','destroying','destroyed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE IF NOT EXISTS fabric_job_attempts (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES fabric_jobs(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  worker_id text REFERENCES fabric_workers(id),
  lease_id text REFERENCES fabric_browser_leases(id),
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(job_id, attempt_number)
);
CREATE TABLE IF NOT EXISTS fabric_events (
  id text PRIMARY KEY,
  sequence bigint NOT NULL UNIQUE,
  project_id text REFERENCES fabric_projects(id),
  subject_kind text NOT NULL,
  subject_id text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fabric_events_subject_idx ON fabric_events(subject_kind, subject_id, sequence);
CREATE TABLE IF NOT EXISTS fabric_capacity (
  id integer PRIMARY KEY CHECK (id = 1),
  active_browser_leases integer NOT NULL DEFAULT 0 CHECK (active_browser_leases BETWEEN 0 AND 8),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fabric_capacity(id) VALUES (1) ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS fabric_artifacts (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES fabric_projects(id),
  session_id text REFERENCES fabric_browser_sessions(id) ON DELETE CASCADE,
  job_id text REFERENCES fabric_jobs(id) ON DELETE CASCADE,
  profile_ref text REFERENCES fabric_profiles(ref),
  kind text NOT NULL CONSTRAINT fabric_artifacts_kind_check CHECK (kind IN ('screenshot','mhtml','trace','har','download','video','log')),
  object_key text NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^sha256:[A-Fa-f0-9]{64}$'),
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT fabric_artifacts_owner_check CHECK ((session_id IS NOT NULL) <> (job_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS fabric_artifacts_expiry_idx ON fabric_artifacts(expires_at);
CREATE TABLE IF NOT EXISTS fabric_ephemeral_input_requests (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES fabric_projects(id),
  session_id text REFERENCES fabric_browser_sessions(id) ON DELETE CASCADE,
  job_id text REFERENCES fabric_jobs(id) ON DELETE CASCADE,
  lease_id text NOT NULL REFERENCES fabric_browser_leases(id) ON DELETE CASCADE,
  worker_id text REFERENCES fabric_workers(id),
  worker_input_encryption_public_key_pem text,
  field text NOT NULL CHECK (length(field) BETWEEN 1 AND 255),
  field_type text NOT NULL CHECK (field_type IN ('password','otp','captcha_provider_credential','proxy_credential','form_value')),
  status text NOT NULL CHECK (status IN ('pending','supplied','consumed','expired','cancelled')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK ((session_id IS NOT NULL) <> (job_id IS NOT NULL))
);
-- Values are intentionally absent; only the worker-memory vault may hold them.
CREATE TABLE IF NOT EXISTS fabric_idempotency (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES fabric_projects(id),
  scope text NOT NULL CHECK (scope IN ('browser_session','job')),
  key text NOT NULL,
  request_hash text NOT NULL,
  response_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, scope, key)
);
CREATE TABLE IF NOT EXISTS fabric_audit_events (
  id text PRIMARY KEY,
  actor_id text NOT NULL,
  project_id text REFERENCES fabric_projects(id),
  action text NOT NULL,
  target_kind text NOT NULL,
  target_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('allowed','denied','succeeded','failed')),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fabric_state_snapshots (
  sequence bigint PRIMARY KEY,
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION fabric_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS fabric_workers_touch ON fabric_workers;
CREATE TRIGGER fabric_workers_touch BEFORE UPDATE ON fabric_workers FOR EACH ROW EXECUTE FUNCTION fabric_touch_updated_at();
DROP TRIGGER IF EXISTS fabric_profiles_touch ON fabric_profiles;
CREATE TRIGGER fabric_profiles_touch BEFORE UPDATE ON fabric_profiles FOR EACH ROW EXECUTE FUNCTION fabric_touch_updated_at();
DROP TRIGGER IF EXISTS fabric_sessions_touch ON fabric_browser_sessions;
CREATE TRIGGER fabric_sessions_touch BEFORE UPDATE ON fabric_browser_sessions FOR EACH ROW EXECUTE FUNCTION fabric_touch_updated_at();
DROP TRIGGER IF EXISTS fabric_jobs_touch ON fabric_jobs;
CREATE TRIGGER fabric_jobs_touch BEFORE UPDATE ON fabric_jobs FOR EACH ROW EXECUTE FUNCTION fabric_touch_updated_at();

-- Dispatch and expiry indexes.
CREATE INDEX IF NOT EXISTS fabric_sessions_dispatch_idx ON fabric_browser_sessions(status, created_at);
CREATE INDEX IF NOT EXISTS fabric_jobs_dispatch_idx ON fabric_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS fabric_leases_expiry_idx ON fabric_browser_leases(status, expires_at);
CREATE INDEX IF NOT EXISTS fabric_workers_health_capacity_idx ON fabric_workers(health, active_leases, capacity);
CREATE INDEX IF NOT EXISTS fabric_inputs_expiry_idx ON fabric_ephemeral_input_requests(status, expires_at);
-- Database-side cleanup is a safety net; object storage lifecycle remains authoritative for bytes.
CREATE OR REPLACE FUNCTION fabric_delete_expired_artifact_rows() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE deleted_count integer;
BEGIN
  DELETE FROM fabric_artifacts WHERE expires_at <= now();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMIT;
