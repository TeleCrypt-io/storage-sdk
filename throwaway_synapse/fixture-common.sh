#!/usr/bin/env bash

remove_fixture_data() {
  local action="$1"
  local data_dir="$2"

  # Rootless containers may leave user-namespace-owned files behind. Try the
  # namespace-aware removal first, then the host fallback only if the exact
  # fixture directory still needs removing. Never continue with stale data.
  if [[ ! -e "$data_dir" ]]; then
    return
  fi
  if podman unshare rm -rf -- "$data_dir" 2>/dev/null && [[ ! -e "$data_dir" ]]; then
    return
  fi
  if rm -rf -- "$data_dir" 2>/dev/null && [[ ! -e "$data_dir" ]]; then
    return
  fi
  echo "ERROR: $action could not remove $data_dir; stale fixture data remains. Stop processes using it and retry." >&2
  exit 1
}
