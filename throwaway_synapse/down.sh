#!/usr/bin/env bash
# Stop and remove the throwaway MAS-delegated Synapse stack (Synapse, MAS,
# Postgres, Caddy front door, network).
#
#   ./down.sh          # stop + remove containers (keeps ./data for a fast restart)
#   ./down.sh --wipe   # also delete ./data and the Postgres volume (full reset)
set -euo pipefail

cd "$(dirname "$0")"

NET="throwaway-net"
DB="throwaway-mas-db"
MAS="throwaway-mas"
SYN="throwaway-synapse"
PROXY="throwaway-proxy"
PGVOL="throwaway-mas-pgdata"

for name in "$PROXY" "$SYN" "$MAS" "$DB"; do
  podman rm -f "$name" >/dev/null 2>&1 && echo "==> removed $name" || echo "==> $name was not running"
done
podman network rm "$NET" >/dev/null 2>&1 && echo "==> removed network $NET" || true

if [[ "${1:-}" == "--wipe" ]]; then
  podman volume rm -f "$PGVOL" >/dev/null 2>&1 || true
  # Data is owned by the container-mapped UID (rootless podman); delete inside
  # the user namespace so the host user is allowed to remove it.
  podman unshare rm -rf "$PWD/data" 2>/dev/null || rm -rf "$PWD/data"
  echo "==> wiped ./data and Postgres volume"
fi
