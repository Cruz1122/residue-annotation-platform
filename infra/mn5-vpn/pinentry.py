#!/usr/bin/env python3

from __future__ import annotations

import os
import sys
from pathlib import Path


def _escape(value: str) -> str:
    encoded: list[str] = []
    for byte in value.encode("utf-8"):
        if (
            0x30 <= byte <= 0x39
            or 0x41 <= byte <= 0x5A
            or 0x61 <= byte <= 0x7A
            or byte in b"-_.~"
        ):
            encoded.append(chr(byte))
        else:
            encoded.append(f"%{byte:02X}")
    return "".join(encoded)


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

    # openfortivpn expects an Assuan-style greeting before it sends commands.
    sys.stdout.write("OK Pleased to meet you\n")
    sys.stdout.flush()

    for raw_line in sys.stdin:
        command = raw_line.rstrip("\r\n").upper()
        if command == "GETPIN":
            sys.stdout.write(f"D {_escape(secret)}\nOK\n")
        elif command in {"BYE", "QUIT"}:
            sys.stdout.write("OK\n")
            sys.stdout.flush()
            return 0
        else:
            sys.stdout.write("OK\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
