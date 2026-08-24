#!/usr/bin/env bash
# Stop and remove the throwaway MAS-delegated Synapse stack (Synapse, MAS,
# Postgres, Caddy front door, network).
#
#   ./down.sh          # stop + remove containers (keeps ./data for a fast restart)
#   ./down.sh --wipe   # also delete ./data and the Postgres volume (full reset)
set -euo pipefail

cd "$(dirname "$0")"
# shellcheck disable=SC1091
source ./fixture-common.sh

NET="throwaway-net"
DB="throwaway-mas-db"
MAS="throwaway-mas"
SYN="throwaway-synapse"
PROXY="throwaway-proxy"
PGVOL="throwaway-mas-pgdata"
DATA="$PWD/data"

if (( $# > 1 )); then
  echo "ERROR: expected no option or --wipe" >&2
  exit 2
fi
case "${1:-}" in
""|--wipe) ;;
*)
  echo "ERROR: unsupported option; use --wipe for full teardown" >&2
  exit 2
  ;;
esac

for name in "$PROXY" "$SYN" "$MAS" "$DB"; do
  podman rm -f "$name" >/dev/null 2>&1 && echo "==> removed $name" || echo "==> $name was not running"
done
if podman network rm "$NET" >/dev/null 2>&1; then
  echo "==> removed network $NET"
fi

if [[ "${1:-}" == "--wipe" ]]; then
  podman volume rm -f "$PGVOL" >/dev/null 2>&1 || true
  remove_fixture_data "--wipe" "$DATA"
  echo "==> wiped ./data and Postgres volume"
fi
