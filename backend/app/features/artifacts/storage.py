from __future__ import annotations

import hashlib
import os
import stat
from collections.abc import Iterator
from pathlib import Path
from typing import BinaryIO

from app.core.config import Settings


class ArtifactPathError(ValueError):
    pass


class ArtifactIntegrityError(ValueError):
    """The bytes on disk do not match the database record."""


def safe_storage_path(root: Path, storage_key: str) -> Path:
    if not storage_key:
        raise ArtifactPathError("artifact key cannot be empty")
    candidate = Path(storage_key)
    if (
        not candidate.parts
        or candidate.is_absolute()
        or any(part in {"", ".", ".."} for part in candidate.parts)
    ):
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
        # Keep the shared volume traversable by the backend and the native
        # worker's supplemental app group. The setgid bit makes descendants
        # inherit that group even when the native account has another primary
        # cluster GID.
        self.root.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.root, 0o2770)
        except PermissionError:
            # The VPN/native worker intentionally runs with a different UID
            # and reaches this directory through the supplemental app group.
            # It cannot chmod a backend-owned volume root, but it must not
            # silently accept a root that is not group-traversable either.
            mode = self.root.stat().st_mode
            if not (mode & stat.S_ISGID) or (mode & 0o070) != 0o070:
                raise

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

    def open_verified(self, storage_key: str, *, size: int, sha256: str) -> BinaryIO:
        """Open and verify one immutable descriptor before it is streamed.

        The caller receives the same descriptor that was hashed. Re-opening the
        storage path after verification would allow a path replacement (for
        example, a symlink swap) to bypass the integrity check between the
        metadata read and the HTTP stream.
        """

        path = self.resolve(storage_key)
        flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        if hasattr(os, "O_NONBLOCK"):
            flags |= os.O_NONBLOCK
        descriptor = os.open(path, flags)
        stream: BinaryIO | None = None
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise ArtifactPathError("artifact is not a regular file")
            stream = os.fdopen(descriptor, "rb")
            descriptor = -1
        except Exception:
            if stream is not None:
                stream.close()
            elif descriptor != -1:
                os.close(descriptor)
            raise
        try:
            descriptor_size = stream.seek(0, 2)
            if descriptor_size != size:
                raise ArtifactIntegrityError("artifact content does not match its record")
            stream.seek(0)
            digest = hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
            if digest.hexdigest() != sha256:
                raise ArtifactIntegrityError("artifact content does not match its record")
            stream.seek(0)
            return stream
        except Exception:
            stream.close()
            raise

    @staticmethod
    def iter_open(stream: BinaryIO, chunk_size: int = 1024 * 1024) -> Iterator[bytes]:
        """Yield an already verified stream and close it on completion."""

        try:
            while chunk := stream.read(chunk_size):
                yield chunk
        finally:
            stream.close()

    def iter_bytes(self, storage_key: str, chunk_size: int = 1024 * 1024) -> Iterator[bytes]:
        path = self.resolve(storage_key)
        with path.open("rb") as stream:
            while chunk := stream.read(chunk_size):
                yield chunk
