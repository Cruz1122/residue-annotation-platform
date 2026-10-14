from __future__ import annotations

import hashlib
from collections.abc import Iterator
from pathlib import Path

from app.core.config import Settings


class ArtifactPathError(ValueError):
    pass


def safe_storage_path(root: Path, storage_key: str) -> Path:
    if not storage_key:
        raise ArtifactPathError("artifact key cannot be empty")
    candidate = Path(storage_key)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise ArtifactPathError("invalid artifact key")
    if any(part.startswith(".") for part in candidate.parts):
        raise ArtifactPathError("hidden artifact paths are not allowed")
    resolved_root = root.resolve()
    candidate_path = resolved_root / candidate
    current = resolved_root
    for part in candidate.parts:
        current /= part
        if current.is_symlink():
            raise ArtifactPathError("symlink artifacts are not supported")
    resolved_path = candidate_path.resolve()
    if resolved_path != resolved_root and resolved_root not in resolved_path.parents:
        raise ArtifactPathError("artifact path escapes storage root")
    return resolved_path


class ArtifactStore:
    def __init__(self, settings: Settings):
        self.root = settings.artifact_root.resolve()

    def resolve(self, storage_key: str) -> Path:
        path = safe_storage_path(self.root, storage_key)
        if path.is_symlink():
            raise ArtifactPathError("symlink artifacts are not supported")
        return path

    def metadata(self, storage_key: str) -> tuple[int, str]:
        path = self.resolve(storage_key)
        stat = path.stat()
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        return stat.st_size, digest.hexdigest()

    def iter_bytes(self, storage_key: str, chunk_size: int = 1024 * 1024) -> Iterator[bytes]:
        path = self.resolve(storage_key)
        with path.open("rb") as stream:
            while chunk := stream.read(chunk_size):
                yield chunk
