from __future__ import annotations

import errno
import hashlib
import os
import re
import shlex
import stat
import subprocess
from pathlib import Path, PurePosixPath

from app.core.config import Settings
from app.infrastructure.hpc.archive import ArchiveError, BoundedTarWriter
from app.infrastructure.hpc.base import (
    HPCConfigurationError,
    HPCTransportError,
    JobHandle,
    JobRequest,
    JobState,
    JobStatus,
)

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
            relative = target.relative_to(root)
            current = root
            for part in relative.parts:
                current /= part
                if current.exists():
                    if current.is_symlink() or not current.is_dir():
                        raise RuntimeError("native HPC directory component is unsafe")
                    continue
                current.mkdir(mode=0o700)
        except Exception as exc:
            _rethrow_native_transport_error(exc)
            raise

    def read_bytes(self, remote_path: str, max_bytes: int) -> bytes:
        if max_bytes < 1:
            raise ValueError("max_bytes must be positive")
        try:
            path = self._confined_path(remote_path)
            attributes = path.stat()
            if not stat.S_ISREG(attributes.st_mode) or path.is_symlink():
                raise RuntimeError("native HPC result is not a regular file")
            if attributes.st_size > max_bytes:
                raise RuntimeError("native HPC result exceeds the configured size limit")
            with path.open("rb") as stream:
                data = stream.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise RuntimeError("native HPC result exceeds the configured size limit")
            if path.stat().st_size != attributes.st_size:
                raise RuntimeError("native HPC result changed while it was being read")
            return data
        except Exception as exc:
            _rethrow_native_transport_error(exc)
            raise

    def read_text(self, remote_path: str, max_bytes: int) -> str:
        return self.read_bytes(remote_path, max_bytes).decode("utf-8")

    def download_to(self, remote_path: str, local_path: Path, max_bytes: int) -> tuple[int, str]:
        """Copy a verified native result file into the application artifact store."""

        if max_bytes < 1:
            raise ValueError("max_bytes must be positive")
        try:
            source = self._confined_path(remote_path)
            attributes = source.stat()
            if not stat.S_ISREG(attributes.st_mode) or source.is_symlink():
                raise RuntimeError("native HPC result is not a regular file")
            if attributes.st_size > max_bytes:
                raise RuntimeError("native HPC result exceeds the configured size limit")
            digest = hashlib.sha256()
            total = 0
            local_path.parent.mkdir(parents=True, exist_ok=True)
            with source.open("rb") as source_stream, local_path.open("wb") as target_stream:
                while chunk := source_stream.read(min(1024 * 1024, max_bytes + 1 - total)):
                    total += len(chunk)
                    if total > max_bytes:
                        raise RuntimeError("native HPC result exceeds the configured size limit")
                    digest.update(chunk)
                    target_stream.write(chunk)
            if total != attributes.st_size or source.stat().st_size != attributes.st_size:
                raise RuntimeError("native HPC result changed while it was being read")
            return total, digest.hexdigest()
        except Exception as exc:
            _rethrow_native_transport_error(exc)
            raise

    def download_directory_to(
        self,
        remote_path: str,
        local_path: Path,
        max_bytes: int,
        max_entries: int,
    ) -> tuple[int, str]:
        """Archive a confined native GPFS directory with bounded traversal."""

        if max_bytes < 1 or max_entries < 1:
            raise ValueError("archive limits must be positive")
        writer: BoundedTarWriter | None = None
        root_fd: int | None = None
        try:
            directory = self._confined_path(remote_path)
            attributes = directory.lstat()
            if stat.S_ISLNK(attributes.st_mode) or not stat.S_ISDIR(attributes.st_mode):
                raise RuntimeError("native HPC result is not a directory")
            if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
                raise RuntimeError("native HPC directory traversal needs no-follow support")

            archive_root = directory.name
            writer = BoundedTarWriter(
                local_path,
                max_bytes=max_bytes,
                max_entries=max_entries,
            )
            writer.add_directory(archive_root)

            directory_flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY
            file_flags = os.O_RDONLY | os.O_NOFOLLOW
            root_fd = os.open(directory, directory_flags)
            if not stat.S_ISDIR(os.fstat(root_fd).st_mode):
                raise RuntimeError("native HPC result is not a directory")

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
                        child_fd = os.open(name, directory_flags, dir_fd=current_fd)
                    except OSError as open_directory_error:
                        if open_directory_error.errno != errno.ENOTDIR:
                            if open_directory_error.errno == errno.ELOOP:
                                raise RuntimeError(
                                    "native HPC result contains a symlink"
                                ) from open_directory_error
                            raise
                        child_fd = None
                    if child_fd is not None:
                        writer.add_directory(archive_child)
                        try:
                            walk(child_fd, archive_child)
                        finally:
                            os.close(child_fd)
                        continue
                    file_fd = os.open(name, file_flags, dir_fd=current_fd)
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
        exports = " ".join(
            f"export {key}={shlex.quote(value)};" for key, value in request.environment.items()
        )
        command = shlex.join(request.command)
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
        output = self._run(args)
        job_id = output.split(";", 1)[0].strip()
        if not job_id:
            raise RuntimeError("Slurm did not return a job id")
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
