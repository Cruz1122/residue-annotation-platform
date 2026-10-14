from __future__ import annotations

import stat
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Protocol

import paramiko

from app.core.config import Settings
from app.infrastructure.hpc.ssh import assert_no_symlink_components


class InspectionError(RuntimeError):
    pass


AUTHORIZED_MN5_ROOT = "/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion"
_PREVIEW_SUFFIXES = frozenset(
    {
        ".pdb",
        ".cif",
        ".mmcif",
        ".tsv",
        ".csv",
        ".json",
        ".fasta",
        ".fa",
        ".faa",
        ".txt",
        ".log",
        ".md",
    }
)
_SENSITIVE_NAME_MARKERS = (
    "password",
    "passwd",
    "secret",
    "credential",
    "private",
    "id_rsa",
    "id_ed25519",
    "authorized_keys",
    "known_hosts",
)


def validate_relative_path(relative_path: str) -> PurePosixPath:
    if (
        "\\" in relative_path
        or "%" in relative_path
        or any(ord(character) < 32 for character in relative_path)
    ):
        raise InspectionError("path contains unsafe characters")
    raw_parts = relative_path.split("/")
    if any(part in {"", ".", ".."} for part in raw_parts):
        raise InspectionError("path must use normalized non-empty components")
    path = PurePosixPath(relative_path)
    if path.is_absolute() or not relative_path or ".." in path.parts:
        raise InspectionError("path must be relative and confined to the inspection root")
    if any(not part or part.startswith(".") for part in path.parts):
        raise InspectionError("hidden and empty path components are not allowed")
    return path


def _validate_preview_path(relative_path: str) -> PurePosixPath:
    path = validate_relative_path(relative_path)
    filename = path.name.lower()
    if any(marker in filename for marker in _SENSITIVE_NAME_MARKERS):
        raise InspectionError("sensitive files cannot be previewed")
    if path.suffix.lower() not in _PREVIEW_SUFFIXES:
        raise InspectionError("file type is not allowed for preview")
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
    def __init__(
        self,
        root: Path,
        *,
        max_entries: int = 100,
        max_preview_bytes: int = 64_000,
    ):
        if max_entries < 1:
            raise ValueError("max_entries must be positive")
        if max_preview_bytes < 1:
            raise ValueError("max_preview_bytes must be positive")
        self.root = root.resolve()
        self.max_entries = max_entries
        self.max_preview_bytes = max_preview_bytes

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
        for index, child in enumerate(directory.iterdir()):
            if index >= self.max_entries:
                raise InspectionError("directory listing exceeds configured limit")
            if child.is_symlink() or child.name.startswith("."):
                continue
            is_directory = child.is_dir()
            if not is_directory and not child.is_file():
                continue
            entries.append(
                InspectionEntry(
                    str(child.relative_to(self.root)), child.stat().st_size, is_directory
                )
            )
        entries.sort(key=lambda item: item.path)
        return entries

    def stat(self, relative_path: str) -> InspectionEntry:
        path = self._resolve(relative_path)
        item = path.stat()
        if not item.is_dir() and not item.is_file():
            raise InspectionError("special files are not supported")
        return InspectionEntry(str(path.relative_to(self.root)), item.st_size, path.is_dir())

    def read_preview(self, relative_path: str, limit: int) -> bytes:
        if limit < 1 or limit > self.max_preview_bytes:
            raise InspectionError("preview exceeds configured limit")
        path = self._resolve(str(_validate_preview_path(relative_path)))
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
        password_path = settings.hpc_ssh_password_file
        if password_path.is_symlink() or not password_path.is_file():
            raise InspectionError("password file must be a regular file")
        if password_path.stat().st_mode & 0o077:
            raise InspectionError("password file must not be accessible by group or others")
        if not password_path.read_text(encoding="utf-8").strip():
            raise InspectionError("password file is empty")
        if settings.mn5_root != AUTHORIZED_MN5_ROOT:
            raise InspectionError("inspection root is not the authorized MN5 project root")
        self.settings = settings
        self.root = PurePosixPath(settings.mn5_root)

    def _connect(self) -> tuple[paramiko.SSHClient, paramiko.SFTPClient]:
        password_path = self.settings.hpc_ssh_password_file
        try:
            if password_path.is_symlink() or not password_path.is_file():
                raise InspectionError("password file must be a regular file")
            if password_path.stat().st_mode & 0o077:
                raise InspectionError("password file must not be accessible by group or others")
            password = password_path.read_text(encoding="utf-8").strip()
        except InspectionError:
            raise
        except (OSError, UnicodeError) as exc:
            raise InspectionError("could not read the password file") from exc
        if not password:
            raise InspectionError("password file is empty")
        client = paramiko.SSHClient()
        try:
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
        except InspectionError:
            client.close()
            raise
        except Exception as exc:
            client.close()
            raise InspectionError("remote inspection is unavailable") from exc

    @staticmethod
    def _assert_safe(sftp: paramiko.SFTPClient, root: str, path: str) -> None:
        try:
            assert_no_symlink_components(sftp, root, path)
        except RuntimeError as exc:
            raise InspectionError("remote path is not safely readable") from exc

    def _remote(self, relative_path: str = "") -> str:
        relative = validate_relative_path(relative_path) if relative_path else PurePosixPath()
        candidate = self.root.joinpath(*relative.parts)
        if self.root not in candidate.parents and candidate != self.root:
            raise InspectionError("path escapes inspection root")
        return str(candidate)

    def list(self, relative_dir: str = "") -> list[InspectionEntry]:
        client, sftp = self._connect()
        try:
            remote_dir = self._remote(relative_dir)
            self._assert_safe(sftp, str(self.root), remote_dir)
            entries = []
            for index, attr in enumerate(sftp.listdir_iter(remote_dir, read_aheads=16)):
                if index >= self.settings.mn5_max_entries:
                    raise InspectionError("directory listing exceeds configured limit")
                if attr.filename.startswith("."):
                    continue
                if stat.S_ISLNK(attr.st_mode):
                    continue
                is_directory = stat.S_ISDIR(attr.st_mode)
                if not is_directory and not stat.S_ISREG(attr.st_mode):
                    continue
                path = (
                    str(PurePosixPath(relative_dir) / attr.filename)
                    if relative_dir
                    else attr.filename
                )
                entries.append(InspectionEntry(path, attr.st_size, is_directory))
            return entries
        except InspectionError:
            raise
        except Exception as exc:
            raise InspectionError("remote inspection is unavailable") from exc
        finally:
            sftp.close()
            client.close()

    def stat(self, relative_path: str) -> InspectionEntry:
        client, sftp = self._connect()
        try:
            remote_path = self._remote(relative_path)
            self._assert_safe(sftp, str(self.root), remote_path)
            attr = sftp.lstat(remote_path)
            if stat.S_ISLNK(attr.st_mode):
                raise InspectionError("symlinks are not allowed")
            if not stat.S_ISDIR(attr.st_mode) and not stat.S_ISREG(attr.st_mode):
                raise InspectionError("special files are not supported")
            return InspectionEntry(relative_path, attr.st_size, stat.S_ISDIR(attr.st_mode))
        except InspectionError:
            raise
        except Exception as exc:
            raise InspectionError("remote inspection is unavailable") from exc
        finally:
            sftp.close()
            client.close()

    def read_preview(self, relative_path: str, limit: int) -> bytes:
        if limit < 1 or limit > self.settings.mn5_max_preview_bytes:
            raise InspectionError("preview exceeds configured limit")
        relative = _validate_preview_path(relative_path)
        client, sftp = self._connect()
        try:
            remote_path = self._remote(str(relative))
            self._assert_safe(sftp, str(self.root), remote_path)
            attr = sftp.lstat(remote_path)
            if stat.S_ISLNK(attr.st_mode) or not stat.S_ISREG(attr.st_mode):
                raise InspectionError("only regular files can be previewed")
            with sftp.open(remote_path, "rb") as stream:
                return stream.read(limit)
        except InspectionError:
            raise
        except Exception as exc:
            raise InspectionError("remote inspection is unavailable") from exc
        finally:
            sftp.close()
            client.close()


class InMemoryReadOnlyInspector:
    """Test-only fixture adapter; it has no product endpoint or write method."""

    def __init__(
        self,
        files: dict[str, bytes],
        *,
        max_entries: int = 100,
        max_preview_bytes: int = 64_000,
    ):
        if max_entries < 1:
            raise ValueError("max_entries must be positive")
        if max_preview_bytes < 1:
            raise ValueError("max_preview_bytes must be positive")
        self.files = {str(validate_relative_path(path)): value for path, value in files.items()}
        self.max_entries = max_entries
        self.max_preview_bytes = max_preview_bytes

    def list(self, relative_dir: str = "") -> list[InspectionEntry]:
        if relative_dir:
            validate_relative_path(relative_dir)
        prefix = f"{relative_dir.rstrip('/')}/" if relative_dir else ""
        entries = []
        for path, value in self.files.items():
            if not path.startswith(prefix):
                continue
            entries.append(InspectionEntry(path, len(value), False))
            if len(entries) > self.max_entries:
                raise InspectionError("directory listing exceeds configured limit")
        entries.sort(key=lambda item: item.path)
        return entries

    def stat(self, relative_path: str) -> InspectionEntry:
        validate_relative_path(relative_path)
        try:
            value = self.files[relative_path]
        except KeyError as exc:
            raise InspectionError("file not found") from exc
        return InspectionEntry(relative_path, len(value), False)

    def read_preview(self, relative_path: str, limit: int) -> bytes:
        if limit < 1 or limit > self.max_preview_bytes:
            raise InspectionError("preview exceeds configured limit")
        _validate_preview_path(relative_path)
        self.stat(relative_path)
        return self.files[relative_path][:limit]
