from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from copy import deepcopy
from pathlib import Path, PurePosixPath
from typing import Any


class ManifestError(ValueError):
    pass


_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _valid_size(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def validate_manifest(manifest: dict[str, Any], expected_stage_id: str) -> None:
    if manifest.get("manifest_version") != "1":
        raise ManifestError("unsupported manifest version")
    if manifest.get("stage_id") != expected_stage_id:
        raise ManifestError("manifest stage does not match the requested stage")
    if manifest.get("status") != "success":
        raise ManifestError("only success manifests can be published")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise ManifestError("manifest must list at least one artifact")
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            raise ManifestError("invalid artifact entry")
        storage_key = artifact.get("storage_key")
        sha256 = artifact.get("sha256")
        if (
            not isinstance(storage_key, str)
            or not storage_key
            or not isinstance(sha256, str)
            or not _SHA256.fullmatch(sha256)
            or not _valid_size(artifact.get("size"))
        ):
            raise ManifestError("artifact provenance is incomplete")
        if Path(storage_key).is_absolute() or any(
            part in {"", ".", ".."} for part in Path(storage_key).parts
        ):
            raise ManifestError("manifest contains an unsafe storage key")
    provenance = manifest.get("provenance")
    if (
        not isinstance(provenance, dict)
        or not provenance.get("tool")
        or not provenance.get("version")
    ):
        raise ManifestError("manifest provenance is incomplete")


def validate_remote_manifest(manifest: dict[str, Any], expected_stage_id: str) -> None:
    """Validate the stage-result-v1 manifest emitted by the MN5 pipeline."""

    if manifest.get("schema") != "stage-result-v1":
        raise ManifestError("unsupported remote manifest schema")
    if manifest.get("stage_id") != expected_stage_id:
        raise ManifestError("remote manifest stage does not match the requested stage")
    if manifest.get("status") != "success":
        raise ManifestError("only successful remote manifests can be published")
    if manifest.get("partial") is True:
        raise ManifestError("partial remote manifests cannot be published")
    cache_key = manifest.get("cache_key")
    if not isinstance(cache_key, str) or not _SHA256.fullmatch(cache_key):
        raise ManifestError("remote manifest cache key is invalid")

    annotations = manifest.get("annotations")
    if not isinstance(annotations, str) or not annotations:
        raise ManifestError("remote manifest annotations path is missing")
    annotation_path = Path(annotations)
    if annotation_path.is_absolute() or any(part in {".", ".."} for part in annotation_path.parts):
        raise ManifestError("remote manifest annotations path is unsafe")

    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, dict) or not artifacts:
        raise ManifestError("remote manifest must list artifacts")
    for artifact_name, artifact in artifacts.items():
        if not isinstance(artifact_name, str) or not artifact_name:
            raise ManifestError("remote manifest artifact name is invalid")
        if not isinstance(artifact, dict):
            raise ManifestError("remote manifest artifact entry is invalid")
        path = artifact.get("path")
        sha256 = artifact.get("sha256")
        size = artifact.get("size")
        external = artifact.get("external")
        if (
            not isinstance(path, str)
            or not path
            or Path(path).is_absolute()
            or any(part in {".", ".."} for part in Path(path).parts)
            or not isinstance(sha256, str)
            or not _SHA256.fullmatch(sha256)
            or not _valid_size(size)
            or (external is not None and not isinstance(external, bool))
        ):
            raise ManifestError(f"remote manifest artifact {artifact_name!r} is invalid")

    integrity = manifest.get("file_integrity")
    if integrity is not None:
        if not isinstance(integrity, dict):
            raise ManifestError("remote manifest file integrity is invalid")
        for name, record in integrity.items():
            if not isinstance(name, str) or not isinstance(record, dict):
                raise ManifestError("remote manifest file integrity entry is invalid")
            if "size" in record and not _valid_size(record["size"]):
                raise ManifestError(f"remote manifest file integrity size is invalid: {name}")
            if "sha256" in record and not (
                isinstance(record["sha256"], str) and _SHA256.fullmatch(record["sha256"])
            ):
                raise ManifestError(f"remote manifest file integrity hash is invalid: {name}")


def normalize_remote_manifest_paths(manifest: dict[str, Any], remote_root: str) -> dict[str, Any]:
    """Convert in-root absolute artifact paths to safe result-relative paths.

    Some existing MN5 result manifests record artifact paths as absolute GPFS
    paths. Those paths are useful to the remote producer but must never cross
    the application boundary. Normalization happens on a detached copy before
    validation and ingestion, and rejects absolute paths outside the configured
    project root instead of trying to guess their meaning.
    """

    root = PurePosixPath(remote_root)
    if not root.is_absolute():
        raise ManifestError("configured remote root must be absolute")

    normalized = deepcopy(manifest)
    artifacts = normalized.get("artifacts")
    if not isinstance(artifacts, dict):
        return normalized
    for artifact_name, artifact in artifacts.items():
        if not isinstance(artifact, dict):
            continue
        path = artifact.get("path")
        if not isinstance(path, str):
            continue
        candidate = PurePosixPath(path)
        if not candidate.is_absolute():
            continue
        try:
            relative = candidate.relative_to(root)
        except ValueError as exc:
            raise ManifestError(
                f"remote manifest artifact {artifact_name!r} is outside the configured root"
            ) from exc
        if not relative.parts:
            raise ManifestError(f"remote manifest artifact {artifact_name!r} is empty")
        artifact["path"] = str(relative)
        artifact["external"] = True
    return normalized


def sha256_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def atomic_write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    validate_manifest(manifest, str(manifest["stage_id"]))
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=path.parent, delete=False
        ) as stream:
            temporary = Path(stream.name)
            json.dump(manifest, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        # Best-effort directory fsync so the rename survives abrupt power loss.
        if hasattr(os, "O_DIRECTORY"):
            try:
                directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
