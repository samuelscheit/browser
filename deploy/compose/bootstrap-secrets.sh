#!/usr/bin/env bash
# Generate the file-backed secret bundle and provisioning manifest consumed by compose.yml.
#
#   ./bootstrap-secrets.sh                       # principals from FABRIC_PRINCIPALS (default: admin)
#   FABRIC_PRINCIPALS="admin ci" ./bootstrap-secrets.sh
#
# Idempotent: every certificate, key, token and password is created only when it is missing, so a
# rerun never rotates an identity the database already trusts. The provisioning manifest is always
# rebuilt from the current files and the worker configs in workers/*/config/worker.json. Adding a
# principal is a rerun with a longer FABRIC_PRINCIPALS followed by `docker compose up -d`.
# Nothing here prints secret material. Requires openssl and jq.
set -euo pipefail

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly repo_dir="$(cd -- "$script_dir/../.." && pwd)"
readonly secrets_dir="${FABRIC_SECRETS_DIR:-$script_dir/secrets}"
readonly principals="${FABRIC_PRINCIPALS:-admin}"
readonly admin_principal="${FABRIC_ADMIN_PRINCIPAL:-admin}"
readonly default_project_id="${FABRIC_DEFAULT_PROJECT_ID:-project_default}"
readonly default_project_name="${FABRIC_DEFAULT_PROJECT_NAME:-Default}"

fail() {
  printf 'Browser Fabric secret bootstrap failed: %s\n' "$1" >&2
  exit 1
}

for command in openssl jq; do
  command -v "$command" >/dev/null || fail "required command is unavailable: $command"
done
[[ " $principals " == *" $admin_principal "* ]] || fail "FABRIC_PRINCIPALS must include the admin principal ($admin_principal)"
for name in $principals; do
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]] || fail "principal name '$name' is invalid"
done
[[ "$default_project_id" =~ ^project_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ ]] || fail "FABRIC_DEFAULT_PROJECT_ID is invalid"

umask 077
mkdir -p "$secrets_dir/principals" "$secrets_dir/.ca"
work_dir="$(mktemp -d "$secrets_dir/.work.XXXXXX")"
trap 'rm -rf -- "$work_dir"' EXIT

# Write a value only when the target does not exist yet.
missing() { [[ ! -s "$secrets_dir/$1" ]]; }
random_hex() { printf '%s' "$(openssl rand -hex 32)"; }
write_random() { missing "$1" && random_hex > "$secrets_dir/$1"; return 0; }

certificate_fingerprint() {
  openssl x509 -in "$1" -outform DER 2>/dev/null | openssl dgst -sha256 -r | awk '{print $1}'
}
sha256_file() { openssl dgst -sha256 -r "$1" | awk '{print $1}'; }

create_ca() {
  local name="$1" common_name="$2"
  [[ -s "$secrets_dir/.ca/$name.key" && -s "$secrets_dir/$name" ]] && return 0
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "$secrets_dir/.ca/$name.key" 2>/dev/null
  openssl req -x509 -new -sha256 -days 3650 -key "$secrets_dir/.ca/$name.key" -out "$secrets_dir/$name" \
    -subj "/CN=$common_name" \
    -addext 'basicConstraints=critical,CA:TRUE' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -addext 'subjectKeyIdentifier=hash' \
    -addext 'authorityKeyIdentifier=keyid:always' 2>/dev/null
}

# issue <ca> <cert-name> <key-name> <common-name> <server|client>
issue() {
  local ca="$1" cert="$2" key="$3" common_name="$4" usage="$5"
  [[ -s "$secrets_dir/$cert" && -s "$secrets_dir/$key" ]] && return 0
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$secrets_dir/$key" 2>/dev/null
  openssl req -new -key "$secrets_dir/$key" -out "$work_dir/$cert.csr" -subj "/CN=$common_name" 2>/dev/null
  {
    echo 'basicConstraints=critical,CA:FALSE'
    echo 'keyUsage=critical,digitalSignature,keyEncipherment'
    if [[ "$usage" == server ]]; then
      echo 'extendedKeyUsage=serverAuth'
      echo "subjectAltName=DNS:$common_name"
    else
      echo 'extendedKeyUsage=clientAuth'
    fi
  } > "$work_dir/$cert.ext"
  openssl x509 -req -in "$work_dir/$cert.csr" -CA "$secrets_dir/$ca" -CAkey "$secrets_dir/.ca/$ca.key" -CAserial "$secrets_dir/.ca/$ca.srl" -CAcreateserial \
    -out "$secrets_dir/$cert" -days 825 -sha256 -extfile "$work_dir/$cert.ext" 2>/dev/null
}

keypair() {
  local private="$1" public="$2" algorithm="$3"
  missing "$private" || return 0
  if [[ "$algorithm" == ed25519 ]]; then
    openssl genpkey -algorithm ED25519 -out "$secrets_dir/$private" 2>/dev/null
  else
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$secrets_dir/$private" 2>/dev/null
  fi
  openssl pkey -in "$secrets_dir/$private" -pubout -out "$secrets_dir/$public" 2>/dev/null
}

# Certificate authorities. Their keys stay in secrets/.ca (never mounted into a container).
create_ca fabric_origin_server_ca 'Browser Fabric Origin Server CA'
create_ca fabric_origin_client_ca 'Browser Fabric Origin Client CA'
create_ca fabric_worker_ca 'Browser Fabric Worker CA'
create_ca fabric_input_broker_client_ca 'Browser Fabric Input Broker CA'

issue fabric_origin_server_ca fabric_api_cert fabric_api_key fabric-api server
issue fabric_origin_server_ca fabric_cdp_gateway_cert fabric_cdp_gateway_key fabric-cdp-gateway server
issue fabric_origin_client_ca fabric_edge_origin_client_cert fabric_edge_origin_client_key fabric-edge client

issue fabric_worker_ca fabric_worker_manager_cert fabric_worker_manager_key fabric-worker-manager server
issue fabric_input_broker_client_ca fabric_input_broker_cert fabric_input_broker_key fabric-input-broker server
issue fabric_input_broker_client_ca fabric_input_broker_api_client_cert fabric_input_broker_api_client_key fabric-api client
issue fabric_input_broker_client_ca fabric_input_broker_manager_client_cert fabric_input_broker_manager_client_key fabric-worker-manager client

# Worker identities: <secret-name> <worker-id> <worker config>
readonly workers=(
  "chrome worker_chrome workers/chrome/config/worker.json"
)
for entry in "${workers[@]}"; do
  read -r name id _ <<< "$entry"
  issue fabric_worker_ca "fabric_worker_${name}_cert" "fabric_worker_${name}_key" "$id" client
  write_random "${name}_worker_enrollment"
done

keypair fabric_assignment_private_key fabric_assignment_public_key ed25519

if missing fabric_db_password; then
  random_hex > "$secrets_dir/fabric_db_password"
  rm -f "$secrets_dir/fabric_db_url"
fi
missing fabric_db_url && printf 'postgresql://fabric:%s@fabric-postgres:5432/browser_fabric\n' "$(<"$secrets_dir/fabric_db_password")" > "$secrets_dir/fabric_db_url"
write_random fabric_capability_secret
write_random object_store_root_access_key
write_random object_store_root_secret_key
write_random fabric_object_store_access_key
write_random fabric_object_store_secret_key

# Operator-provided values. A comment-only file means "not configured": the proxy listener fails
# closed, the solver provider is never called, and the CAPTCHA guardian has no model until a real
# value replaces it.
for name in egress_proxy_upstreams deathbycaptcha_username deathbycaptcha_password anticaptcha_client_key llm_captcha_api_key; do
  missing "$name" && printf '%s\n' '# not-yet-provisioned' > "$secrets_dir/$name"
done

for name in $principals; do
  [[ -s "$secrets_dir/principals/$name" ]] || random_hex > "$secrets_dir/principals/$name"
done

# An empty catalog means "built-ins only"; see docs/catalog.md and catalog.example.json.
readonly catalog_file="${FABRIC_CATALOG_PATH:-$script_dir/catalog.json}"
[[ -f "$catalog_file" ]] || printf '%s\n' '{ "version": 1 }' > "$catalog_file"
jq -e '.version == 1' "$catalog_file" >/dev/null || fail "$catalog_file is not a version 1 Fabric catalog"

# Worker configs: the defaults in workers/*/config/worker.json plus every catalog recipe whose
# runtime the worker serves (interactive recipes only on interactive workers). The agents load these
# files, and the provisioning manifest registers exactly the same capabilities.
mkdir -p "$secrets_dir/workers"
workers_json="[]"
for entry in "${workers[@]}"; do
  read -r name id config <<< "$entry"
  jq --slurpfile catalog "$catalog_file" --arg id "$id" \
    --arg fingerprint "$(certificate_fingerprint "$secrets_dir/fabric_worker_${name}_cert")" '
    (if .id != $id then error("worker config id mismatch") else . end)
    | . as $worker
    | [($catalog[0].recipes // [])[]
        | select(.runtime as $runtime | $worker.capabilities.runtimeFamilies | index($runtime))
        | select(.mode != "interactive" or $worker.capabilities.supportsInteractive)] as $recipes
    | .capabilities.recipeRefs = (.capabilities.recipeRefs + [$recipes[] | "recipe_\(.name)@\(.version // 1)"] | unique)
    | .capabilities.supportedProfileFamilies = (.capabilities.supportedProfileFamilies + [$recipes[] | .profileFamily] | unique)
    | .certificateFingerprint = $fingerprint' \
    "$repo_dir/$config" > "$work_dir/$name.json"
  rm -f "$secrets_dir/workers/$name.json"
  mv "$work_dir/$name.json" "$secrets_dir/workers/$name.json"
  worker="$(jq --arg enrollment "sha256:$(sha256_file "$secrets_dir/${name}_worker_enrollment")" \
    'del(.activeLeases, .lastHeartbeatAt, .createdAt, .updatedAt) | .enrollmentTokenHash = $enrollment' \
    "$secrets_dir/workers/$name.json")"
  workers_json="$(jq --argjson worker "$worker" '. + [$worker]' <<< "$workers_json")"
done

principals_json="$(for name in $principals; do printf '%s\n' "$name"; done | jq -R . | jq -s \
  --arg admin "$admin_principal" --arg project "$default_project_id" '
  map({
    id: ("principal_" + .),
    displayName: .,
    projectGrants: [$project],
    roles: (if . == $admin then ["fabric_admin", "project_admin"] else ["project_operator"] end),
    certificateFingerprint: ("edge-basic-auth:principal_" + .),
    createdAt: "2026-01-01T00:00:00.000Z"
  })')"

rm -f "$secrets_dir/fabric_provision_manifest"
jq -n \
  --arg admin "principal_$admin_principal" \
  --arg project_id "$default_project_id" --arg project_name "$default_project_name" \
  --argjson principals "$principals_json" --argjson workers "$workers_json" '
  {
    version: 1,
    bootstrapAdminId: $admin,
    projects: [{ id: $project_id, name: $project_name }],
    principals: $principals,
    workers: $workers,
    profiles: [
      { ref: "profile_default", ownerProject: $project_id, workerId: "worker_chrome", volumeName: "profile_default", profileFamily: "default", grants: [$project_id], volumeGeneration: 1, status: "active" }
    ]
  }' > "$secrets_dir/fabric_provision_manifest"

# Compose bind-mounts each secret file; the services run as non-root users and must read them.
# The directory itself stays private to the operator.
find "$secrets_dir" -maxdepth 1 -type f -exec chmod 0444 {} +
find "$secrets_dir/principals" "$secrets_dir/workers" -type f -exec chmod 0444 {} +
chmod 0755 "$secrets_dir/principals" "$secrets_dir/workers"
chmod 0700 "$secrets_dir/.ca"
chmod 0700 "$secrets_dir"
printf 'Browser Fabric secrets are ready in %s (principals: %s)\n' "$secrets_dir" "$principals"
