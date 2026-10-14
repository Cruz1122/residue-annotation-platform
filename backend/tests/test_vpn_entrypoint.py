import importlib.util
import os
from pathlib import Path

import pytest

ENTRYPOINT_PATH = Path(__file__).resolve().parents[2] / "infra" / "mn5-vpn" / "entrypoint.py"


def _load_entrypoint():
    spec = importlib.util.spec_from_file_location("mn5_vpn_entrypoint", ENTRYPOINT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_vpn_config_with_credentials_requires_private_mode(tmp_path: Path, monkeypatch):
    entrypoint = _load_entrypoint()
    config = tmp_path / "openfortivpn.conf"
    config.write_text("password=not-for-logs\n", encoding="utf-8")
    config.chmod(0o644)
    monkeypatch.setattr(entrypoint.shutil, "which", lambda _name: "/usr/bin/openfortivpn")
    monkeypatch.setenv("HPC_VPN_CONFIG_FILE", str(config))
    monkeypatch.setenv("HPC_VPN_PASSWORD_FILE", str(tmp_path / "missing-password"))

    with pytest.raises(SystemExit, match="VPN config file"):
        entrypoint.main()


def test_vpn_config_symlink_is_rejected_with_external_password(tmp_path: Path, monkeypatch):
    entrypoint = _load_entrypoint()
    target = tmp_path / "openfortivpn.conf"
    target.write_text("password=not-for-logs\n", encoding="utf-8")
    target.chmod(0o644)
    config = tmp_path / "config-link"
    config.symlink_to(target)
    password = tmp_path / "vpn-password"
    password.write_text("secret\n", encoding="utf-8")
    password.chmod(0o600)
    monkeypatch.setattr(entrypoint.shutil, "which", lambda _name: "/usr/bin/openfortivpn")
    monkeypatch.setenv("HPC_VPN_CONFIG_FILE", str(config))
    monkeypatch.setenv("HPC_VPN_PASSWORD_FILE", str(password))

    with pytest.raises(SystemExit, match="must not be a symlink"):
        entrypoint.main()


def test_vpn_password_file_builds_non_interactive_command(tmp_path: Path, monkeypatch):
    entrypoint = _load_entrypoint()
    password = tmp_path / "vpn-password"
    password.write_text("secret\n", encoding="utf-8")
    password.chmod(0o600)
    command: list[str] = []

    def fake_execv(_binary: str, argv: list[str]) -> None:
        command.extend(argv)
        raise RuntimeError("captured exec")

    monkeypatch.setattr(entrypoint.shutil, "which", lambda _name: "/usr/bin/openfortivpn")
    monkeypatch.setattr(os, "execv", fake_execv)
    monkeypatch.setenv("HPC_VPN_CONFIG_FILE", "/dev/null")
    monkeypatch.setenv("HPC_VPN_PASSWORD_FILE", str(password))
    monkeypatch.setenv("HPC_VPN_HOST", "gw.bsc.es")
    monkeypatch.setenv("HPC_VPN_PORT", "443")
    monkeypatch.setenv("HPC_VPN_USERNAME", "mmenaca")
    monkeypatch.setenv("HPC_VPN_RECONNECT_SECONDS", "60")

    with pytest.raises(RuntimeError, match="captured exec"):
        entrypoint.main()

    assert command[:5] == [
        "/usr/bin/openfortivpn",
        "--config",
        "/dev/null",
        "gw.bsc.es:443",
        "--username",
    ]
    assert "--pinentry" in command
    assert str(password) not in command
    assert "secret" not in command
