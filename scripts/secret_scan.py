#!/usr/bin/env python3
"""Scan versioned text files for high-confidence credential material."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

PRIVATE_KEY = re.compile(r"-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----")
ASSIGNMENT = re.compile(
    r"(?i)\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*"
    r"[\"']?([A-Za-z0-9_./+=:-]{24,})"
)
ALLOWLIST = {
    "development-only-change-this-secret-before-production",
    "development-only",
    "change-this-secret-before-production",
    "residue-dev",
    "onboarding@resend.dev",
}
MAX_FILE_BYTES = 2 * 1024 * 1024


def _files() -> list[Path]:
    result = subprocess.run(["git", "ls-files", "-z"], check=True, capture_output=True, text=False)
    paths = [Path(item) for item in result.stdout.decode().split("\0") if item]
    for candidate in Path("scripts").glob("*.py"):
        if candidate not in paths:
            paths.append(candidate)
    return sorted(paths)


def scan(paths: list[Path]) -> list[tuple[Path, int, str]]:
    findings: list[tuple[Path, int, str]] = []
    for path in paths:
        if path.name in {"uv.lock", "pnpm-lock.yaml"} or not path.is_file():
            continue
        if path.stat().st_size > MAX_FILE_BYTES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for line_number, line in enumerate(text.splitlines(), start=1):
            if PRIVATE_KEY.search(line):
                findings.append((path, line_number, "private-key-marker"))
                continue
            match = ASSIGNMENT.search(line)
            if match and match.group(1).strip("\"'") not in ALLOWLIST:
                findings.append((path, line_number, "credential-assignment"))
    return findings


def main() -> int:
    findings = scan(_files())
    if findings:
        for path, line_number, kind in findings:
            print(f"{path}:{line_number}: {kind}", file=sys.stderr)
        return 1
    print("secret scan: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
