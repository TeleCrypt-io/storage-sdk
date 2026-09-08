# Shared release-workflow command capture. This file is sourced by workflow
# steps; it deliberately imposes no output-size limit.

capture_pid=""
capture_stdout_path=""
capture_stderr_path=""
capture_extra_paths=()

capture_signal() {
  local signal="$1" kill_status=0 kill_probe_status=0 wait_status=0
  set +e
  trap - HUP INT TERM
  if test -n "$capture_pid"; then
    if kill -TERM "$capture_pid"; then
      :
    else
      kill_status="$?"
      if kill -0 "$capture_pid" 2>/dev/null; then
        printf 'diagnostic capture termination failed for pid %s (status %s)\n' "$capture_pid" "$kill_status" >&2
      else
        kill_probe_status="$?"
        if test "$kill_probe_status" -ne 1 || test -e "/proc/$capture_pid"; then
          printf 'diagnostic capture termination failed for pid %s (status %s; probe status %s)\n' "$capture_pid" "$kill_status" "$kill_probe_status" >&2
        fi
      fi
    fi
    if wait "$capture_pid"; then
      wait_status=0
    else
      wait_status="$?"
      case "$wait_status" in
        127) printf 'diagnostic capture wait failed for pid %s (status %s)\n' "$capture_pid" "$wait_status" >&2 ;;
        *) : ;;
      esac
    fi
    capture_pid=""
  fi
  if test -n "$capture_stdout_path"; then
    if cat "$capture_stdout_path" >&2; then
      :
    else
      printf 'diagnostic stdout replay failed (status %s)\n' "$?" >&2
    fi
  fi
  if test -n "$capture_stderr_path"; then
    if cat "$capture_stderr_path" >&2; then
      :
    else
      printf 'diagnostic stderr replay failed (status %s)\n' "$?" >&2
    fi
  fi
  for capture_extra_path in "${capture_extra_paths[@]}"; do
    if cat "$capture_extra_path" >&2; then
      :
    else
      printf 'diagnostic replay failed for %s (status %s)\n' "$capture_extra_path" "$?" >&2
    fi
  done
  exit "$((128 + signal))"
}

run_captured() {
  local stdout_path="$1" stderr_path="$2" timeout_seconds="$3" status
  shift 3
  : > "$stdout_path"
  : > "$stderr_path"
  capture_stdout_path="$stdout_path"
  capture_stderr_path="$stderr_path"
  trap 'capture_signal 1' HUP
  trap 'capture_signal 2' INT
  trap 'capture_signal 15' TERM
  timeout --signal=TERM --kill-after=5s "${timeout_seconds}s" "$@" >"$stdout_path" 2>"$stderr_path" &
  capture_pid="$!"
  if wait "$capture_pid"; then
    status=0
  else
    status="$?"
  fi
  capture_pid=""
  trap - HUP INT TERM
  return "$status"
}

finish_capture() {
  local command_status="$1" replay_stdout="$2" stdout_path="$3" stderr_path="$4" replay_status=0
  if test "$command_status" -ne 0; then
    replay_capture "$stdout_path" "$stderr_path" "$replay_stdout" || replay_status="$?"
  else
    replay_capture "$stdout_path" "$stderr_path" false || replay_status="$?"
  fi
  if test "$command_status" -ne 0; then return "$command_status"; fi
  return "$replay_status"
}

replay_capture() {
  local stdout_path="$1" stderr_path="$2" replay_stdout=true replay_status=0 cat_status=0 capture_extra_path
  shift 2
  if test "$#" -gt 0; then
    replay_stdout="$1"
    shift
  fi
  if test "$replay_stdout" = true; then
    if cat "$stdout_path" >&2; then
      :
    else
      cat_status="$?"
      replay_status=1
      printf 'diagnostic stdout replay failed (status %s)\n' "$cat_status" >&2
    fi
  fi
  if cat "$stderr_path" >&2; then
    :
  else
    cat_status="$?"
    replay_status=1
    printf 'diagnostic stderr replay failed (status %s)\n' "$cat_status" >&2
  fi
  for capture_extra_path in "$@"; do
    if cat "$capture_extra_path" >&2; then :; else
      cat_status="$?"
      replay_status=1
      printf 'diagnostic replay failed for %s (status %s)\n' "$capture_extra_path" "$cat_status" >&2
    fi
  done
  return "$replay_status"
}

require_capture() {
  local stdout_path="$1" stderr_path="$2" status
  shift 2
  if "$@"; then return 0; else status="$?"; fi
  local replay_status=0
  replay_capture "$stdout_path" "$stderr_path" || replay_status="$?"
  return "$status"
}
