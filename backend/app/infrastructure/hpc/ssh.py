from __future__ import annotations

import errno
import hashlib
import re
import shlex
import socket
import stat
from pathlib import Path, PurePosixPath

import paramiko
from paramiko.ssh_exception import (
    AuthenticationException,
    BadHostKeyException,
    NoValidConnectionsError,
)

from app.core.config import Settings
from app.infrastructure.hpc.base import (
    HPCConfigurationError,
    HPCTransportError,
    JobHandle,
    JobRequest,
    JobState,
    JobStatus,
)


class SSHConfigurationError(HPCConfigurationError):
    pass


def _read_password(path: Path) -> str:
    if path.is_symlink() or not path.is_file():
        raise SSHConfigurationError("password file must be a regular file")
    mode = path.stat().st_mode & 0o777
    if mode & 0o077:
        raise SSHConfigurationError("password file must not be accessible by group or others")
    password = path.read_text(encoding="utf-8").strip()
    if not password:
        raise SSHConfigurationError("password file is empty")
    return password


def _remote_path_under(root: str, candidate: str) -> str:
    root_path = PurePosixPath(root)
    candidate_path = PurePosixPath(candidate)
    if not candidate_path.is_absolute() or any(
        part in {".", ".."} for part in candidate_path.parts
    ):
        raise SSHConfigurationError("remote working directory is outside the configured root")
    try:
        candidate_path.relative_to(root_path)
    except ValueError as exc:
        raise SSHConfigurationError(
            "remote working directory is outside the configured root"
        ) from exc
    return str(candidate_path)


_TRANSPORT_ERRNOS = frozenset(
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


def _rethrow_transport_error(error: Exception) -> None:
    if isinstance(error, HPCTransportError):
        raise error
    if isinstance(error, (AuthenticationException, BadHostKeyException)):
        return
    if isinstance(error, (NoValidConnectionsError, ConnectionError, EOFError, TimeoutError)):
        raise HPCTransportError("SSH transport is unavailable") from error
    if isinstance(error, socket.gaierror) and error.errno == getattr(socket, "EAI_AGAIN", None):
        raise HPCTransportError("SSH transport is unavailable") from error
    if isinstance(error, OSError) and error.errno in _TRANSPORT_ERRNOS:
        raise HPCTransportError("SSH transport is unavailable") from error
    if isinstance(error, paramiko.SSHException):
        message = str(error).lower()
        if any(
            marker in message
            for marker in ("connection", "socket is closed", "session not active", "timed out")
        ):
            raise HPCTransportError("SSH transport is unavailable") from error


def assert_no_symlink_components(
    sftp: paramiko.SFTPClient,
    root: str,
    path: str,
) -> None:
    """Reject a remote path whose components include a symlink.

    Lexical confinement alone allows a remote directory inside the root to be
    replaced by a symlink pointing outside of it. Every component below the
    configured root must be a real directory/file entry.
    """

    root_path = PurePosixPath(root)
    candidate = PurePosixPath(path)
    try:
        root_attributes = sftp.lstat(str(root_path))
    except OSError as exc:
        _rethrow_transport_error(exc)
        raise RuntimeError("remote root is unavailable") from exc
    if stat.S_ISLNK(root_attributes.st_mode or 0) or not stat.S_ISDIR(root_attributes.st_mode or 0):
        raise RuntimeError("remote root is not a real directory")
    try:
        relative = candidate.relative_to(root_path)
    except ValueError as exc:
        raise RuntimeError("remote path is outside the configured root") from exc
    current = root_path
    for part in relative.parts:
        current = current / part
        try:
            attributes = sftp.lstat(str(current))
        except OSError as exc:
            _rethrow_transport_error(exc)
            raise RuntimeError("remote path component is unavailable") from exc
        if stat.S_ISLNK(attributes.st_mode or 0):
            raise RuntimeError("remote path uses a symlinked component")


def _ensure_remote_directory(
    sftp: paramiko.SFTPClient,
    root: PurePosixPath,
    target: PurePosixPath,
) -> None:
    """Create a confined remote directory one verified component at a time."""

    try:
        root_attributes = sftp.lstat(str(root))
    except OSError as exc:
        _rethrow_transport_error(exc)
        raise SSHConfigurationError("configured remote root is unavailable") from exc
    if stat.S_ISLNK(root_attributes.st_mode or 0) or not stat.S_ISDIR(root_attributes.st_mode or 0):
        raise SSHConfigurationError("configured remote root is not a real directory")
    try:
        relative = target.relative_to(root)
    except ValueError as exc:
        raise SSHConfigurationError("remote directory is outside configured root") from exc

    current = root
    for part in relative.parts:
        current /= part
        current_string = str(current)
        try:
            attributes = sftp.lstat(current_string)
        except OSError as exc:
            if getattr(exc, "errno", None) != errno.ENOENT:
                _rethrow_transport_error(exc)
                raise SSHConfigurationError("remote directory is unavailable") from exc
            try:
                sftp.mkdir(current_string, mode=0o700)
            except OSError as mkdir_error:
                if getattr(mkdir_error, "errno", None) != errno.EEXIST:
                    _rethrow_transport_error(mkdir_error)
                    raise SSHConfigurationError("remote directory could not be created") from (
                        mkdir_error
                    )
            try:
                attributes = sftp.lstat(current_string)
            except OSError as verify_error:
                _rethrow_transport_error(verify_error)
                raise SSHConfigurationError("remote directory could not be verified") from (
                    verify_error
                )
        if stat.S_ISLNK(attributes.st_mode or 0):
            raise SSHConfigurationError("remote directory uses a symlinked component")
        if not stat.S_ISDIR(attributes.st_mode or 0):
            raise SSHConfigurationError("remote path component is not a directory")


class SSHSlurmClient:
    def __init__(self, settings: Settings):
        if (
            not settings.hpc_ssh_host
            or not settings.hpc_ssh_username
            or not settings.hpc_ssh_password_file
        ):
            raise SSHConfigurationError("SSH HPC profile is incomplete")
        self.settings = settings
        self.password = _read_password(settings.hpc_ssh_password_file)

    def _connect(self) -> paramiko.SSHClient:
        client = paramiko.SSHClient()
        if self.settings.hpc_known_hosts_file:
            client.load_host_keys(str(self.settings.hpc_known_hosts_file))
        else:
            client.load_system_host_keys()
        client.set_missing_host_key_policy(paramiko.RejectPolicy())
        try:
            client.connect(
                hostname=self.settings.hpc_ssh_host,
                port=self.settings.hpc_ssh_port,
                username=self.settings.hpc_ssh_username,
                password=self.password,
                timeout=self.settings.hpc_command_timeout_seconds,
                allow_agent=False,
                look_for_keys=False,
            )
        except Exception as exc:
            client.close()
            _rethrow_transport_error(exc)
            raise
        return client

    def _command(self, command: str) -> str:
        client = self._connect()
        try:
            try:
                _, stdout, stderr = client.exec_command(
                    command, timeout=self.settings.hpc_command_timeout_seconds
                )
                exit_status = stdout.channel.recv_exit_status()
                output = stdout.read().decode("utf-8", errors="replace").strip()
                error = stderr.read().decode("utf-8", errors="replace").strip()
                if exit_status != 0:
                    message = error or output or f"remote command exited with status {exit_status}"
                    raise RuntimeError(message[:1000])
                return output
            except Exception as exc:
                _rethrow_transport_error(exc)
                raise
        finally:
            client.close()

    def ensure_directory(self, remote_path: str) -> None:
        path = _remote_path_under(self.settings.hpc_remote_root, remote_path)
        client = self._connect()
        try:
            try:
                sftp = client.open_sftp()
                try:
                    _ensure_remote_directory(
                        sftp,
                        PurePosixPath(self.settings.hpc_remote_root),
                        PurePosixPath(path),
                    )
                finally:
                    sftp.close()
            except Exception as exc:
                _rethrow_transport_error(exc)
                raise
        finally:
            client.close()

    def read_bytes(self, remote_path: str, max_bytes: int) -> bytes:
        path = _remote_path_under(self.settings.hpc_remote_root, remote_path)
        if max_bytes < 1:
            raise ValueError("max_bytes must be positive")
        client = self._connect()
        try:
            try:
                sftp = client.open_sftp()
                try:
                    assert_no_symlink_components(sftp, self.settings.hpc_remote_root, path)
                    attributes = sftp.lstat(path)
                    if stat.S_ISLNK(attributes.st_mode or 0) or not stat.S_ISREG(
                        attributes.st_mode or 0
                    ):
                        raise RuntimeError("remote result is not a regular file")
                    if attributes.st_size is None or attributes.st_size > max_bytes:
                        raise RuntimeError("remote result exceeds the configured size limit")
                    with sftp.open(path, "rb") as stream:
                        data = stream.read(max_bytes + 1)
                    if len(data) > max_bytes:
                        raise RuntimeError("remote result exceeds the configured size limit")
                    return data
                finally:
                    sftp.close()
            except Exception as exc:
                _rethrow_transport_error(exc)
                raise
        finally:
            client.close()

    def download_to(self, remote_path: str, local_path: Path, max_bytes: int) -> tuple[int, str]:
        """Stream a remote regular file into a local path with sha256 accounting."""

        path = _remote_path_under(self.settings.hpc_remote_root, remote_path)
        if max_bytes < 1:
            raise ValueError("max_bytes must be positive")
        client = self._connect()
        try:
            try:
                sftp = client.open_sftp()
                try:
                    assert_no_symlink_components(sftp, self.settings.hpc_remote_root, path)
                    attributes = sftp.lstat(path)
                    if stat.S_ISLNK(attributes.st_mode or 0) or not stat.S_ISREG(
                        attributes.st_mode or 0
                    ):
                        raise RuntimeError("remote result is not a regular file")
                    if attributes.st_size is None or attributes.st_size > max_bytes:
                        raise RuntimeError("remote result exceeds the configured size limit")
                    digest = hashlib.sha256()
                    total = 0
                    remaining = max_bytes + 1
                    local_path.parent.mkdir(parents=True, exist_ok=True)
                    with sftp.open(path, "rb") as source, local_path.open("wb") as sink:
                        while remaining > 0:
                            chunk = source.read(min(1024 * 1024, remaining))
                            if not chunk:
                                break
                            total += len(chunk)
                            if total > max_bytes:
                                raise RuntimeError(
                                    "remote result exceeds the configured size limit"
                                )
                            digest.update(chunk)
                            sink.write(chunk)
                            remaining = max_bytes + 1 - total
                    if total != attributes.st_size:
                        raise RuntimeError("remote result changed while it was being read")
                    return total, digest.hexdigest()
                finally:
                    sftp.close()
            except Exception as exc:
                _rethrow_transport_error(exc)
                raise
        finally:
            client.close()

    def read_text(self, remote_path: str, max_bytes: int) -> str:
        return self.read_bytes(remote_path, max_bytes).decode("utf-8")

    def submit(self, request: JobRequest) -> JobHandle:
        workdir = _remote_path_under(self.settings.hpc_remote_root, request.working_directory)
        if not request.command:
            raise ValueError("job command cannot be empty")
        if request.cpu < 1 or request.gpu < 0:
            raise ValueError("job resources are invalid")
        if request.memory_gb is not None and request.memory_gb < 1:
            raise ValueError("job memory is invalid")
        for key in request.environment:
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
                raise ValueError("job environment contains an invalid variable name")
        command = " ".join(shlex.quote(part) for part in request.command)
        exports = " ".join(
            f"export {key}={shlex.quote(value)};" for key, value in request.environment.items()
        )
        script = f"cd -- {shlex.quote(workdir)} && {exports} exec {command}"
        args = ["sbatch", "--parsable"]
        if self.settings.hpc_slurm_account:
            args.append(f"--account={self.settings.hpc_slurm_account}")
        if self.settings.hpc_slurm_partition:
            args.append(f"--partition={self.settings.hpc_slurm_partition}")
        if self.settings.hpc_slurm_qos:
            args.append(f"--qos={self.settings.hpc_slurm_qos}")
        args.extend(["--nodes=1", "--ntasks=1", f"--cpus-per-task={request.cpu}"])
        if request.gpu:
            args.append(f"--gres=gpu:{request.gpu}")
        if request.memory_gb:
            args.append(f"--mem={request.memory_gb}G")
        time_limit = request.time_limit or self.settings.hpc_slurm_time
        if time_limit:
            args.append(f"--time={time_limit}")
        if request.job_name:
            args.append(f"--job-name={request.job_name}")
        if request.stdout_path:
            stdout_path = _remote_path_under(self.settings.hpc_remote_root, request.stdout_path)
            args.append(f"--output={stdout_path}")
        if request.stderr_path:
            stderr_path = _remote_path_under(self.settings.hpc_remote_root, request.stderr_path)
            args.append(f"--error={stderr_path}")
        args.extend(["--wrap", script])
        output = self._command(" ".join(shlex.quote(arg) for arg in args))
        job_id = output.split(";", 1)[0].strip()
        if not job_id:
            raise RuntimeError("Slurm did not return a job id")
        return JobHandle(job_id=job_id, state=JobState.QUEUED)

    def status(self, job_id: str) -> JobStatus:
        if not job_id.replace("_", "").replace("-", "").isalnum():
            raise ValueError("invalid Slurm job id")
        output = self._command(f"squeue --noheader --format=%T --jobs {shlex.quote(job_id)}")
        if output:
            return JobStatus(job_id=job_id, state=_map_slurm_state(output), message=output)
        try:
            accounting = self._command(
                "sacct -X --noheader --parsable2 "
                f"--jobs {shlex.quote(job_id)} --format=State,ExitCode"
            )
        except RuntimeError as exc:
            return JobStatus(job_id=job_id, state=JobState.UNKNOWN, message=str(exc)[:1000])
        rows = [row.strip() for row in accounting.splitlines() if row.strip()]
        if not rows:
            return JobStatus(job_id=job_id, state=JobState.UNKNOWN, message="job not found")
        state = rows[-1].split("|", 1)[0].strip()
        return JobStatus(job_id=job_id, state=_map_slurm_state(state), message=rows[-1])

    def cancel(self, job_id: str) -> JobStatus:
        if not job_id.replace("_", "").replace("-", "").isalnum():
            raise ValueError("invalid Slurm job id")
        self._command(f"scancel -- {shlex.quote(job_id)}")
        return JobStatus(job_id=job_id, state=JobState.CANCELLED)


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
