from __future__ import annotations

import shlex
import stat
from pathlib import Path, PurePosixPath

import paramiko
from scp import SCPClient

from app.core.config import Settings


class InputTransferError(RuntimeError):
    pass


def _assert_no_symlink_components(
    client: paramiko.SSHClient,
    root: PurePosixPath,
    remote_directory: PurePosixPath,
) -> None:
    """Reject a remote directory whose created parents include a symlink."""

    try:
        sftp = client.open_sftp()
    except Exception as exc:
        raise InputTransferError("could not verify the remote input directory") from exc
    try:
        try:
            relative = remote_directory.relative_to(root)
        except ValueError as exc:
            raise InputTransferError("remote input path is outside configured root") from exc
        current = root
        for part in relative.parts:
            current = current / part
            try:
                attributes = sftp.lstat(str(current))
            except OSError as exc:
                raise InputTransferError("remote input directory is unavailable") from exc
            if stat.S_ISLNK(attributes.st_mode or 0):
                raise InputTransferError("remote input directory uses a symlinked component")
    finally:
        sftp.close()


def _safe_component(value: str, label: str) -> str:
    path = PurePosixPath(value)
    if not value or path.name != value or value in {".", ".."}:
        raise InputTransferError(f"{label} is invalid")
    return value


def _remote_path_under(root: PurePosixPath, candidate: PurePosixPath) -> None:
    if not candidate.is_absolute() or any(part in {".", ".."} for part in candidate.parts):
        raise InputTransferError("remote input path is outside configured root")
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise InputTransferError("remote input path is outside configured root") from exc


def remote_input_path(
    settings: Settings,
    run_id: str,
    upload_id: str,
    suffix: str,
    input_type: str = "structure",
) -> str:
    root = PurePosixPath(settings.hpc_remote_root)
    subdir = PurePosixPath(settings.hpc_input_remote_subdir)
    if (
        not root.is_absolute()
        or subdir.is_absolute()
        or not settings.hpc_input_remote_subdir
        or ".." in subdir.parts
        or any(part.startswith(".") for part in subdir.parts)
    ):
        raise InputTransferError("remote input directory is invalid")
    _safe_component(run_id, "run id")
    _safe_component(upload_id, "upload id")
    _safe_component(suffix, "file suffix")
    if not suffix.startswith("."):
        raise InputTransferError("file suffix is invalid")
    input_directory = {"fasta": "fasta", "structure": "pdb"}.get(input_type)
    if input_directory is None:
        raise InputTransferError("input type is invalid")
    candidate = root / subdir / run_id / input_directory / f"{upload_id}{suffix}"
    _remote_path_under(root, candidate)
    return str(candidate)


class SCPInputTransfer:
    """Password-authenticated SCP transfer for small, generated input paths only."""

    def __init__(self, settings: Settings):
        if (
            not settings.hpc_ssh_host
            or not settings.hpc_ssh_username
            or not settings.hpc_ssh_password_file
        ):
            raise InputTransferError("SSH input transfer profile is incomplete")
        self.settings = settings
        self.client: paramiko.SSHClient | None = None
        self.scp: SCPClient | None = None

    def __enter__(self) -> SCPInputTransfer:
        password_path = self.settings.hpc_ssh_password_file
        try:
            if password_path.is_symlink() or not password_path.is_file():
                raise InputTransferError("SSH password path must be a regular file")
            mode = password_path.stat().st_mode & 0o777
            password = password_path.read_text(encoding="utf-8").strip()
        except InputTransferError:
            raise
        except (OSError, UnicodeError) as exc:
            raise InputTransferError("could not read the SSH password file") from exc
        if mode & 0o077:
            raise InputTransferError("password file must not be accessible by group or others")
        if not password:
            raise InputTransferError("password file is empty")
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
            self.client = client
            self.scp = SCPClient(
                client.get_transport(), socket_timeout=self.settings.hpc_command_timeout_seconds
            )
            return self
        except Exception as exc:
            client.close()
            raise InputTransferError("could not establish SCP connection") from exc

    def upload(self, local_path: Path, remote_path: str) -> None:
        if self.client is None or self.scp is None:
            raise InputTransferError("SCP transfer is not connected")
        root = Path(self.settings.artifact_root).resolve()
        resolved = local_path.resolve()
        if resolved != root and root not in resolved.parents:
            raise InputTransferError("local input path is outside artifact storage")
        if not resolved.is_file() or resolved.is_symlink():
            raise InputTransferError("local input is not a regular file")
        remote = PurePosixPath(remote_path)
        root_remote = PurePosixPath(self.settings.hpc_remote_root)
        if remote == root_remote:
            raise InputTransferError("remote input path is outside configured root")
        _remote_path_under(root_remote, remote)
        remote_dir = str(remote.parent)
        _, stdout, stderr = self.client.exec_command(
            f"mkdir -p -- {shlex.quote(remote_dir)}",
            timeout=self.settings.hpc_command_timeout_seconds,
        )
        exit_status = stdout.channel.recv_exit_status()
        if exit_status != 0:
            message = stderr.read().decode("utf-8", errors="replace").strip()
            raise InputTransferError(
                f"remote input directory could not be created: {message[:300]}"
            )
        _assert_no_symlink_components(self.client, root_remote, remote.parent)
        try:
            self.scp.put(str(resolved), remote_path, preserve_times=False)
        except Exception as exc:
            raise InputTransferError("SCP input transfer failed") from exc

    def close(self) -> None:
        if self.scp is not None:
            self.scp.close()
        if self.client is not None:
            self.client.close()
        self.scp = None
        self.client = None

    def __exit__(self, *_: object) -> None:
        self.close()
