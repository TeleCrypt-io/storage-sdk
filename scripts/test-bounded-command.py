#!/usr/bin/env python3
"""Behavioral checks for bounded diagnostics without a work-file limit."""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parent.parent
HELPER = ROOT / "scripts/bounded-command.py"


class BoundedCommandTest(unittest.TestCase):
    def run_helper(self, code: str, limit: int = 65536) -> tuple[subprocess.CompletedProcess[str], bytes, int, int]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "stdout"
            error = root / "stderr"
            work = root / "work.bin"
            result = subprocess.run(
                [
                    sys.executable,
                    str(HELPER),
                    "--stdout",
                    str(output),
                    "--stderr",
                    str(error),
                    "--max-stdout-bytes",
                    str(limit),
                    "--max-stderr-bytes",
                    str(limit),
                    "--timeout-seconds",
                    "5",
                    "--",
                    sys.executable,
                    "-c",
                    code,
                    str(work),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
                timeout=15,
            )
            return result, output.read_bytes(), work.stat().st_size if work.exists() else 0, output.stat().st_size

    def test_work_file_is_not_capped_by_diagnostic_limit(self) -> None:
        result, output, work_size, _ = self.run_helper(
            "from pathlib import Path; import sys; Path(sys.argv[1]).write_bytes(b'x' * 131072); print('ok')"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output, b"ok\n")
        self.assertEqual(work_size, 131072)

    def test_stdout_overflow_fails_without_unbounded_capture(self) -> None:
        result, _, _, output_size = self.run_helper("import sys; sys.stdout.write('x' * 65537)")
        self.assertNotEqual(result.returncode, 0)
        self.assertLessEqual(output_size, 65536)


if __name__ == "__main__":
    unittest.main()
