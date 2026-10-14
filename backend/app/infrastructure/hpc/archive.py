from __future__ import annotations

import hashlib
import tarfile
from pathlib import Path, PurePosixPath
from typing import BinaryIO


class ArchiveError(RuntimeError):
    """A remote artifact cannot be represented as a bounded safe archive."""


def _validate_archive_name(name: str) -> None:
    if not isinstance(name, str) or not name or "\\" in name or "\x00" in name:
        raise ArchiveError("remote artifact contains an unsafe archive name")
    if any(ord(character) < 32 or ord(character) == 127 for character in name):
        raise ArchiveError("remote artifact contains an unsafe archive name")
    path = PurePosixPath(name)
    if (
        path.is_absolute()
        or str(path) != name
        or any(part in {"", ".", ".."} for part in path.parts)
    ):
        raise ArchiveError("remote artifact contains an unsafe archive path")


class _SizedReader:
    def __init__(self, source: BinaryIO, expected_size: int):
        self.source = source
        self.remaining = expected_size

    def read(self, size: int = -1) -> bytes:
        if self.remaining == 0:
            return b""
        if size < 0:
            size = self.remaining
        data = self.source.read(min(size, self.remaining))
        self.remaining -= len(data)
        return data


class BoundedTarWriter:
    """Write a deterministic, bounded tar archive from verified entries."""

    def __init__(self, path: Path, *, max_bytes: int, max_entries: int):
        if max_bytes < 1 or max_entries < 1:
            raise ValueError("archive limits must be positive")
        self.path = path
        self.max_bytes = max_bytes
        self.max_entries = max_entries
        self._raw_bytes = 0
        self._entries = 0
        self._closed = False
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._tar = tarfile.open(self.path, mode="w", format=tarfile.PAX_FORMAT)

    def _reserve(self, size: int) -> None:
        if size < 0:
            raise ArchiveError("remote artifact has an invalid size")
        if self._entries >= self.max_entries:
            raise ArchiveError("remote artifact contains too many entries")
        if self._raw_bytes + size > self.max_bytes:
            raise ArchiveError("remote artifact exceeds the configured size limit")
        self._entries += 1
        self._raw_bytes += size

    @staticmethod
    def _info(name: str, *, directory: bool, size: int = 0) -> tarfile.TarInfo:
        _validate_archive_name(name)
        info = tarfile.TarInfo(name)
        info.size = size
        info.mtime = 0
        info.uid = 0
        info.gid = 0
        info.uname = ""
        info.gname = ""
        info.mode = 0o700 if directory else 0o600
        if directory:
            info.type = tarfile.DIRTYPE
        return info

    def add_directory(self, name: str) -> None:
        self._reserve(0)
        self._tar.addfile(self._info(name, directory=True))

    def add_file(self, name: str, source: BinaryIO, size: int) -> None:
        self._reserve(size)
        reader = _SizedReader(source, size)
        self._tar.addfile(self._info(name, directory=False, size=size), reader)
        if reader.remaining:
            raise ArchiveError("remote artifact changed while it was being read")

    def close(self) -> tuple[int, str]:
        if self._closed:
            raise RuntimeError("archive is already closed")
        self._tar.close()
        self._closed = True
        size = self.path.stat().st_size
        if size > self.max_bytes:
            raise ArchiveError("remote artifact archive exceeds the configured size limit")
        digest = hashlib.sha256()
        with self.path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        return size, digest.hexdigest()

    def abort(self) -> None:
        if not self._closed:
            self._tar.close()
            self._closed = True
        self.path.unlink(missing_ok=True)

    def __enter__(self) -> BoundedTarWriter:
        return self

    def __exit__(self, exc_type, _exc, _traceback) -> None:
        if exc_type is not None:
            self.abort()
            return
        try:
            self.close()
        except Exception:
            self.abort()
            raise
