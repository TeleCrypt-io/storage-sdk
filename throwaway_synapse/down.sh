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
  if podman_container_exists "$name"; then
    podman rm -f "$name"
    echo "==> removed $name"
  else
    status="$?"
    if [[ "$status" != 1 ]]; then exit "$status"; fi
    echo "==> $name was not running"
  fi
done
if podman_network_exists "$NET"; then
  podman network rm "$NET"
  echo "==> removed network $NET"
else
  status="$?"
  if [[ "$status" != 1 ]]; then exit "$status"; fi
fi

if [[ "${1:-}" == "--wipe" ]]; then
  podman_remove_volume_if_present "$PGVOL"
  remove_fixture_data "--wipe" "$DATA"
  echo "==> wiped ./data and Postgres volume"
fi
