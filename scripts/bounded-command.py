#!/usr/bin/env python3
"""Run one command with bounded diagnostic capture and no file-size limit."""

from __future__ import annotations

import argparse
import os
import selectors
import signal
import subprocess
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stdout", type=Path, required=True)
    parser.add_argument("--stderr", type=Path, required=True)
    parser.add_argument("--max-stdout-bytes", type=int, required=True)
    parser.add_argument("--max-stderr-bytes", type=int, required=True)
    parser.add_argument("--timeout-seconds", type=float, required=True)
    parser.add_argument("--kill-after-seconds", type=float, default=5.0)
    parser.add_argument("--cwd", type=Path)
    parser.add_argument("--stdin", type=Path)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command[:1] == ["--"]:
        args.command = args.command[1:]
    if not args.command or any(value < 0 for value in (args.max_stdout_bytes, args.max_stderr_bytes)):
        parser.error("a command and non-negative diagnostic limits are required")
    if args.timeout_seconds <= 0 or args.kill_after_seconds <= 0:
        parser.error("timeouts must be positive")
    return args


def terminate(process: subprocess.Popen[bytes], grace: float) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + grace
    while process.poll() is None and time.monotonic() < deadline:
        time.sleep(0.01)
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def main() -> int:
    args = parse_args()
    args.stdout.parent.mkdir(parents=True, exist_ok=True)
    args.stderr.parent.mkdir(parents=True, exist_ok=True)
    stdin = args.stdin.open("rb") if args.stdin is not None else None
    process = subprocess.Popen(
        args.command,
        cwd=args.cwd,
        stdin=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    streams = {
        process.stdout: (args.stdout, args.max_stdout_bytes, 0),
        process.stderr: (args.stderr, args.max_stderr_bytes, 1),
    }
    selector = selectors.DefaultSelector()
    files = {}
    sizes = [0, 0]
    overflow = [False, False]
    try:
        for stream, (path, _limit, index) in streams.items():
            assert stream is not None
            files[index] = path.open("wb")
            selector.register(stream, selectors.EVENT_READ, index)
        deadline = time.monotonic() + args.timeout_seconds
        timed_out = False
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                terminate(process, args.kill_after_seconds)
                deadline = time.monotonic() + args.kill_after_seconds
                remaining = args.kill_after_seconds
            events = selector.select(min(remaining, 0.1))
            for key, _ in events:
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                index = key.data
                limit = streams[key.fileobj][1]
                available = max(0, limit - sizes[index])
                if available:
                    files[index].write(chunk[:available])
                    sizes[index] += min(len(chunk), available)
                if len(chunk) > available:
                    overflow[index] = True
        returncode = process.wait()
        if timed_out:
            return 124
        if any(overflow):
            return 125
        return returncode if returncode >= 0 else 128 - returncode
    finally:
        selector.close()
        for file in files.values():
            file.close()
        if stdin is not None:
            stdin.close()
        for stream in (process.stdout, process.stderr):
            if stream is not None and not stream.closed:
                stream.close()


if __name__ == "__main__":
    raise SystemExit(main())
