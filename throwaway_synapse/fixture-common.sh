#!/usr/bin/env bash

podman_container_exists() {
  local name="$1" status
  if podman container exists "$name"; then
    return 0
  else
    status="$?"
  fi
  if [[ "$status" == 1 ]]; then
    return 1
  fi
  echo "ERROR: could not determine whether Podman container $name exists" >&2
  return "$status"
}

podman_network_exists() {
  local name="$1" status
  if podman network exists "$name"; then
    return 0
  else
    status="$?"
  fi
  if [[ "$status" == 1 ]]; then
    return 1
  fi
  echo "ERROR: could not determine whether Podman network $name exists" >&2
  return "$status"
}

podman_volume_exists() {
  local name="$1" status
  if podman volume exists "$name"; then
    return 0
  else
    status="$?"
  fi
  if [[ "$status" == 1 ]]; then
    return 1
  fi
  echo "ERROR: could not determine whether Podman volume $name exists" >&2
  return "$status"
}

podman_remove_container_if_present() {
  local name="$1" status
  if podman_container_exists "$name"; then
    podman rm -f "$name"
  else
    status="$?"
    if [[ "$status" != 1 ]]; then return "$status"; fi
  fi
}

podman_remove_network_if_present() {
  local name="$1" status
  if podman_network_exists "$name"; then
    podman network rm "$name"
  else
    status="$?"
    if [[ "$status" != 1 ]]; then return "$status"; fi
  fi
}

podman_remove_volume_if_present() {
  local name="$1" status
  if podman_volume_exists "$name"; then
    podman volume rm -f "$name"
  else
    status="$?"
    if [[ "$status" != 1 ]]; then return "$status"; fi
  fi
}

remove_fixture_data() {
  local action="$1"
  local data_dir="$2"

  # Rootless containers may leave user-namespace-owned files behind. Try the
  # namespace-aware removal first, then the host fallback only if the exact
  # fixture directory still needs removing. Never continue with stale data.
  if [[ ! -e "$data_dir" ]]; then
    return
  fi
  if podman unshare rm -rf -- "$data_dir" && [[ ! -e "$data_dir" ]]; then
    return
  fi
  if rm -rf -- "$data_dir" && [[ ! -e "$data_dir" ]]; then
    return
  fi
  echo "ERROR: $action could not remove $data_dir; stale fixture data remains. Stop processes using it and retry." >&2
  exit 1
}
