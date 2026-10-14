#!/usr/bin/env python3
"""Create and verify PostgreSQL/artifact backup bundles.

The command never prints a database URL or copies raw credentials into the
bundle. A restore requires an explicit ``--confirm RESTORE`` and should target
an isolated database and an empty artifact directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

MAX_HASH_BYTES = 128 * 1024 * 1024


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _database_environment(database_url: str) -> dict[str, str]:
    parsed = urlsplit(database_url.replace("postgresql+psycopg://", "postgresql://", 1))
    if (
        parsed.scheme not in {"postgresql", "postgres"}
        or not parsed.hostname
        or not parsed.path.lstrip("/")
    ):
        raise ValueError("DATABASE_URL must be a PostgreSQL URL")
    environment = os.environ.copy()
    environment.update(
        {
            "PGHOST": parsed.hostname,
            "PGPORT": str(parsed.port or 5432),
            "PGUSER": unquote(parsed.username or ""),
            "PGDATABASE": parsed.path.lstrip("/"),
        }
    )
    if parsed.password is not None:
        environment["PGPASSWORD"] = unquote(parsed.password)
    return environment


def _run(command: list[str], *, environment: dict[str, str]) -> None:
    subprocess.run(command, check=True, env=environment, timeout=600)


def _artifact_inventory(root: Path, *, copy_to: Path | None = None) -> list[dict[str, object]]:
    if not root.exists():
        return []
    if not root.is_dir() or root.is_symlink():
        raise ValueError("artifact root must be a real directory")
    inventory: list[dict[str, object]] = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        relative = path.relative_to(root)
        size = path.stat().st_size
        record: dict[str, object] = {"path": relative.as_posix(), "size": size}
        if size <= MAX_HASH_BYTES:
            record["sha256"] = _sha256(path)
        if copy_to is not None:
            destination = copy_to / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)
        inventory.append(record)
    return inventory


def _manifest_path(bundle: Path) -> Path:
    return bundle / "backup_manifest.json"


def _bundle_file(bundle: Path, relative_path: str) -> Path:
    candidate = Path(relative_path)
    if (
        not relative_path
        or candidate.is_absolute()
        or any(part in {"", ".", ".."} for part in candidate.parts)
    ):
        raise ValueError("backup manifest contains an unsafe relative path")
    target = bundle / candidate
    if target.is_symlink():
        raise ValueError("backup bundle must not contain symlinked files")
    resolved_bundle = bundle.resolve()
    resolved_target = target.resolve()
    if resolved_target != resolved_bundle and resolved_bundle not in resolved_target.parents:
        raise ValueError("backup manifest path escapes the bundle")
    return resolved_target


def _artifact_records(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    records = manifest.get("artifacts", [])
    if not isinstance(records, list):
        raise ValueError("backup artifact inventory is invalid")
    validated: list[dict[str, Any]] = []
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("path"), str):
            raise ValueError("backup artifact inventory entry is invalid")
        size = record.get("size")
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise ValueError("backup artifact inventory size is invalid")
        digest = record.get("sha256")
        if digest is not None and (
            not isinstance(digest, str)
            or len(digest) != 64
            or any(char not in "0123456789abcdef" for char in digest)
        ):
            raise ValueError("backup artifact inventory hash is invalid")
        validated.append(record)
    return validated


def backup(args: argparse.Namespace) -> int:
    bundle = args.output.resolve()
    bundle.mkdir(parents=True, exist_ok=False)
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise ValueError("DATABASE_URL must be provided through the environment")
    environment = _database_environment(database_url)
    dump_path = bundle / "postgres.dump"
    _run(
        ["pg_dump", "--format=custom", "--no-owner", "--file", str(dump_path)],
        environment=environment,
    )
    snapshot_root = bundle / "artifacts" if args.copy_artifacts else None
    inventory = _artifact_inventory(args.artifact_root, copy_to=snapshot_root)
    manifest = {
        "schema": "rap-backup-v1",
        "created_at": datetime.now(UTC).isoformat(),
        "database_dump": {
            "path": dump_path.name,
            "size": dump_path.stat().st_size,
            "sha256": _sha256(dump_path),
        },
        "artifact_snapshot": snapshot_root is not None,
        "artifacts": inventory,
    }
    _manifest_path(bundle).write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"Backup bundle created: {bundle}")
    print(f"Artifact references recorded: {len(inventory)}")
    return 0


def _read_manifest(bundle: Path) -> dict[str, object]:
    try:
        manifest = json.loads(_manifest_path(bundle).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("backup_manifest.json is unreadable") from exc
    if not isinstance(manifest, dict) or manifest.get("schema") != "rap-backup-v1":
        raise ValueError("unsupported backup manifest schema")
    database_dump = manifest.get("database_dump")
    if not isinstance(database_dump, dict):
        raise ValueError("backup database dump metadata is invalid")
    dump_path = database_dump.get("path")
    dump_size = database_dump.get("size")
    dump_hash = database_dump.get("sha256")
    if (
        not isinstance(dump_path, str)
        or not isinstance(dump_size, int)
        or isinstance(dump_size, bool)
        or dump_size < 1
        or not isinstance(dump_hash, str)
        or len(dump_hash) != 64
        or any(char not in "0123456789abcdef" for char in dump_hash)
    ):
        raise ValueError("backup database dump metadata is invalid")
    _artifact_records(manifest)
    return manifest


def verify(args: argparse.Namespace) -> int:
    bundle = args.bundle.resolve()
    manifest = _read_manifest(bundle)
    dump = _bundle_file(bundle, str(manifest["database_dump"]["path"]))
    expected = manifest["database_dump"]
    if (
        not dump.is_file()
        or dump.stat().st_size != expected["size"]
        or _sha256(dump) != expected["sha256"]
    ):
        raise ValueError("PostgreSQL dump does not match the backup manifest")
    if manifest.get("artifact_snapshot"):
        snapshot = bundle / "artifacts"
        if snapshot.is_symlink() or not snapshot.is_dir():
            raise ValueError("artifact snapshot directory is invalid")
        for record in _artifact_records(manifest):
            path = _bundle_file(snapshot, str(record["path"]))
            if not path.is_file() or path.stat().st_size != record["size"]:
                raise ValueError(f"artifact snapshot is incomplete: {record['path']}")
            if record.get("sha256") and _sha256(path) != record["sha256"]:
                raise ValueError(f"artifact snapshot hash mismatch: {record['path']}")
    print(f"Backup bundle verified: {bundle}")
    return 0


def restore(args: argparse.Namespace) -> int:
    if args.confirm != "RESTORE":
        raise ValueError("restore requires --confirm RESTORE")
    bundle = args.bundle.resolve()
    manifest = _read_manifest(bundle)
    verify(argparse.Namespace(bundle=bundle))
    if args.artifact_root.exists() and args.artifact_root.is_symlink():
        raise ValueError("restore artifact target must not be a symlink")
    target_root = args.artifact_root.resolve()
    if target_root.exists() and any(target_root.iterdir()):
        raise ValueError("restore artifact target must be empty")
    target_root.mkdir(parents=True, exist_ok=True)
    if not manifest.get("artifact_snapshot"):
        raise ValueError("backup has references only; an artifact snapshot is required for restore")
    snapshot = bundle / "artifacts"
    for record in _artifact_records(manifest):
        source = _bundle_file(snapshot, str(record["path"]))
        if not source.is_file():
            raise ValueError(f"artifact snapshot is incomplete: {record['path']}")
        destination = target_root / Path(str(record["path"]))
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise ValueError("DATABASE_URL must be provided through the environment")
    environment = _database_environment(database_url)
    dump = _bundle_file(bundle, str(manifest["database_dump"]["path"]))
    _run(
        [
            "pg_restore",
            "--clean",
            "--if-exists",
            "--no-owner",
            "--dbname",
            environment["PGDATABASE"],
            str(dump),
        ],
        environment=environment,
    )
    print(f"Backup restored into the explicitly selected target: {bundle}")
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("backup", help="create a PostgreSQL/artifact bundle")
    create.add_argument("--artifact-root", type=Path, required=True)
    create.add_argument("--output", type=Path, required=True)
    create.add_argument("--copy-artifacts", action="store_true")
    check = commands.add_parser("verify", help="verify a bundle without touching PostgreSQL")
    check.add_argument("--bundle", type=Path, required=True)
    restore_parser = commands.add_parser("restore", help="restore into an isolated target")
    restore_parser.add_argument("--bundle", type=Path, required=True)
    restore_parser.add_argument("--artifact-root", type=Path, required=True)
    restore_parser.add_argument("--confirm", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        return {"backup": backup, "verify": verify, "restore": restore}[args.command](args)
    except (OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        print(f"Backup operation failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
