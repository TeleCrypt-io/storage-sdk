"""Execute the shared capture helper against successful and failed commands."""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).parents[2]


def main() -> None:
    helper = ROOT / "scripts/capture-diagnostics.sh"
    evidence_root = Path(os.environ.get("HARNESS_ARTIFACTS_ROOT", tempfile.gettempdir())).resolve()
    evidence_root.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix="storage-sdk-capture-helper-", dir=evidence_root))
    script = r'''
set -eu
source "$1"
root="$2"
printf 'success stdout' >"$root/success.out"
printf 'success stderr' >"$root/success.err"
if finish_capture 0 true "$root/success.out" "$root/success.err" >"$root/success.replayed" 2>"$root/success.diagnostics"; then :; else exit 11; fi
test ! -s "$root/success.replayed"
test "$(cat "$root/success.diagnostics")" = 'success stderr'
printf 'failure stdout' >"$root/failure.out"
printf 'failure stderr' >"$root/failure.err"
if finish_capture 7 true "$root/failure.out" "$root/failure.err" >"$root/failure.replayed" 2>"$root/failure.diagnostics"; then exit 12; else status="$?"; fi
test "$status" = 7
test ! -s "$root/failure.replayed"
test "$(cat "$root/failure.diagnostics")" = 'failure stdoutfailure stderr'
mkdir "$root/replay-out" "$root/replay-err"
if finish_capture 7 true "$root/replay-out" "$root/replay-err" >"$root/replay.replayed" 2>"$root/replay.diagnostics"; then exit 13; else status="$?"; fi
test "$status" = 7
grep -Fq 'diagnostic stdout replay failed' "$root/replay.diagnostics"
grep -Fq 'diagnostic stderr replay failed' "$root/replay.diagnostics"
'''
    result = subprocess.run(
        ["bash", "-c", script, "capture-helper", str(helper), str(evidence)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    (evidence / "process.stdout").write_text(result.stdout, encoding="utf-8")
    (evidence / "process.stderr").write_text(result.stderr, encoding="utf-8")
    (evidence / "process.status").write_text(f"{result.returncode}\n", encoding="utf-8")
    if result.returncode != 0:
        raise AssertionError(
            f"shared capture helper behavior mismatch: status={result.returncode}; "
            f"stdout={result.stdout!r}; stderr={result.stderr!r}; evidence={evidence}"
        )


if __name__ == "__main__":
    main()
