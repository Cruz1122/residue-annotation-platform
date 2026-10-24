from __future__ import annotations

import errno
import hashlib
import logging
import os
import re
import shlex
import stat
import subprocess
from pathlib import Path, PurePosixPath
from uuid import uuid4

from app.core.config import Settings
from app.infrastructure.hpc.archive import ArchiveError, BoundedTarWriter, BoundedZipWriter
from app.infrastructure.hpc.base import (
    HPCConfigurationError,
    HPCRequestTooLargeError,
    HPCSubmissionAmbiguousError,
    HPCTransportError,
    JobHandle,
    JobRequest,
    JobState,
    JobStatus,
    PrefetchRequest,
    PrefetchResult,
    job_environment_path,
    parse_prefetch_result,
    prefetch_environment_path,
    render_environment_script,
    render_prefetch_command,
    split_job_environment,
)

logger = logging.getLogger(__name__)

_TRANSIENT_FILESYSTEM_ERRNOS = frozenset(
    {
        errno.EIO,
        errno.ESTALE,
        errno.ENODEV,
        errno.ENOTCONN,
        errno.ECONNRESET,
        errno.EHOSTDOWN,
        errno.EHOSTUNREACH,
        errno.ENETDOWN,
        errno.ENETUNREACH,
        errno.EPIPE,
        errno.ETIMEDOUT,
    }
)


_TRANSIENT_SLURM_ERRNOS = frozenset(
    {
        errno.ECONNABORTED,
        errno.ECONNREFUSED,
        errno.ECONNRESET,
        errno.ENOTCONN,
        errno.EPIPE,
        errno.ETIMEDOUT,
    }
)


def _native_directory_flags() -> int:
    """Return flags required for descriptor-relative, no-follow traversal."""

    if not hasattr(os, "O_DIRECTORY") or not hasattr(os, "O_NOFOLLOW"):
        raise RuntimeError("native confined filesystem access needs no-follow support")
    return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)


def _native_file_flags() -> int:
    if not hasattr(os, "O_NOFOLLOW"):
        raise RuntimeError("native confined filesystem access needs no-follow support")
    return os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)


def _raise_native_symlink_error(error: OSError) -> None:
    if error.errno == errno.ELOOP:
        raise RuntimeError("native HPC path uses a symlinked component") from error
    raise error


def _open_confined_path(root: Path, target: Path, *, directory: bool) -> int:
    """Open a path below ``root`` without following any component symlink."""

    relative = target.relative_to(root)
    if not relative.parts:
        if not directory:
            raise RuntimeError("native HPC path must name a regular file")
        try:
            return os.open(root, _native_directory_flags())
        except OSError as exc:
            _raise_native_symlink_error(exc)

    parent_fd: int | None = None
    try:
        parent_fd = os.open(root, _native_directory_flags())
        for component in relative.parts[:-1]:
            try:
                child_fd = os.open(
                    component,
                    _native_directory_flags(),
                    dir_fd=parent_fd,
                )
            except OSError as exc:
                _raise_native_symlink_error(exc)
            os.close(parent_fd)
            parent_fd = child_fd
        flags = _native_directory_flags() if directory else _native_file_flags()
        try:
            return os.open(relative.parts[-1], flags, dir_fd=parent_fd)
        except OSError as exc:
            _raise_native_symlink_error(exc)
    finally:
        if parent_fd is not None:
            os.close(parent_fd)


def _open_or_create_confined_directory(root: Path, target: Path) -> None:
    """Create a directory tree below ``root`` with no-follow dirfds."""

    relative = target.relative_to(root)
    if not relative.parts:
        return
    current_fd: int | None = None
    try:
        current_fd = os.open(root, _native_directory_flags())
        for component in relative.parts:
            try:
                child_fd = os.open(
                    component,
                    _native_directory_flags(),
                    dir_fd=current_fd,
                )
            except FileNotFoundError:
                try:
                    os.mkdir(component, mode=0o700, dir_fd=current_fd)
                except FileExistsError:
                    # Another process created it. The no-follow open below is
                    # still authoritative and rejects a symlink or file.
                    pass
                try:
                    child_fd = os.open(
                        component,
                        _native_directory_flags(),
                        dir_fd=current_fd,
                    )
                except OSError as exc:
                    _raise_native_symlink_error(exc)
            except OSError as exc:
                _raise_native_symlink_error(exc)
            os.close(current_fd)
            current_fd = child_fd
    finally:
        if current_fd is not None:
            os.close(current_fd)


def _rethrow_native_transport_error(error: Exception) -> None:
    if isinstance(error, HPCTransportError):
        raise error
    if isinstance(error, (ConnectionError, EOFError, TimeoutError)):
        raise HPCTransportError("native HPC transport is unavailable") from error
    if isinstance(error, OSError) and error.errno in _TRANSIENT_FILESYSTEM_ERRNOS:
        raise HPCTransportError("native HPC transport is unavailable") from error


def _rethrow_native_slurm_transport_error(error: Exception) -> None:
    if isinstance(error, HPCTransportError):
        raise error
    if isinstance(error, (ConnectionError, EOFError, TimeoutError)):
        raise HPCTransportError("native Slurm transport is unavailable") from error
    if isinstance(error, OSError) and error.errno in _TRANSIENT_SLURM_ERRNOS:
        raise HPCTransportError("native Slurm transport is unavailable") from error


class NativeSlurmClient:
    """Run Slurm commands only on an explicitly approved native BSC host."""

    def __init__(self, settings: Settings):
        self.settings = settings

    def _root_path(self) -> Path:
        root = Path(self.settings.hpc_remote_root)
        if not root.is_absolute() or root.is_symlink() or not root.is_dir():
            raise RuntimeError("configured native HPC root is not a real directory")
        return root.resolve()

    def _confined_path(self, remote_path: str) -> Path:
        root = self._root_path()
        if any(part in {".", ".."} for part in remote_path.split("/")):
            raise RuntimeError("native HPC path contains an unsafe component")
        candidate = PurePosixPath(remote_path)
        if not candidate.is_absolute():
            raise RuntimeError("native HPC path must be absolute")
        try:
            relative = candidate.relative_to(PurePosixPath(root))
        except ValueError as exc:
            raise RuntimeError("native HPC path is outside the configured root") from exc
        current = root
        for part in relative.parts:
            current /= part
            if current.is_symlink():
                raise RuntimeError("native HPC path uses a symlinked component")
        return current

    def ensure_directory(self, remote_path: str) -> None:
        """Create a job directory below the approved local GPFS root."""

        try:
            root = self._root_path()
            target = self._confined_path(remote_path)
            _open_or_create_confined_directory(root, target)
        except Exception as exc:
            _rethrow_native_transport_error(exc)
            raise

    def _write_environment_file(self, remote_path: str, contents: bytes) -> None:
        """Create a private environment file below the approved HPC root."""

        self.ensure_directory(str(PurePosixPath(remote_path).parent))
        try:
            existing = self.read_bytes(remote_path, len(contents) + 1)
        except FileNotFoundError:
            existing = None
        if existing is not None:
            if existing != contents:
                raise HPCConfigurationError(
                    "a different environment file already exists for this HPC stage"
                )
            return
        root = self._root_path()
        target = self._confined_path(remote_path)
        parent_fd = _open_confined_path(root, target.parent, directory=True)
        descriptor: int | None = None
        completed = False
        try:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            descriptor = os.open(target.name, flags, 0o600, dir_fd=parent_fd)
            with os.fdopen(descriptor, "wb") as stream:
                descriptor = None
                stream.write(contents)
                stream.flush()
                os.fsync(stream.fileno())
            completed = True
        finally:
            if descriptor is not None:
                os.close(descriptor)
            if not completed:
                try:
                    os.unlink(target.name, dir_fd=parent_fd)
                except FileNotFoundError:
                    pass
            os.close(parent_fd)

    def _remove_environment_file(self, remote_path: str) -> None:
        root = self._root_path()
        target = self._confined_path(remote_path)
        parent_fd = _open_confined_path(root, target.parent, directory=True)
        try:
            try:
                os.unlink(target.name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
        finally:
            os.close(parent_fd)

    def remove_environment_file(self, remote_path: str) -> None:
        if not re.fullmatch(
            r"\.[A-Za-z0-9_-]+\.environment(?:\.[a-f0-9]{32})?\.sh",
            PurePosixPath(remote_path).name,
        ):
            raise HPCConfigurationError("HPC environment cleanup path is invalid")
        self._remove_environment_file(remote_path)

    def remove_stage_environment_files(self, remote_directory: str, stage_id: str) -> None:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", stage_id):
            raise HPCConfigurationError("HPC stage id is invalid for environment cleanup")
        root = self._root_path()
        directory = self._confined_path(remote_directory)
        directory_fd = _open_confined_path(root, directory, directory=True)
        prefix = f".{stage_id}.environment."
        try:
            with os.scandir(directory_fd) as entries:
                for entry in entries:
                    if not entry.name.startswith(prefix) or not entry.name.endswith(".sh"):
                        continue
                    if not re.fullmatch(
                        rf"\.{re.escape(stage_id)}\.environment\.[a-f0-9]{{32}}\.sh",
                        entry.name,
                    ):
                        continue
                    attributes = entry.stat(follow_symlinks=False)
                    if stat.S_ISREG(attributes.st_mode):
                        os.unlink(entry.name, dir_fd=directory_fd)
        finally:
            os.close(directory_fd)

    def read_bytes(self, remote_path: str, max_bytes: int) -> bytes:
        if max_bytes < 1:
            raise ValueError("max_bytes must be positive")
        descriptor: int | None = None
        try:
            root = self._root_path()
            path = self._confined_path(remote_path)
            descriptor = _open_confined_path(root, path, directory=False)
            attributes = os.fstat(descriptor)
            if not stat.S_ISREG(attributes.st_mode):
                raise RuntimeError("native HPC result is not a regular file")
            if attributes.st_size > max_bytes:
                raise RuntimeError("native HPC result exceeds the configured size limit")
            with os.fdopen(descriptor, "rb") as stream:
                descriptor = None
                data = stream.read(max_bytes + 1)
                final_attributes = os.fstat(stream.fileno())
            if len(data) > max_bytes:
                raise RuntimeError("native HPC result exceeds the configured size limit")
            if final_attributes.st_size != attributes.st_size:
                raise RuntimeError("native HPC result changed while it was being read")
            return data
        except Exception as exc:
            _rethrow_native_transport_error(exc)
            raise
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def read_text(self, remote_path: str, max_bytes: int) -> str:
        return self.read_bytes(remote_path, max_bytes).decode("utf-8")

    def download_to(self, remote_path: str, local_path: Path, max_bytes: int) -> tuple[int, str]:
        """Copy a verified native result file into the application artifact store."""

        if max_bytes < 1:
            raise ValueError("max_bytes must be positive")
        descriptor: int | None = None
        try:
            root = self._root_path()
            source = self._confined_path(remote_path)
            descriptor = _open_confined_path(root, source, directory=False)
            attributes = os.fstat(descriptor)
            if not stat.S_ISREG(attributes.st_mode):
                raise RuntimeError("native HPC result is not a regular file")
            if attributes.st_size > max_bytes:
                raise RuntimeError("native HPC result exceeds the configured size limit")
            digest = hashlib.sha256()
            total = 0
            local_path.parent.mkdir(parents=True, exist_ok=True)
            with os.fdopen(descriptor, "rb") as source_stream:
                descriptor = None
                with local_path.open("wb") as target_stream:
                    while chunk := source_stream.read(min(1024 * 1024, max_bytes + 1 - total)):
                        total += len(chunk)
                        if total > max_bytes:
                            raise RuntimeError(
                                "native HPC result exceeds the configured size limit"
                            )
                        digest.update(chunk)
                        target_stream.write(chunk)
                final_attributes = os.fstat(source_stream.fileno())
            if total != attributes.st_size or final_attributes.st_size != attributes.st_size:
                raise RuntimeError("native HPC result changed while it was being read")
            return total, digest.hexdigest()
        except Exception as exc:
            _rethrow_native_transport_error(exc)
            raise
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def download_directory_to(
        self,
        remote_path: str,
        local_path: Path,
        max_bytes: int,
        max_entries: int,
        *,
        archive_format: str = "tar",
    ) -> tuple[int, str]:
        """Archive a confined native GPFS directory with bounded traversal."""

        if max_bytes < 1 or max_entries < 1:
            raise ValueError("archive limits must be positive")
        if archive_format not in {"tar", "zip"}:
            raise ValueError("archive_format must be tar or zip")
        writer: BoundedTarWriter | BoundedZipWriter | None = None
        writer_type = BoundedZipWriter if archive_format == "zip" else BoundedTarWriter
        root_fd: int | None = None
        try:
            root = self._root_path()
            directory = self._confined_path(remote_path)
            root_fd = _open_confined_path(root, directory, directory=True)
            if not stat.S_ISDIR(os.fstat(root_fd).st_mode):
                raise RuntimeError("native HPC result is not a directory")

            archive_root = directory.name
            writer = writer_type(
                local_path,
                max_bytes=max_bytes,
                max_entries=max_entries,
            )
            writer.add_directory(archive_root)

            def walk(current_fd: int, archive_directory: str) -> None:
                entries = []
                with os.scandir(current_fd) as iterator:
                    for entry in iterator:
                        entries.append(entry)
                        if len(entries) > max_entries:
                            raise ArchiveError("remote artifact contains too many entries")
                entries.sort(key=lambda item: item.name)
                for entry in entries:
                    name = entry.name
                    if not name or PurePosixPath(name).name != name or name in {".", ".."}:
                        raise RuntimeError("native HPC result contains an unsafe directory entry")
                    entry_attributes = entry.stat(follow_symlinks=False)
                    if stat.S_ISLNK(entry_attributes.st_mode):
                        raise RuntimeError("native HPC result contains a symlink")
                    archive_child = f"{archive_directory}/{name}"
                    try:
                        child_fd = os.open(name, _native_directory_flags(), dir_fd=current_fd)
                    except OSError as open_directory_error:
                        if open_directory_error.errno == errno.ELOOP:
                            raise RuntimeError(
                                "native HPC result contains a symlink"
                            ) from open_directory_error
                        if open_directory_error.errno != errno.ENOTDIR:
                            raise
                        child_fd = None
                    if child_fd is not None:
                        writer.add_directory(archive_child)
                        try:
                            walk(child_fd, archive_child)
                        finally:
                            os.close(child_fd)
                        continue
                    file_fd = os.open(name, _native_file_flags(), dir_fd=current_fd)
                    try:
                        file_attributes = os.fstat(file_fd)
                        if not stat.S_ISREG(file_attributes.st_mode):
                            raise RuntimeError("native HPC result contains a non-regular entry")
                        size = file_attributes.st_size
                        with os.fdopen(file_fd, "rb", closefd=False) as source:
                            writer.add_file(archive_child, source, size)
                        if os.fstat(file_fd).st_size != size:
                            raise RuntimeError("native HPC result changed while it was being read")
                    finally:
                        os.close(file_fd)

            walk(root_fd, archive_root)
            return writer.close()
        except Exception as exc:
            if writer is not None:
                writer.abort()
            _rethrow_native_transport_error(exc)
            raise
        finally:
            if root_fd is not None:
                os.close(root_fd)

    def _run(self, args: list[str]) -> str:
        try:
            completed = subprocess.run(
                args,
                check=True,
                capture_output=True,
                text=True,
                timeout=60,
            )
        except FileNotFoundError as exc:
            raise HPCConfigurationError("native Slurm command is unavailable") from exc
        except subprocess.TimeoutExpired as exc:
            raise HPCTransportError("native Slurm transport is unavailable") from exc
        except OSError as exc:
            _rethrow_native_slurm_transport_error(exc)
            raise
        return completed.stdout.strip()

    def _run_shell(self, script: str) -> str:
        try:
            completed = subprocess.run(
                ["/bin/sh", "-c", script],
                check=True,
                capture_output=True,
                text=True,
                timeout=60,
            )
        except subprocess.CalledProcessError as exc:
            if exc.returncode == 127:
                raise HPCConfigurationError("native Slurm command is unavailable") from exc
            if exc.returncode == 75:
                output = exc.stderr or exc.stdout or ""
                match = re.search(r"SUBMISSION_AMBIGUOUS:([A-Za-z0-9_-]+)", output)
                if match:
                    raise HPCSubmissionAmbiguousError(match.group(1)) from exc
                raise HPCTransportError("Slurm submission receipt is ambiguous") from exc
            raise
        except subprocess.TimeoutExpired as exc:
            raise HPCTransportError("native Slurm transport is unavailable") from exc
        except OSError as exc:
            _rethrow_native_slurm_transport_error(exc)
            raise
        return completed.stdout.strip()

    def _read_submission_receipt(self, receipt_path: str) -> str | None:
        try:
            value = self.read_text(receipt_path, 256).strip()
        except FileNotFoundError:
            return None
        if not value:
            raise RuntimeError("Slurm submission receipt is empty")
        job_id = value.splitlines()[0].split(";", 1)[0].strip()
        self._validate_job_id(job_id)
        return job_id

    def _submit_with_receipt(self, args: list[str], receipt_path: str) -> str:
        """Submit and persist the job id before the local caller gets a reply."""

        receipt = self._confined_path(receipt_path)
        temporary = self._confined_path(f"{receipt_path}.tmp-{uuid4().hex}")
        script = "\n".join(
            [
                "set -eu",
                f"temporary={shlex.quote(str(temporary))}",
                f"receipt={shlex.quote(str(receipt))}",
                "trap 'rm -f -- \"$temporary\"' EXIT",
                f"job_output=$({shlex.join(args)})",
                'job_id="${job_output%%;*}"',
                'case "$job_id" in',
                "  ''|*[!A-Za-z0-9_-]*) exit 78 ;;",
                "esac",
                "umask 077",
                'if ! printf "%s\\n" "$job_id" > "$temporary"; then',
                '  printf "SUBMISSION_AMBIGUOUS:%s\\n" "$job_id" >&2',
                "  exit 75",
                "fi",
                'if ! mv -f -- "$temporary" "$receipt"; then',
                '  printf "SUBMISSION_AMBIGUOUS:%s\\n" "$job_id" >&2',
                "  exit 75",
                "fi",
                'printf "%s\\n" "$job_id"',
            ]
        )
        return self._run_shell(script)

    def _read_prefetch_receipt(
        self,
        receipt_path: str,
        request: PrefetchRequest,
    ) -> PrefetchResult | None:
        try:
            output = self.read_text(receipt_path, 64 * 1024)
        except FileNotFoundError:
            return None
        result = parse_prefetch_result(output, request)
        return result if result.status == "success" else None

    def _prepare_with_receipt(
        self,
        request: PrefetchRequest,
        environment_file: str | None = None,
    ) -> str:
        receipt = self._confined_path(request.receipt_path or "")
        temporary = self._confined_path(f"{request.receipt_path}.tmp-{uuid4().hex}")
        command = render_prefetch_command(
            self.settings.hpc_pipeline_prefetch_command,
            request,
            environment_file=environment_file,
        )
        environment_trap = (
            f"environment_file={shlex.quote(environment_file)}; "
            "trap 'rm -f -- \"$environment_file\"' EXIT; "
            if environment_file is not None
            else ""
        )
        script = "\n".join(
            [
                "set -eu",
                f"temporary={shlex.quote(str(temporary))}",
                f"receipt={shlex.quote(str(receipt))}",
                "trap 'rm -f -- \"$temporary\"' EXIT",
                f"output=$({environment_trap}{command})",
                "umask 077",
                'printf "%s\\n" "$output" > "$temporary"',
                'mv -f -- "$temporary" "$receipt"',
                'printf "%s\\n" "$output"',
            ]
        )
        return self._run_shell(script)

    def prepare_external(self, request: PrefetchRequest) -> PrefetchResult:
        """Run the explicitly configured, selective pipeline prefetch alias."""

        receipt_path = (
            str(self._confined_path(request.receipt_path)) if request.receipt_path else None
        )
        if receipt_path:
            existing = self._read_prefetch_receipt(receipt_path, request)
            if existing is not None:
                return existing
        _, external_environment = split_job_environment(request.environment)
        environment_file = None
        if external_environment:
            environment_file = self._confined_path(prefetch_environment_path(request))
        total_environment_bytes = sum(
            len(value.encode("utf-8")) for value in request.environment.values()
        )
        command = render_prefetch_command(
            self.settings.hpc_pipeline_prefetch_command,
            request,
            environment_file=str(environment_file) if environment_file else None,
        )
        if external_environment:
            self._write_environment_file(
                str(environment_file),
                render_environment_script(external_environment),
            )
        logger.info(
            "HPC prefetch environment_bytes=%d environment_fields=%s command_bytes=%d "
            "externalized_fields=%s",
            total_environment_bytes,
            ",".join(
                f"{key}:{len(value.encode('utf-8'))}"
                for key, value in sorted(request.environment.items())
            ),
            len(command.encode("utf-8")),
            ",".join(sorted(external_environment)),
        )
        try:
            if receipt_path:
                output = self._prepare_with_receipt(
                    request,
                    str(environment_file) if environment_file else None,
                )
            else:
                trap = (
                    f"environment_file={shlex.quote(str(environment_file))}; "
                    "trap 'rm -f -- \"$environment_file\"' EXIT; "
                    if environment_file
                    else ""
                )
                output = self._run_shell(f"{trap}{command}")
        except (HPCSubmissionAmbiguousError, HPCTransportError) as exc:
            logger.warning(
                "HPC prefetch response is ambiguous accession=%s environment_bytes=%d "
                "command_bytes=%d error_type=%s",
                request.accession,
                total_environment_bytes,
                len(command.encode("utf-8")),
                type(exc).__name__,
            )
            raise
        except Exception:
            if environment_file is not None:
                self.remove_environment_file(str(environment_file))
            raise
        return parse_prefetch_result(output, request)

    def submit(self, request: JobRequest) -> JobHandle:
        if not request.command:
            raise ValueError("job command cannot be empty")
        if request.cpu < 1 or request.gpu < 0:
            raise ValueError("job resources are invalid")
        if request.memory_gb is not None and request.memory_gb < 1:
            raise ValueError("job memory is invalid")
        for key in request.environment:
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
                raise ValueError("job environment contains an invalid variable name")
        workdir = self._confined_path(request.working_directory)
        stdout_path = (
            self._confined_path(request.stdout_path) if request.stdout_path is not None else None
        )
        stderr_path = (
            self._confined_path(request.stderr_path) if request.stderr_path is not None else None
        )
        receipt_path = (
            str(self._confined_path(request.submission_receipt_path))
            if request.submission_receipt_path
            else None
        )
        if receipt_path:
            existing_job_id = self._read_submission_receipt(receipt_path)
            if existing_job_id is not None:
                return JobHandle(job_id=existing_job_id, state=JobState.QUEUED)
        inline_environment, external_environment = split_job_environment(request.environment)
        inline_exports = [
            f"export {key}={shlex.quote(value)};" for key, value in inline_environment.items()
        ]
        command = shlex.join(request.command)
        environment_file: str | None = None
        if external_environment:
            environment_file = job_environment_path(
                str(workdir),
                str(receipt_path) if receipt_path else None,
                request.stage_id,
            )
            self._write_environment_file(
                environment_file,
                render_environment_script(external_environment),
            )
            environment_file = str(self._confined_path(environment_file))
            script = "\n".join(
                [
                    "set -u",
                    f"environment_file={shlex.quote(environment_file)}",
                    "trap 'rm -f -- \"$environment_file\"' EXIT",
                    f"cd -- {shlex.quote(str(workdir))} || exit",
                    *inline_exports,
                    '. "$environment_file" || exit',
                    command,
                ]
            )
        else:
            exports = " ".join(inline_exports)
            script = f"{exports} exec {command}" if exports else f"exec {command}"
        args = ["sbatch", "--parsable"]
        if self.settings.hpc_slurm_account:
            args.append(f"--account={self.settings.hpc_slurm_account}")
        if self.settings.hpc_slurm_partition:
            args.append(f"--partition={self.settings.hpc_slurm_partition}")
        if self.settings.hpc_slurm_qos:
            args.append(f"--qos={self.settings.hpc_slurm_qos}")
        args.extend(
            [
                "--chdir",
                str(workdir),
                "--nodes=1",
                "--ntasks=1",
                f"--cpus-per-task={request.cpu}",
            ]
        )
        if request.gpu:
            args.append(f"--gres=gpu:{request.gpu}")
        if request.memory_gb:
            args.append(f"--mem={request.memory_gb}G")
        time_limit = request.time_limit or self.settings.hpc_slurm_time
        if time_limit:
            args.append(f"--time={time_limit}")
        if request.job_name:
            args.append(f"--job-name={request.job_name}")
        if stdout_path is not None:
            args.append(f"--output={stdout_path}")
        if stderr_path is not None:
            args.append(f"--error={stderr_path}")
        args.extend(["--wrap", script])
        total_environment_bytes = sum(
            len(value.encode("utf-8")) for value in request.environment.values()
        )
        field_sizes = ",".join(
            f"{key}:{len(value.encode('utf-8'))}"
            for key, value in sorted(request.environment.items())
        )
        logger.info(
            "HPC submit stage=%s job_name=%s environment_bytes=%d environment_fields=%s "
            "wrap_bytes=%d externalized_fields=%s",
            request.stage_id,
            request.job_name or "unknown",
            total_environment_bytes,
            field_sizes,
            len(script.encode("utf-8")),
            ",".join(sorted(external_environment)),
        )
        try:
            output = (
                self._submit_with_receipt(args, receipt_path) if receipt_path else self._run(args)
            )
        except (HPCSubmissionAmbiguousError, HPCTransportError) as exc:
            # A lost reply may follow an accepted submission; the job still
            # needs this file when Slurm eventually starts it.
            logger.warning(
                "HPC submit response is ambiguous stage=%s job_name=%s "
                "environment_bytes=%d wrap_bytes=%d error_type=%s",
                request.stage_id,
                request.job_name or "unknown",
                total_environment_bytes,
                len(script.encode("utf-8")),
                type(exc).__name__,
            )
            raise
        except OSError as exc:
            if exc.errno == errno.E2BIG:
                logger.error(
                    "HPC submit hit E2BIG stage=%s job_name=%s "
                    "environment_bytes=%d wrap_bytes=%d error_type=%s errno=%s",
                    request.stage_id,
                    request.job_name or "unknown",
                    total_environment_bytes,
                    len(script.encode("utf-8")),
                    type(exc).__name__,
                    exc.errno,
                )
                if environment_file is not None:
                    self.remove_environment_file(environment_file)
                raise HPCRequestTooLargeError(
                    "Slurm submission exceeded the OS argument limit "
                    f"(stage={request.stage_id}, wrap_bytes={len(script.encode('utf-8'))}, "
                    f"environment_bytes={total_environment_bytes})"
                ) from exc
            if environment_file is not None:
                self.remove_environment_file(environment_file)
            raise
        except Exception:
            if environment_file is not None:
                self.remove_environment_file(environment_file)
            raise
        job_id = output.splitlines()[0].split(";", 1)[0].strip() if output else ""
        self._validate_job_id(job_id)
        return JobHandle(job_id=job_id, state=JobState.QUEUED)

    def status(self, job_id: str) -> JobStatus:
        self._validate_job_id(job_id)
        output = self._run(["squeue", "--noheader", "--format=%T", "--jobs", job_id])
        if output:
            return JobStatus(job_id=job_id, state=_map_slurm_state(output), message=output)
        try:
            accounting = self._run(
                [
                    "sacct",
                    "-X",
                    "--noheader",
                    "--parsable2",
                    "--jobs",
                    job_id,
                    "--format=State,ExitCode",
                ]
            )
        except subprocess.CalledProcessError as exc:
            message = (exc.stderr or exc.stdout or "Slurm accounting is unavailable").strip()
            return JobStatus(job_id=job_id, state=JobState.UNKNOWN, message=message[:1000])
        rows = [row.strip() for row in accounting.splitlines() if row.strip()]
        if not rows:
            return JobStatus(job_id=job_id, state=JobState.UNKNOWN, message="job not found")
        state = rows[-1].split("|", 1)[0].strip()
        return JobStatus(job_id=job_id, state=_map_slurm_state(state), message=rows[-1])

    def cancel(self, job_id: str) -> JobStatus:
        self._validate_job_id(job_id)
        self._run(["scancel", job_id])
        return JobStatus(job_id=job_id, state=JobState.CANCELLED)

    @staticmethod
    def _validate_job_id(job_id: str) -> None:
        if not job_id or not job_id.replace("_", "").replace("-", "").isalnum():
            raise ValueError("invalid Slurm job id")


def _map_slurm_state(value: str) -> JobState:
    state = value.strip().upper().split("+", 1)[0]
    if state in {"PENDING", "CONFIGURING", "SUSPENDED", "RESIZING"}:
        return JobState.QUEUED
    if state in {"RUNNING", "COMPLETING", "STAGE_OUT", "SIGNALING"}:
        return JobState.RUNNING
    if state in {"COMPLETED"}:
        return JobState.SUCCESS
    if state in {"CANCELLED", "PREEMPTED"}:
        return JobState.CANCELLED
    if state in {"FAILED", "TIMEOUT", "OUT_OF_MEMORY", "NODE_FAIL", "BOOT_FAIL"}:
        return JobState.FAILED
    return JobState.UNKNOWN
