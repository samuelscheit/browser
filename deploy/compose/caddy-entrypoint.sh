#!/bin/sh
set -eu

# Caddy's basic_auth directive requires bcrypt hashes. Plaintext credentials stay in the mounted
# principal password directory; the generated hashes live in the process environment and are never
# written to the Caddyfile or a volume.
readonly password_dir="${FABRIC_EDGE_PASSWORD_DIR:-/run/fabric-principals}"

hash_secret() {
  secret_file="$1"
  if [ ! -s "$secret_file" ]; then
    echo "missing Fabric application credential secret" >&2
    exit 1
  fi
  password=$(tr -d '\r\n' < "$secret_file")
  if [ "${#password}" -lt 24 ]; then
    echo "Fabric application credential is too short" >&2
    exit 1
  fi
  caddy hash-password --algorithm bcrypt --plaintext "$password"
}

# Every file <name> in the password directory is one principal: it authenticates the Basic username
# principal_<name>. Adding a principal therefore needs only its password file (and its provisioning
# manifest entry), never an edit here or in the Caddyfile.
accounts=""
for secret_file in "$password_dir"/*; do
  [ -f "$secret_file" ] || continue
  name="${secret_file#"$password_dir"/}"
  case "$name" in
    *[!A-Za-z0-9_-]*|'') echo "skipping principal password file with an invalid name" >&2; continue ;;
  esac
  accounts="${accounts}principal_${name} $(hash_secret "$secret_file")
"
done
if [ -z "$accounts" ]; then
  echo "no Fabric principal passwords are mounted at $password_dir" >&2
  exit 1
fi
export FABRIC_EDGE_BASIC_AUTH_ACCOUNTS="$accounts"

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
