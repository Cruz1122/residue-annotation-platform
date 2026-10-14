from __future__ import annotations

import stat
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Protocol

import paramiko

from app.core.config import Settings


class InspectionError(RuntimeError):
    pass


def validate_relative_path(relative_path: str) -> PurePosixPath:
    path = PurePosixPath(relative_path)
    if path.is_absolute() or not relative_path or ".." in path.parts:
        raise InspectionError("path must be relative and confined to the inspection root")
    if any(not part or part.startswith(".") for part in path.parts):
        raise InspectionError("hidden and empty path components are not allowed")
    return path


@dataclass(frozen=True, slots=True)
class InspectionEntry:
    path: str
    size: int
    is_directory: bool


class ReadOnlyMN5Inspector(Protocol):
    def list(self, relative_dir: str = "") -> list[InspectionEntry]: ...

    def stat(self, relative_path: str) -> InspectionEntry: ...

    def read_preview(self, relative_path: str, limit: int) -> bytes: ...


class LocalReadOnlyInspector:
    def __init__(self, root: Path):
        self.root = root.resolve()

    def _resolve(self, relative_path: str) -> Path:
        relative = validate_relative_path(relative_path) if relative_path else PurePosixPath()
        candidate = self.root
        for part in relative.parts:
            candidate /= part
            if candidate.is_symlink():
                raise InspectionError("symlinks are not allowed")
        path = candidate.resolve()
        if path != self.root and self.root not in path.parents:
            raise InspectionError("path escapes inspection root")
        return path

    def list(self, relative_dir: str = "") -> list[InspectionEntry]:
        directory = self._resolve(relative_dir)
        if not directory.is_dir():
            raise InspectionError("not a directory")
        entries = []
        for child in sorted(directory.iterdir(), key=lambda item: item.name):
            if child.is_symlink() or child.name.startswith("."):
                continue
            entries.append(
                InspectionEntry(
                    str(child.relative_to(self.root)), child.stat().st_size, child.is_dir()
                )
            )
        return entries

    def stat(self, relative_path: str) -> InspectionEntry:
        path = self._resolve(relative_path)
        item = path.stat()
        return InspectionEntry(str(path.relative_to(self.root)), item.st_size, path.is_dir())

    def read_preview(self, relative_path: str, limit: int) -> bytes:
        if limit < 1:
            raise InspectionError("preview limit must be positive")
        path = self._resolve(relative_path)
        if not path.is_file():
            raise InspectionError("not a regular file")
        with path.open("rb") as stream:
            return stream.read(limit)


class SFTPReadOnlyInspector:
    def __init__(self, settings: Settings):
        if (
            not settings.hpc_ssh_host
            or not settings.hpc_ssh_username
            or not settings.hpc_ssh_password_file
        ):
            raise InspectionError("SFTP inspection profile is incomplete")
        self.settings = settings
        self.root = PurePosixPath(settings.mn5_root)

    def _connect(self) -> tuple[paramiko.SSHClient, paramiko.SFTPClient]:
        password_path = self.settings.hpc_ssh_password_file
        if password_path.stat().st_mode & 0o077:
            raise InspectionError("password file must not be accessible by group or others")
        password = password_path.read_text(encoding="utf-8").strip()
        client = paramiko.SSHClient()
        if self.settings.hpc_known_hosts_file:
            client.load_host_keys(str(self.settings.hpc_known_hosts_file))
        else:
            client.load_system_host_keys()
        client.set_missing_host_key_policy(paramiko.RejectPolicy())
        client.connect(
            hostname=self.settings.hpc_ssh_host,
            port=self.settings.hpc_ssh_port,
            username=self.settings.hpc_ssh_username,
            password=password,
            timeout=self.settings.hpc_command_timeout_seconds,
            allow_agent=False,
            look_for_keys=False,
        )
        return client, client.open_sftp()

    def _remote(self, relative_path: str = "") -> str:
        relative = validate_relative_path(relative_path) if relative_path else PurePosixPath()
        candidate = self.root.joinpath(*relative.parts)
        if self.root not in candidate.parents and candidate != self.root:
            raise InspectionError("path escapes inspection root")
        return str(candidate)

    def list(self, relative_dir: str = "") -> list[InspectionEntry]:
        client, sftp = self._connect()
        try:
            entries = []
            for attr in sorted(
                sftp.listdir_attr(self._remote(relative_dir)), key=lambda item: item.filename
            ):
                if attr.filename.startswith("."):
                    continue
                if stat.S_ISLNK(attr.st_mode):
                    continue
                is_directory = stat.S_ISDIR(attr.st_mode)
                path = (
                    str(PurePosixPath(relative_dir) / attr.filename)
                    if relative_dir
                    else attr.filename
                )
                entries.append(InspectionEntry(path, attr.st_size, is_directory))
            return entries
        finally:
            sftp.close()
            client.close()

    def stat(self, relative_path: str) -> InspectionEntry:
        client, sftp = self._connect()
        try:
            attr = sftp.lstat(self._remote(relative_path))
            if stat.S_ISLNK(attr.st_mode):
                raise InspectionError("symlinks are not allowed")
            return InspectionEntry(relative_path, attr.st_size, stat.S_ISDIR(attr.st_mode))
        finally:
            sftp.close()
            client.close()

    def read_preview(self, relative_path: str, limit: int) -> bytes:
        if limit < 1 or limit > self.settings.mn5_max_preview_bytes:
            raise InspectionError("preview exceeds configured limit")
        client, sftp = self._connect()
        try:
            attr = sftp.lstat(self._remote(relative_path))
            if stat.S_ISLNK(attr.st_mode) or not stat.S_ISREG(attr.st_mode):
                raise InspectionError("only regular files can be previewed")
            with sftp.open(self._remote(relative_path), "rb") as stream:
                return stream.read(limit)
        finally:
            sftp.close()
            client.close()


class InMemoryReadOnlyInspector:
    """Test-only fixture adapter; it has no product endpoint or write method."""

    def __init__(self, files: dict[str, bytes]):
        self.files = {str(validate_relative_path(path)): value for path, value in files.items()}

    def list(self, relative_dir: str = "") -> list[InspectionEntry]:
        prefix = f"{relative_dir.rstrip('/')}/" if relative_dir else ""
        return [
            InspectionEntry(path, len(value), False)
            for path, value in self.files.items()
            if path.startswith(prefix)
        ]

    def stat(self, relative_path: str) -> InspectionEntry:
        validate_relative_path(relative_path)
        try:
            value = self.files[relative_path]
        except KeyError as exc:
            raise InspectionError("file not found") from exc
        return InspectionEntry(relative_path, len(value), False)

    def read_preview(self, relative_path: str, limit: int) -> bytes:
        self.stat(relative_path)
        return self.files[relative_path][:limit]
