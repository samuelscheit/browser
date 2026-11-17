#!/bin/sh
# Provision Fabric's private artifact bucket in the bundled RustFS: the bucket, its 30-day expiry
# (the artifact policy's retention) and a Fabric identity restricted to that bucket. Idempotent.
set -eu

endpoint="${OBJECT_STORE_ENDPOINT:?OBJECT_STORE_ENDPOINT is required}"
bucket="${FABRIC_OBJECT_STORE_BUCKET:?FABRIC_OBJECT_STORE_BUCKET is required}"
case "$bucket" in
  *[!a-z0-9.-]*|*..*|-*|*-|'') echo "bucket name is invalid" >&2; exit 64 ;;
esac

export HOME=/tmp XDG_CONFIG_HOME=/tmp/rc
mkdir -p "$XDG_CONFIG_HOME"
work="$(mktemp -d /tmp/object-store-init.XXXXXX)"
trap 'rm -rf "$work"' EXIT HUP INT TERM

rc alias set --region us-east-1 --bucket-lookup path local "$endpoint" \
  "$(cat /run/secrets/object_store_root_access_key)" "$(cat /run/secrets/object_store_root_secret_key)" >/dev/null

rc bucket create "local/$bucket" --ignore-existing --region us-east-1 >/dev/null
printf '{"rules":[{"id":"fabric-expiry-30d","status":"Enabled","expiration":{"days":30}}]}\n' > "$work/lifecycle.json"
rc bucket lifecycle rule import "local/$bucket" "$work/lifecycle.json" --format json >/dev/null

cat > "$work/policy.json" <<POLICY
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["s3:ListBucket","s3:GetBucketLocation"],"Resource":["arn:aws:s3:::$bucket"]},
  {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject"],"Resource":["arn:aws:s3:::$bucket/*"]}
]}
POLICY
rc admin policy info local fabric-artifacts >/dev/null 2>&1 || rc admin policy create local fabric-artifacts "$work/policy.json" >/dev/null
access_key="$(cat /run/secrets/fabric_object_store_access_key)"
rc admin user info local "$access_key" >/dev/null 2>&1 || rc admin user add local "$access_key" initialization-placeholder-secret >/dev/null
rc admin user passwd local "$access_key" --password-file /run/secrets/fabric_object_store_secret_key >/dev/null
rc admin policy attach local fabric-artifacts --user "$access_key" >/dev/null
echo "Provisioned bucket $bucket with a 30-day expiry and a restricted Fabric identity."
