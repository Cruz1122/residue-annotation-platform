from __future__ import annotations

import errno
import stat
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Literal, Protocol

import paramiko

from app.core.config import Settings
from app.infrastructure.hpc.ssh import assert_no_symlink_components


class InspectionError(RuntimeError):
    pass


AUTHORIZED_MN5_ROOT = "/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion"
_PREVIEW_SUFFIXES = frozenset(
    {
        ".pdb",
        ".pred",
        ".span",
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
_COMPOUND_PREVIEW_SUFFIXES = frozenset({".tsv.gz"})
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
_SFTP_TRANSPORT_ERRNOS = frozenset(
    {
        errno.ECONNABORTED,
        errno.ECONNREFUSED,
        errno.ECONNRESET,
        errno.EHOSTDOWN,
        errno.EHOSTUNREACH,
        errno.ENETDOWN,
        errno.ENETUNREACH,
        errno.ENOTCONN,
        errno.EPIPE,
        errno.ETIMEDOUT,
    }
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
    if path.suffix.lower() not in _PREVIEW_SUFFIXES and not any(
        filename.endswith(suffix) for suffix in _COMPOUND_PREVIEW_SUFFIXES
    ):
        raise InspectionError("file type is not allowed for preview")
    return path


@dataclass(frozen=True, slots=True)
class InspectionEntry:
    path: str
    size: int
    is_directory: bool


class ReadOnlyMN5Inspector(Protocol):
    def list(self, relative_dir: str = "") -> list[InspectionEntry]: ...

    def inspect_kind(
        self, relative_path: str
    ) -> Literal["file", "directory", "symlink", "special", "missing"]: ...

    def stat(self, relative_path: str) -> InspectionEntry: ...

    def read_preview(self, relative_path: str, limit: int) -> bytes: ...

    def read_many_previews(
        self, relative_paths: list[str], limit: int
    ) -> dict[str, bytes | None]: ...


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

    def inspect_kind(
        self, relative_path: str
    ) -> Literal["file", "directory", "symlink", "special", "missing"]:
        relative = validate_relative_path(relative_path)
        parent = self._resolve(str(relative.parent)) if str(relative.parent) != "." else self.root
        candidate = parent / relative.name
        try:
            attributes = candidate.lstat()
        except FileNotFoundError:
            return "missing"
        if candidate.is_symlink():
            return "symlink"
        if stat.S_ISDIR(attributes.st_mode):
            return "directory"
        if stat.S_ISREG(attributes.st_mode):
            return "file"
        return "special"

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

    def read_many_previews(self, relative_paths: list[str], limit: int) -> dict[str, bytes | None]:
        results: dict[str, bytes | None] = {}
        for path in relative_paths:
            try:
                results[path] = self.read_preview(path, limit)
            except (FileNotFoundError, InspectionError):
                results[path] = None
        return results


class NativeReadOnlyInspector(LocalReadOnlyInspector):
    """Read-only GPFS driver for an explicitly approved native host.

    The native profile is deliberately a constrained specialization of the
    local inspector. It never exposes the executor's Slurm methods and refuses
    to start unless the configured root is the exact project perimeter.
    """

    def __init__(self, settings: Settings):
        root = Path(settings.mn5_root)
        if settings.mn5_root != AUTHORIZED_MN5_ROOT:
            raise InspectionError("inspection root is not the authorized MN5 project root")
        try:
            metadata = root.lstat()
        except OSError as exc:
            raise InspectionError("native inspection root is unavailable") from exc
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise InspectionError("native inspection root is not a real directory")
        super().__init__(
            root,
            max_entries=settings.mn5_max_entries,
            max_preview_bytes=max(settings.mn5_max_preview_bytes, settings.mn5_max_artifact_bytes),
        )


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
            sftp = client.open_sftp()
            sftp.get_channel().settimeout(self.settings.hpc_command_timeout_seconds)
            return client, sftp
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

    def inspect_kind(
        self, relative_path: str
    ) -> Literal["file", "directory", "symlink", "special", "missing"]:
        relative = validate_relative_path(relative_path)
        client, sftp = self._connect()
        try:
            remote_path = self._remote(str(relative))
            parent = str(PurePosixPath(remote_path).parent)
            self._assert_safe(sftp, str(self.root), parent)
            try:
                attributes = sftp.lstat(remote_path)
            except FileNotFoundError:
                return "missing"
            mode = attributes.st_mode or 0
            if stat.S_ISLNK(mode):
                return "symlink"
            if stat.S_ISDIR(mode):
                return "directory"
            if stat.S_ISREG(mode):
                return "file"
            return "special"
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

    def read_many_previews(self, relative_paths: list[str], limit: int) -> dict[str, bytes | None]:
        """Read bounded regular files on one read-only SFTP connection."""

        if limit < 1 or limit > max(
            self.settings.mn5_max_preview_bytes, self.settings.mn5_max_artifact_bytes
        ):
            raise InspectionError("preview exceeds configured limit")
        paths = [str(_validate_preview_path(path)) for path in relative_paths]
        client, sftp = self._connect()
        try:
            results: dict[str, bytes | None] = {}
            for relative_path in paths:
                try:
                    remote_path = self._remote(relative_path)
                    self._assert_safe(sftp, str(self.root), remote_path)
                    attributes = sftp.lstat(remote_path)
                    if stat.S_ISLNK(attributes.st_mode or 0) or not stat.S_ISREG(
                        attributes.st_mode or 0
                    ):
                        raise InspectionError("only regular files can be previewed")
                    if attributes.st_size is None or attributes.st_size > limit:
                        raise InspectionError("preview exceeds configured limit")
                    with sftp.open(remote_path, "rb") as stream:
                        content = stream.read(limit + 1)
                    if len(content) > limit or len(content) != attributes.st_size:
                        raise InspectionError("remote preview changed while being read")
                    results[relative_path] = content
                except OSError as exc:
                    if isinstance(exc, (ConnectionError, TimeoutError)) or exc.errno in (
                        _SFTP_TRANSPORT_ERRNOS
                    ):
                        raise InspectionError("remote inspection is unavailable") from exc
                    results[relative_path] = None
                except InspectionError:
                    results[relative_path] = None
            return results
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
        directory_paths: list[str] | tuple[str, ...] = (),
        max_entries: int = 100,
        max_preview_bytes: int = 64_000,
    ):
        if max_entries < 1:
            raise ValueError("max_entries must be positive")
        if max_preview_bytes < 1:
            raise ValueError("max_preview_bytes must be positive")
        self.files = {str(validate_relative_path(path)): value for path, value in files.items()}
        self.directories: set[str] = set()
        for path in self.files:
            parent = PurePosixPath(path).parent
            while str(parent) != ".":
                self.directories.add(str(parent))
                parent = parent.parent
        for path in directory_paths:
            normalized = validate_relative_path(path)
            directory = normalized
            while str(directory) != ".":
                self.directories.add(str(directory))
                directory = directory.parent
        self.max_entries = max_entries
        self.max_preview_bytes = max_preview_bytes

    def list(self, relative_dir: str = "") -> list[InspectionEntry]:
        if relative_dir:
            validate_relative_path(relative_dir)
        base = PurePosixPath(relative_dir) if relative_dir else PurePosixPath()
        children: dict[str, InspectionEntry] = {}
        for path, value in self.files.items():
            candidate = PurePosixPath(path)
            try:
                remaining = candidate.relative_to(base)
            except ValueError:
                continue
            if not remaining.parts:
                continue
            child_name = remaining.parts[0]
            child_path = str(base / child_name) if relative_dir else child_name
            if len(remaining.parts) == 1:
                children[child_path] = InspectionEntry(child_path, len(value), False)
            else:
                children[child_path] = InspectionEntry(child_path, 0, True)
        for path in self.directories:
            candidate = PurePosixPath(path)
            try:
                remaining = candidate.relative_to(base)
            except ValueError:
                continue
            if not remaining.parts:
                continue
            child_path = str(base / remaining.parts[0]) if relative_dir else remaining.parts[0]
            children[child_path] = InspectionEntry(child_path, 0, True)
        if len(children) > self.max_entries:
            raise InspectionError("directory listing exceeds configured limit")
        if relative_dir and relative_dir not in self.directories:
            raise InspectionError("not a directory")
        entries = list(children.values())
        entries.sort(key=lambda item: item.path)
        return entries

    def inspect_kind(
        self, relative_path: str
    ) -> Literal["file", "directory", "symlink", "special", "missing"]:
        normalized = str(validate_relative_path(relative_path))
        if normalized in self.files:
            return "file"
        if normalized in self.directories:
            return "directory"
        return "missing"

    def stat(self, relative_path: str) -> InspectionEntry:
        normalized = str(validate_relative_path(relative_path))
        if normalized in self.files:
            return InspectionEntry(normalized, len(self.files[normalized]), False)
        if normalized in self.directories:
            return InspectionEntry(normalized, 0, True)
        raise InspectionError("file not found")

    def read_preview(self, relative_path: str, limit: int) -> bytes:
        if limit < 1 or limit > self.max_preview_bytes:
            raise InspectionError("preview exceeds configured limit")
        normalized = _validate_preview_path(relative_path)
        self.stat(str(normalized))
        return self.files[str(normalized)][:limit]

    def read_many_previews(self, relative_paths: list[str], limit: int) -> dict[str, bytes | None]:
        result: dict[str, bytes | None] = {}
        for path in relative_paths:
            try:
                result[path] = self.read_preview(path, limit)
            except InspectionError:
                result[path] = None
        return result


def build_read_only_inspector(settings: Settings) -> ReadOnlyMN5Inspector:
    """Select an explicitly enabled read-only driver.

    There is intentionally no implicit fallback from an unavailable remote
    profile to a local path: callers must choose ``mock`` for tests or repair
    the configured SFTP/native perimeter.
    """

    if not settings.mn5_inspection_enabled:
        raise InspectionError("MN5 read-only inspection is disabled")
    if settings.mn5_inspection_mode == "mock":
        return InMemoryReadOnlyInspector(
            {},
            max_entries=settings.mn5_max_entries,
            max_preview_bytes=max(settings.mn5_max_preview_bytes, settings.mn5_max_artifact_bytes),
        )
    if settings.mn5_inspection_mode == "ssh_sftp":
        return SFTPReadOnlyInspector(settings)
    if settings.mn5_inspection_mode == "native":
        return NativeReadOnlyInspector(settings)
    raise InspectionError("MN5 read-only inspection mode is disabled")
