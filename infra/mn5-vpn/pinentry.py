#!/usr/bin/env python3

from __future__ import annotations

import os
import sys
from pathlib import Path


def _escape(value: str) -> str:
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def main() -> int:
    secret_path = os.environ.get("HPC_VPN_PASSWORD_FILE")
    if not secret_path:
        return 2
    try:
        secret = Path(secret_path).read_text(encoding="utf-8").splitlines()[0]
    except (OSError, IndexError):
        return 2
    if not secret:
        return 2

    for raw_line in sys.stdin:
        command = raw_line.strip().upper()
        if command.startswith("GETPIN"):
            sys.stdout.write(f"D {_escape(secret)}\nOK\n")
        elif command.startswith(("BYE", "QUIT")):
            sys.stdout.write("OK\n")
            sys.stdout.flush()
            return 0
        else:
            sys.stdout.write("OK\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
