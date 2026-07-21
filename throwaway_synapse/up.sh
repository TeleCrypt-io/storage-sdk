#!/usr/bin/env bash
# Launch a throwaway MAS-delegated Synapse stack for functional tests, via
# podman: Postgres (MAS's database) + MAS + Synapse (delegating auth to MAS,
# MSC3861, compatibility mode so m.login.password still works) + a Caddy
# front door on :8008 (MAS's docs require the three compat auth endpoints —
# login/logout/refresh — to be proxied to MAS directly; Synapse no longer
# serves them once delegated). See docs/OAUTH_SPEC.md and docs/DECISIONS.md D6.
#
# Idempotent: safe to run repeatedly. Generates config on first run, reuses it
# after. New accounts are provisioned via `mas-cli manage register-user`
# (see test/harness/users.ts), not the old plain POST /register — MAS owns
# account creation now.
#
#   ./up.sh          # start (generate config if missing)
#   ./up.sh --fresh  # wipe data and regenerate from scratch
#
# Verify it is up:  curl http://localhost:8008/_matrix/client/versions
#                   curl http://localhost:8082/.well-known/openid-configuration
set -euo pipefail

cd "$(dirname "$0")"

SYN_IMG="ghcr.io/element-hq/synapse:latest"
MAS_IMG="ghcr.io/element-hq/matrix-authentication-service:latest"
PROXY_IMG="docker.io/library/caddy:latest"
PG_IMG="docker.io/library/postgres:16-alpine"

NET="throwaway-net"
DB="throwaway-mas-db"
MAS="throwaway-mas"
SYN="throwaway-synapse"
PROXY="throwaway-proxy"
PGVOL="throwaway-mas-pgdata"

DATA="$PWD/data"
SECRET_FILE="$DATA/mas-shared-secret"

if [[ "${1:-}" == "--fresh" ]]; then
  echo "==> --fresh: removing containers, network, volume, and data"
  podman rm -f "$SYN" "$MAS" "$DB" "$PROXY" >/dev/null 2>&1 || true
  podman volume rm -f "$PGVOL" >/dev/null 2>&1 || true
  podman network rm "$NET" >/dev/null 2>&1 || true
  # Data is owned by the container-mapped UID under rootless podman, so a plain
  # host `rm` is denied. Delete inside the user namespace instead.
  podman unshare rm -rf "$DATA" 2>/dev/null || rm -rf "$DATA"
fi

mkdir -p "$DATA/synapse" "$DATA/mas"
podman network create "$NET" >/dev/null 2>&1 || true

# Shared secret Synapse and MAS use to authenticate requests to each other
# (matrix_authentication_service.secret / matrix.secret). Generated once,
# reused across restarts — same idempotency pattern as Synapse's signing key.
if [[ ! -f "$SECRET_FILE" ]]; then
  echo "==> generating MAS<->Synapse shared secret"
  openssl rand -hex 32 > "$SECRET_FILE"
fi
SHARED_SECRET="$(cat "$SECRET_FILE")"

# ---------------------------------------------------------------------------
# 1. Postgres (MAS's database — MAS does not support SQLite).
# ---------------------------------------------------------------------------
if ! podman container exists "$DB"; then
  echo "==> starting postgres ($DB)"
  podman run -d --name "$DB" --network "$NET" \
    -e POSTGRES_USER=mas -e POSTGRES_PASSWORD=mas -e POSTGRES_DB=mas \
    -v "${PGVOL}:/var/lib/postgresql/data" \
    "$PG_IMG" >/dev/null
else
  podman start "$DB" >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------------------
# 2. Synapse base config (same generation step as before), plus the
#    matrix_authentication_service delegation block appended.
# ---------------------------------------------------------------------------
if [[ ! -f "$DATA/synapse/homeserver.yaml" ]]; then
  echo "==> generating base Synapse config"
  podman run --rm \
    -v "$DATA/synapse:/data:Z" \
    -e SYNAPSE_SERVER_NAME=localhost \
    -e SYNAPSE_REPORT_STATS=no \
    "$SYN_IMG" generate

  echo "==> appending homeserver.extra.yaml + MAS delegation block"
  cat > "$DATA/mas-delegation.yaml" <<EOF

# ---- MAS delegation (MSC3861) — throwaway test overrides ----
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
#    endpoint, public_base/issuer, permissive dev DCR policy).
# ---------------------------------------------------------------------------
if [[ ! -f "$DATA/mas/config.yaml" ]]; then
  echo "==> generating MAS config"
  podman run --rm "$MAS_IMG" config generate > "$DATA/mas/config.yaml"
  python3 "$PWD/patch_mas_config.py" "$DATA/mas/config.yaml" "$SHARED_SECRET"
fi

# ---------------------------------------------------------------------------
# 4. (Re)start MAS. `mas-cli server` runs pending DB migrations itself on
#    startup — no separate migrate step needed.
# ---------------------------------------------------------------------------
podman rm -f "$MAS" >/dev/null 2>&1 || true
echo "==> starting MAS ($MAS) on :8082"
podman run -d --name "$MAS" --network "$NET" \
  -p 8082:8080 \
  -v "$DATA/mas:/data:Z" \
  "$MAS_IMG" server -c /data/config.yaml >/dev/null

# ---------------------------------------------------------------------------
# 5. (Re)start Synapse.
# ---------------------------------------------------------------------------
podman rm -f "$SYN" >/dev/null 2>&1 || true
echo "==> starting Synapse ($SYN)"
podman run -d --name "$SYN" --network "$NET" \
  -p 8009:8008 \
  -v "$DATA/synapse:/data:Z" \
  "$SYN_IMG" >/dev/null

# ---------------------------------------------------------------------------
# 6. (Re)start the Caddy front door on :8008 — the public "homeserver" URL
#    every test/CLI/UI default already points at.
# ---------------------------------------------------------------------------
podman rm -f "$PROXY" >/dev/null 2>&1 || true
echo "==> starting front door ($PROXY) on :8008"
podman run -d --name "$PROXY" --network "$NET" \
  -p 8008:8008 \
  -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro,Z" \
  "$PROXY_IMG" >/dev/null

# ---------------------------------------------------------------------------
# 7. Wait for health.
# ---------------------------------------------------------------------------
echo -n "==> waiting for MAS"
for i in $(seq 1 60); do
  if curl -fsS -m2 "http://localhost:8082/.well-known/openid-configuration" >/dev/null 2>&1; then
    echo " — ready"
    break
  fi
  echo -n "."
  sleep 1
  if [[ "$i" == 60 ]]; then
    echo ""
    echo "ERROR: MAS did not become ready in 60s. Logs:" >&2
    podman logs --tail 60 "$MAS" >&2 || true
    exit 1
  fi
done

echo -n "==> waiting for the front door (Synapse + MAS compat proxy)"
for i in $(seq 1 60); do
  if curl -fsS -m2 "http://localhost:8008/_matrix/client/versions" >/dev/null 2>&1; then
    echo " — ready"
    echo "Homeserver (via front door) is up at http://localhost:8008"
    echo "MAS is up at http://localhost:8082"
    exit 0
  fi
  echo -n "."
  sleep 1
done

echo ""
echo "ERROR: front door did not become ready in 60s. Logs:" >&2
podman logs --tail 40 "$PROXY" >&2 || true
podman logs --tail 40 "$SYN" >&2 || true
exit 1
