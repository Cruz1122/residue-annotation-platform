#!/usr/bin/env python3

from __future__ import annotations

import os
import shutil
import stat
import sys
from pathlib import Path


def _regular_file(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except OSError:
        return False
    return not stat.S_ISLNK(metadata.st_mode) and stat.S_ISREG(metadata.st_mode)


def _private_nonempty_file(path: Path, label: str) -> bool:
    if not _regular_file(path):
        return False
    metadata = path.lstat()
    if metadata.st_mode & 0o077:
        raise SystemExit(f"{label} must not be accessible by group or others")
    return metadata.st_size > 0


def _config_contains_password(path: Path) -> bool:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return False
    for line in lines:
        key, separator, value = line.partition("=")
        if separator and key.strip().lower() in {"password", "cookie"} and value.strip():
            return True
    return False


def main() -> int:
    binary = shutil.which("openfortivpn")
    if binary is None:
        print("openfortivpn is not installed", file=sys.stderr)
        return 127

    config = Path(os.environ.get("HPC_VPN_CONFIG_FILE", "/etc/openfortivpn/config"))
    password_file = Path(
        os.environ.get("HPC_VPN_PASSWORD_FILE", "/run/secrets/hpc_vpn_password")
    )
    password_available = _private_nonempty_file(password_file, "VPN password file")
    config_available = _regular_file(config)
    config_contains_credentials = config_available and _config_contains_password(config)
    if config_contains_credentials:
        _private_nonempty_file(config, "VPN config file")
    if not password_available and not config_contains_credentials:
        print(
            "VPN credentials are unavailable: provide HPC_VPN_PASSWORD_FILE "
            "or a protected openfortivpn config with a password/cookie",
            file=sys.stderr,
        )
        return 78

    host = os.environ.get("HPC_VPN_HOST")
    port = os.environ.get("HPC_VPN_PORT", "443")
    username = os.environ.get("HPC_VPN_USERNAME")
    command = [binary, "--config", str(config)]
    if host:
        command.append(f"{host}:{port}")
    if username:
        command.extend(["--username", username])
    if password_available:
        command.extend(["--pinentry", "/usr/local/libexec/rap-vpn-pinentry"])
    try:
        reconnect_seconds = max(30, int(os.environ.get("HPC_VPN_RECONNECT_SECONDS", "60")))
    except ValueError:
        print("HPC_VPN_RECONNECT_SECONDS must be an integer", file=sys.stderr)
        return 78
    # Reconnect without prompting when the tunnel drops. A bounded interval
    # avoids hammering the gateway when a credential is stale or rejected.
    command.extend(["--set-routes=1", f"--persistent={reconnect_seconds}"])
    os.execv(binary, command)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
