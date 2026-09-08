#!/usr/bin/env bash
# Launch a throwaway MAS-delegated Synapse stack for functional tests, via
# podman: Postgres (MAS's database) + MAS + Synapse (delegating authentication
# to MAS) + a Caddy front door on :8008. The local fixture routes MAS-owned
# logout/refresh endpoints directly to MAS because Synapse delegates
# authentication to it.
#
# Idempotent: safe to run repeatedly. Generates config on first run, reuses it
# after. MAS owns account creation; tests provision accounts with
# `mas-cli manage register-user` (see test/harness/users.ts).
#
#   ./up.sh          # start (generate config if missing)
#   ./up.sh --fresh  # wipe data and regenerate from scratch
#   ./down.sh --wipe # stop and remove all throwaway state
#
# Verify it is up:  curl http://localhost:8008/_matrix/client/versions
#                   curl http://localhost:8008/auth/.well-known/openid-configuration
set -euo pipefail

cd "$(dirname "$0")"
# shellcheck disable=SC1091
source ./fixture-common.sh

SYN_IMG="ghcr.io/element-hq/synapse:v1.159.0"
MAS_IMG="ghcr.io/element-hq/matrix-authentication-service:1.23.0"
PROXY_IMG="docker.io/library/caddy:2.11.4-alpine"
PG_IMG="docker.io/library/postgres:17.11-bookworm"

NET="throwaway-net"
DB="throwaway-mas-db"
MAS="throwaway-mas"
SYN="throwaway-synapse"
PROXY="throwaway-proxy"
PGVOL="throwaway-mas-pgdata"

DATA="$PWD/data"
SECRET_FILE="$DATA/mas-shared-secret"

if (( $# > 1 )); then
  echo "ERROR: expected no option or --fresh; use ./down.sh --wipe for teardown" >&2
  exit 2
fi

case "${1:-}" in
""|--fresh) ;;
*)
  echo "ERROR: unsupported option; use --fresh to reset or ./down.sh --wipe for teardown" >&2
  exit 2
  ;;
esac

if [[ "${1:-}" == "--fresh" ]]; then
  echo "==> --fresh: removing containers, network, volume, and data"
  podman_remove_container_if_present "$SYN"
  podman_remove_container_if_present "$MAS"
  podman_remove_container_if_present "$DB"
  podman_remove_container_if_present "$PROXY"
  podman_remove_volume_if_present "$PGVOL"
  podman_remove_network_if_present "$NET"
  remove_fixture_data "--fresh" "$DATA"
fi

mkdir -p "$DATA/synapse" "$DATA/mas"
if podman_network_exists "$NET"; then
  :
else
  network_status="$?"
  if [[ "$network_status" != 1 ]]; then exit "$network_status"; fi
  podman network create "$NET"
fi

# Shared secret Synapse and MAS use to authenticate requests to each other
# (matrix_authentication_service.secret / matrix.secret). Generated once,
# reused across restarts — same idempotency pattern as Synapse's signing key.
if [[ ! -f "$SECRET_FILE" ]]; then
  echo "==> generating MAS<->Synapse shared secret"
  openssl rand -hex 32 > "$SECRET_FILE"
fi
chmod 600 "$SECRET_FILE"
SHARED_SECRET="$(cat "$SECRET_FILE")"

# ---------------------------------------------------------------------------
# 1. Postgres (MAS's database — MAS does not support SQLite).
# ---------------------------------------------------------------------------
if podman_container_exists "$DB"; then
  DB_STATUS="$(podman inspect --format '{{.State.Status}}' "$DB")"
  if [[ "$DB_STATUS" != "running" ]]; then
    podman start "$DB"
  fi
else
  db_exists_status="$?"
  if [[ "$db_exists_status" != 1 ]]; then exit "$db_exists_status"; fi
  echo "==> starting postgres ($DB)"
  podman run -d --name "$DB" --network "$NET" \
    -e POSTGRES_USER=mas -e POSTGRES_PASSWORD=mas -e POSTGRES_DB=mas \
    -v "${PGVOL}:/var/lib/postgresql/data" \
    "$PG_IMG"
fi

DB_STATUS="$(podman inspect --format '{{.State.Status}}' "$DB")"
DB_IP="$(podman inspect --format "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$DB")"
if [[ "$DB_STATUS" != "running" || ! "$DB_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  echo "ERROR: PostgreSQL did not expose a running container with a valid IPv4 address" >&2
  exit 1
fi
IFS=. read -r -a DB_OCTETS <<< "$DB_IP"
for octet in "${DB_OCTETS[@]}"; do
  if (( 10#$octet > 255 )); then
    echo "ERROR: PostgreSQL container IPv4 address is invalid" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# 2. Synapse base config plus the matrix_authentication_service delegation
#    block appended.
# ---------------------------------------------------------------------------
if [[ ! -f "$DATA/synapse/homeserver.yaml" ]]; then
  echo "==> generating base Synapse config"
  podman run --rm \
    -v "$DATA/synapse:/data:Z" \
    -e SYNAPSE_SERVER_NAME=localhost:8008 \
    -e SYNAPSE_REPORT_STATS=no \
    "$SYN_IMG" generate

  echo "==> appending homeserver.extra.yaml + MAS delegation block"
  cat > "$DATA/mas-delegation.yaml" <<EOF

# ---- MAS delegation — throwaway test overrides ----
matrix_authentication_service:
  enabled: true
  endpoint: http://${MAS}:8080
  secret: "${SHARED_SECRET}"
EOF
  podman run --rm \
    -v "$DATA/synapse:/data:Z" \
    -v "$PWD/homeserver.extra.yaml:/extra.yaml:ro,Z" \
    -v "$DATA/mas-delegation.yaml:/mas-delegation.yaml:ro,Z" \
    --entrypoint /bin/sh \
    "$SYN_IMG" -c 'printf "\n# ---- throwaway test overrides ----\n" >> /data/homeserver.yaml && cat /extra.yaml >> /data/homeserver.yaml && cat /mas-delegation.yaml >> /data/homeserver.yaml'
fi

# ---------------------------------------------------------------------------
# 3. MAS config (generated once, then patched: db uri, matrix.* secret/
#    endpoint, same-origin public_base/issuer, permissive dev DCR policy).
# ---------------------------------------------------------------------------
if [[ ! -f "$DATA/mas/config.yaml" ]]; then
  echo "==> generating MAS config"
  # MAS 1.23 defaults `config generate` to a file inside the container.  That
  # leaves the host redirect empty, so MAS later reports "missing field
  # secrets".  Request stdout explicitly; the generated keys stay in this
  # disposable local fixture's ignored data directory.
  podman run --rm "$MAS_IMG" config generate --output /dev/stdout > "$DATA/mas/config.yaml"
  if ! grep -q '^secrets:' "$DATA/mas/config.yaml"; then
    echo "ERROR: MAS config generation produced no secrets section" >&2
    exit 1
  fi
  python3 "$PWD/patch_mas_config.py" "$DATA/mas/config.yaml" "$SHARED_SECRET"
fi

# ---------------------------------------------------------------------------
# 4. (Re)start MAS. `mas-cli server` runs pending DB migrations itself on
#    startup — no separate migrate step needed.
# ---------------------------------------------------------------------------
podman_remove_container_if_present "$MAS"
echo "==> starting MAS ($MAS)"
podman run -d --name "$MAS" --network "$NET" \
  --add-host "$DB:$DB_IP" \
  -v "$DATA/mas:/data:Z" \
  "$MAS_IMG" server -c /data/config.yaml

# ---------------------------------------------------------------------------
# 5. (Re)start Synapse.
# ---------------------------------------------------------------------------
podman_remove_container_if_present "$SYN"
echo "==> starting Synapse ($SYN)"
podman run -d --name "$SYN" --network "$NET" \
  -v "$DATA/synapse:/data:Z" \
  "$SYN_IMG"

# ---------------------------------------------------------------------------
# 6. (Re)start the Caddy front door on :8008 — the public "homeserver" URL
#    every test/CLI/UI default already points at.
# ---------------------------------------------------------------------------
echo "==> validating front-door configuration"
podman run --rm \
  -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro,Z" \
  --entrypoint caddy \
  "$PROXY_IMG" validate --config /etc/caddy/Caddyfile
podman_remove_container_if_present "$PROXY"
echo "==> starting front door ($PROXY) on :8008"
podman run -d --name "$PROXY" --network "$NET" \
  -p 8008:8008 \
  -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro,Z" \
  "$PROXY_IMG"

# ---------------------------------------------------------------------------
# 7. Wait for health.
# Every probe's complete response/transport output is retained until the
# readiness deadline. A timeout below reports that output and complete
# container logs, including any diagnostic retrieval failure.
# ---------------------------------------------------------------------------
probe_diagnostics="$(mktemp)"
probe_diagnostics_reported=false
cleanup_probe_diagnostics() {
  local status="$?"
  if [[ "$status" != 0 && "$probe_diagnostics_reported" != true ]]; then
    if ! cat -- "$probe_diagnostics" >&2; then
      echo "ERROR: could not retrieve readiness probe diagnostics" >&2
      status=1
    fi
  fi
  if ! rm -f -- "$probe_diagnostics"; then
    echo "ERROR: could not remove readiness probe diagnostics" >&2
    status=1
  fi
  return "$status"
}
trap cleanup_probe_diagnostics EXIT

echo -n "==> waiting for MAS"
for i in $(seq 1 60); do
  printf 'MAS readiness probe %s\n' "$i" >> "$probe_diagnostics"
  if curl --silent --show-error --fail-with-body --max-time 2 \
    "http://localhost:8008/auth/.well-known/openid-configuration" >> "$probe_diagnostics" 2>&1; then
    printf 'MAS readiness probe %s succeeded\n' "$i" >> "$probe_diagnostics"
    echo " — ready"
    break
  else
    probe_status="$?"
    printf 'MAS readiness probe %s failed (status %s)\n' "$i" "$probe_status" >> "$probe_diagnostics"
  fi
  echo -n "."
  sleep 1
  if [[ "$i" == 60 ]]; then
    echo ""
    echo "ERROR: MAS did not become ready in 60s. Logs:" >&2
    cat -- "$probe_diagnostics" >&2
    probe_diagnostics_reported=true
    podman_logs_status=0
    podman logs "$MAS" >&2 || podman_logs_status="$?"
    if [[ "$podman_logs_status" != 0 ]]; then
      echo "ERROR: could not retrieve complete MAS diagnostics (status $podman_logs_status)" >&2
    fi
    exit 1
  fi
done

echo -n "==> waiting for the front door (Synapse + MAS auth proxy)"
for i in $(seq 1 60); do
  printf 'Front-door readiness probe %s\n' "$i" >> "$probe_diagnostics"
  if curl --silent --show-error --fail-with-body --max-time 2 \
    "http://localhost:8008/_matrix/client/versions" >> "$probe_diagnostics" 2>&1; then
    printf 'Front-door readiness probe %s succeeded\n' "$i" >> "$probe_diagnostics"
    echo " — ready"
    echo "Homeserver (via front door) is up at http://localhost:8008"
    exit 0
  else
    probe_status="$?"
    printf 'Front-door readiness probe %s failed (status %s)\n' "$i" "$probe_status" >> "$probe_diagnostics"
  fi
  echo -n "."
  sleep 1
done

echo ""
echo "ERROR: front door did not become ready in 60s. Logs:" >&2
cat -- "$probe_diagnostics" >&2
probe_diagnostics_reported=true
podman_logs_status=0
if ! podman logs "$PROXY" >&2; then podman_logs_status=1; fi
if ! podman logs "$SYN" >&2; then podman_logs_status=1; fi
if [[ "$podman_logs_status" != 0 ]]; then
  echo "ERROR: could not retrieve complete front-door diagnostics (status $podman_logs_status)" >&2
fi
exit 1
