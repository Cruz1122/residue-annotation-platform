import errno
import io
import stat
import subprocess
import tarfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from app.core.config import Settings
from app.infrastructure.hpc.archive import ArchiveError, BoundedTarWriter
from app.infrastructure.hpc.base import (
    HPCConfigurationError,
    HPCTransportError,
    JobRequest,
    JobState,
)
from app.infrastructure.hpc.native import NativeSlurmClient
from app.infrastructure.hpc.ssh import SSHSlurmClient
from paramiko.ssh_exception import (
    AuthenticationException,
    BadHostKeyException,
    NoValidConnectionsError,
)


def _settings(root: Path | None = None) -> Settings:
    return Settings(
        app_env="test",
        database_url="sqlite://",
        hpc_remote_root=str(root or "/gpfs/project/root"),
        hpc_slurm_account="bsc-test",
        hpc_slurm_partition="debug",
        hpc_slurm_qos="normal",
        hpc_slurm_time="00:10:00",
    )


def test_native_slurm_submit_propagates_resources_environment_and_paths(tmp_path):
    root = tmp_path / "hpc-root"
    root.mkdir()
    client = NativeSlurmClient(_settings(root))
    captured: list[list[str]] = []
    client._run = lambda args: captured.append(args) or "12345;cluster"

    handle = client.submit(
        JobRequest(
            stage_id="protein_identity",
            command=("python", "main.py", "--stage", "protein_identity"),
            working_directory=str(root),
            environment={"PYTHONUNBUFFERED": "1"},
            cpu=4,
            gpu=1,
            memory_gb=8,
            time_limit="00:05:00",
            job_name="rap-protein",
            stdout_path=str(root / "job.out"),
            stderr_path=str(root / "job.err"),
        )
    )

    assert handle.job_id == "12345"
    args = captured[0]
    assert args[:4] == ["sbatch", "--parsable", "--account=bsc-test", "--partition=debug"]
    assert "--qos=normal" in args
    assert "--cpus-per-task=4" in args
    assert "--gres=gpu:1" in args
    assert "--mem=8G" in args
    assert "--time=00:05:00" in args
    assert f"--output={root}/job.out" in args
    assert f"--error={root}/job.err" in args
    assert args[-2] == "--wrap"
    assert "export PYTHONUNBUFFERED=1;" in args[-1]
    assert "exec python main.py --stage protein_identity" in args[-1]


def test_native_slurm_status_uses_accounting_after_queue_exit():
    client = NativeSlurmClient(_settings())
    calls: list[list[str]] = []

    def run(args: list[str]) -> str:
        calls.append(args)
        return "" if args[0] == "squeue" else "COMPLETED|0:0"

    client._run = run

    status = client.status("12345")

    assert status.state == JobState.SUCCESS
    assert calls[0][0] == "squeue"
    assert calls[1][0] == "sacct"


def test_native_slurm_rejects_unsafe_job_ids():
    client = NativeSlurmClient(_settings())
    with pytest.raises(ValueError, match="invalid Slurm job id"):
        client.status("123; rm -rf")
    with pytest.raises(ValueError, match="invalid Slurm job id"):
        client.cancel("")


def test_native_slurm_status_sanitizes_accounting_command_failure():
    client = NativeSlurmClient(_settings())

    def fail(args: list[str]) -> str:
        if args[0] == "squeue":
            return ""
        raise subprocess.CalledProcessError(
            1,
            args,
            output="/gpfs/private/secret",
            stderr="accounting unavailable",
        )

    client._run = fail
    status = client.status("12345")

    assert status.state == JobState.UNKNOWN
    assert status.message == "accounting unavailable"
    assert "/gpfs/" not in status.message


def test_native_slurm_missing_client_is_reported_as_configuration_error(tmp_path, monkeypatch):
    root = tmp_path / "hpc-root"
    root.mkdir()
    client = NativeSlurmClient(_settings(root))

    def unavailable(*_args, **_kwargs):
        raise FileNotFoundError("sbatch")

    monkeypatch.setattr(subprocess, "run", unavailable)

    with pytest.raises(HPCConfigurationError, match="command is unavailable"):
        client.submit(
            JobRequest(
                stage_id="protein_identity",
                command=("python", "main.py"),
                working_directory=str(root),
            )
        )


def test_ssh_command_connection_loss_is_reported_as_transport_unavailable(tmp_path):
    password_path = tmp_path / "password"
    password_path.write_text("secret\n", encoding="utf-8")
    password_path.chmod(0o600)
    client = SSHSlurmClient(
        Settings(
            app_env="test",
            database_url="sqlite://",
            hpc_ssh_host="mn5.example",
            hpc_ssh_username="runner",
            hpc_ssh_password_file=password_path,
            hpc_remote_root="/gpfs/project/root",
        )
    )

    class BrokenSSH:
        def exec_command(self, _command: str, timeout: float):
            raise OSError(errno.ECONNRESET, "connection reset")

        def close(self) -> None:
            return None

    client._connect = lambda: BrokenSSH()

    with pytest.raises(HPCTransportError, match="transport is unavailable"):
        client._command("squeue --jobs 12345")


def test_ssh_no_valid_connections_is_reported_as_transport_unavailable(tmp_path, monkeypatch):
    password_path = tmp_path / "password"
    password_path.write_text("secret\n", encoding="utf-8")
    password_path.chmod(0o600)
    client = SSHSlurmClient(
        Settings(
            app_env="test",
            database_url="sqlite://",
            hpc_ssh_host="mn5.example",
            hpc_ssh_username="runner",
            hpc_ssh_password_file=password_path,
            hpc_remote_root="/gpfs/project/root",
        )
    )

    class BrokenConnectSSH:
        def load_system_host_keys(self) -> None:
            return None

        def set_missing_host_key_policy(self, _policy) -> None:
            return None

        def connect(self, **_kwargs) -> None:
            raise NoValidConnectionsError(
                {("mn5.example", 22): ConnectionRefusedError(errno.ECONNREFUSED, "refused")}
            )

        def close(self) -> None:
            return None

    monkeypatch.setattr("app.infrastructure.hpc.ssh.paramiko.SSHClient", lambda: BrokenConnectSSH())

    with pytest.raises(HPCTransportError, match="transport is unavailable"):
        client._connect()


@pytest.mark.parametrize(
    "ssh_error",
    [
        AuthenticationException("authentication failed"),
        BadHostKeyException("mn5.example", None, None),
    ],
)
def test_ssh_authentication_and_host_key_errors_are_not_retryable(tmp_path, ssh_error):
    password_path = tmp_path / "password"
    password_path.write_text("secret\n", encoding="utf-8")
    password_path.chmod(0o600)
    client = SSHSlurmClient(
        Settings(
            app_env="test",
            database_url="sqlite://",
            hpc_ssh_host="mn5.example",
            hpc_ssh_username="runner",
            hpc_ssh_password_file=password_path,
            hpc_remote_root="/gpfs/project/root",
        )
    )

    class BrokenSSH:
        def exec_command(self, _command: str, timeout: float):
            raise ssh_error

        def close(self) -> None:
            return None

    client._connect = lambda: BrokenSSH()

    with pytest.raises(type(ssh_error)) as raised:
        client._command("squeue --jobs 12345")
    assert not isinstance(raised.value, HPCTransportError)


def test_native_gpfs_io_error_is_reported_as_transport_unavailable(tmp_path, monkeypatch):
    root = tmp_path / "hpc-root"
    root.mkdir()
    client = NativeSlurmClient(_settings(root))

    def broken_open(*_args, **_kwargs):
        raise OSError(errno.EIO, "stale GPFS handle")

    monkeypatch.setattr("app.infrastructure.hpc.native._open_confined_path", broken_open)

    with pytest.raises(HPCTransportError, match="transport is unavailable"):
        client.read_text(str(root / "result.json"), 1_000)


@pytest.mark.parametrize("filesystem_errno", [errno.EIO, errno.ESTALE])
def test_native_gpfs_directory_errors_are_reported_as_transport_unavailable(
    tmp_path, monkeypatch, filesystem_errno
):
    root = tmp_path / "hpc-root"
    root.mkdir()
    client = NativeSlurmClient(_settings(root))

    def broken_open(*_args, **_kwargs):
        raise OSError(filesystem_errno, "stale GPFS handle")

    monkeypatch.setattr(
        "app.infrastructure.hpc.native._open_or_create_confined_directory", broken_open
    )

    with pytest.raises(HPCTransportError, match="transport is unavailable"):
        client.ensure_directory(str(root / "jobs"))


@pytest.mark.parametrize(
    "local_error",
    [PermissionError(errno.EACCES, "permission denied"), OSError(errno.EINVAL, "invalid")],
)
def test_native_local_slurm_invocation_errors_are_not_retryable(tmp_path, monkeypatch, local_error):
    root = tmp_path / "hpc-root"
    root.mkdir()
    client = NativeSlurmClient(_settings(root))

    def unavailable(*_args, **_kwargs):
        raise local_error

    monkeypatch.setattr(subprocess, "run", unavailable)

    with pytest.raises(type(local_error)) as raised:
        client.submit(
            JobRequest(
                stage_id="protein_identity",
                command=("python", "main.py"),
                working_directory=str(root),
            )
        )
    assert not isinstance(raised.value, HPCTransportError)


@pytest.mark.parametrize("filesystem_errno", [errno.EIO, errno.ESTALE])
def test_native_slurm_command_filesystem_errors_are_not_retryable(
    tmp_path, monkeypatch, filesystem_errno
):
    root = tmp_path / "hpc-root"
    root.mkdir()
    client = NativeSlurmClient(_settings(root))

    def unavailable(*_args, **_kwargs):
        raise OSError(filesystem_errno, "local subprocess failure")

    monkeypatch.setattr(subprocess, "run", unavailable)

    with pytest.raises(OSError) as raised:
        client.submit(
            JobRequest(
                stage_id="protein_identity",
                command=("python", "main.py"),
                working_directory=str(root),
            )
        )
    assert not isinstance(raised.value, HPCTransportError)


def test_native_slurm_reads_and_downloads_only_confined_regular_files(tmp_path):
    root = tmp_path / "hpc-root"
    root.mkdir()
    client = NativeSlurmClient(_settings(root))
    result = root / "jobs" / "run" / "manifest.json"
    client.ensure_directory(str(result.parent))
    result.write_text('{"status":"success"}\n', encoding="utf-8")

    assert client.read_text(str(result), 1_000) == '{"status":"success"}\n'
    downloaded = tmp_path / "artifacts" / "manifest.json"
    size, digest = client.download_to(str(result), downloaded, 1_000)
    assert size == downloaded.stat().st_size
    assert digest
    assert downloaded.read_text(encoding="utf-8") == result.read_text(encoding="utf-8")

    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "link").symlink_to(outside, target_is_directory=True)
    with pytest.raises(RuntimeError, match="symlinked component"):
        client.read_text(str(root / "link" / "manifest.json"), 1_000)

    with pytest.raises(RuntimeError, match="outside"):
        client.read_text(str(outside / "manifest.json"), 1_000)


def test_bounded_tar_writer_is_deterministic_and_enforces_limits(tmp_path):
    archive = tmp_path / "artifacts" / "bundle.tar"
    writer = BoundedTarWriter(archive, max_bytes=32_768, max_entries=4)
    writer.add_directory("bundle")
    writer.add_file("bundle/result.txt", source=io.BytesIO(b"result"), size=6)
    size, digest = writer.close()

    assert size == archive.stat().st_size
    assert len(digest) == 64
    with tarfile.open(archive, "r") as stream:
        assert stream.getnames() == ["bundle", "bundle/result.txt"]
        assert stream.extractfile("bundle/result.txt").read() == b"result"

    second_archive = tmp_path / "artifacts" / "bundle-second.tar"
    second = BoundedTarWriter(second_archive, max_bytes=32_768, max_entries=4)
    second.add_directory("bundle")
    second.add_file("bundle/result.txt", source=io.BytesIO(b"result"), size=6)
    second_size, second_digest = second.close()
    assert second_size == size
    assert second_digest == digest
    assert second_archive.read_bytes() == archive.read_bytes()

    limited = BoundedTarWriter(tmp_path / "limited.tar", max_bytes=4_096, max_entries=1)
    limited.add_directory("bundle")
    with pytest.raises(ArchiveError, match="too many entries"):
        limited.add_file("bundle/result.txt", source=io.BytesIO(b"x"), size=1)
    limited.abort()

    invalid = BoundedTarWriter(tmp_path / "invalid.tar", max_bytes=32_768, max_entries=4)
    with pytest.raises(ArchiveError, match="unsafe archive path"):
        invalid.add_file("bundle//escape", source=io.BytesIO(b"x"), size=1)
    invalid.abort()


def test_native_slurm_archives_confined_directory_without_symlinks(tmp_path):
    root = tmp_path / "hpc-root"
    root.mkdir()
    client = NativeSlurmClient(_settings(root))
    bundle = root / "jobs" / "bundle"
    client.ensure_directory(str(bundle / "nested"))
    (bundle / "result.txt").write_text("result", encoding="utf-8")
    (bundle / "nested" / "metrics.json").write_text("{}\n", encoding="utf-8")

    archive = tmp_path / "artifacts" / "bundle.tar"
    size, digest = client.download_directory_to(str(bundle), archive, 32_768, 10)

    assert size == archive.stat().st_size
    assert len(digest) == 64
    with tarfile.open(archive, "r") as stream:
        assert stream.getnames() == [
            "bundle",
            "bundle/nested",
            "bundle/nested/metrics.json",
            "bundle/result.txt",
        ]

    outside = tmp_path / "outside"
    outside.mkdir()
    (bundle / "escape").symlink_to(outside, target_is_directory=True)
    with pytest.raises(RuntimeError, match="symlink"):
        client.download_directory_to(str(bundle), tmp_path / "artifacts" / "unsafe.tar", 32_768, 10)

    many = root / "jobs" / "many"
    client.ensure_directory(str(many))
    for index in range(10):
        (many / f"file-{index}").write_bytes(b"x")
    bounded_archive = tmp_path / "artifacts" / "bounded.tar"
    with pytest.raises(ArchiveError, match="too many entries"):
        client.download_directory_to(str(many), bounded_archive, 32_768, 3)
    assert not bounded_archive.exists()


class _FakeArchiveSFTP:
    def __init__(self, root: str, directories: set[str], files: dict[str, bytes]):
        self.root = root
        self.directories = directories
        self.files = files
        self.symlinks: set[str] = set()
        self.iterated = 0

    def lstat(self, path: str):
        if path in self.symlinks:
            return SimpleNamespace(
                st_mode=stat.S_IFLNK | 0o777,
                st_size=0,
                st_mtime=1,
                st_uid=1000,
                st_gid=1000,
            )
        if path in self.directories:
            return SimpleNamespace(
                st_mode=stat.S_IFDIR | 0o755,
                st_size=0,
                st_mtime=1,
                st_uid=1000,
                st_gid=1000,
            )
        if path in self.files:
            return SimpleNamespace(
                st_mode=stat.S_IFREG | 0o600,
                st_size=len(self.files[path]),
                st_mtime=1,
                st_uid=1000,
                st_gid=1000,
            )
        raise FileNotFoundError(path)

    def listdir_iter(self, path: str, read_aheads: int):
        assert read_aheads == 16
        prefix = f"{path.rstrip('/')}/"
        children = set()
        for candidate in (*self.directories, *self.files, *self.symlinks):
            if candidate.startswith(prefix):
                name = candidate[len(prefix) :].split("/", 1)[0]
                if name:
                    children.add(name)
        for name in sorted(children):
            self.iterated += 1
            child = f"{prefix}{name}"
            attributes = self.lstat(child)
            yield SimpleNamespace(filename=name, **attributes.__dict__)

    def open(self, path: str, _mode: str):
        return io.BytesIO(self.files[path])

    def close(self):
        return None


class _FakeArchiveSSH:
    def __init__(self, sftp: _FakeArchiveSFTP):
        self.sftp = sftp

    def open_sftp(self):
        return self.sftp

    def close(self):
        return None


def _ssh_archive_client(tmp_path: Path, sftp: _FakeArchiveSFTP) -> SSHSlurmClient:
    tmp_path.mkdir(parents=True, exist_ok=True)
    password_path = tmp_path / "password"
    password_path.write_text("secret\n", encoding="utf-8")
    password_path.chmod(0o600)
    client = SSHSlurmClient(
        Settings(
            app_env="test",
            database_url="sqlite://",
            hpc_ssh_host="mn5.example",
            hpc_ssh_username="runner",
            hpc_ssh_password_file=password_path,
            hpc_remote_root=sftp.root,
        )
    )
    client._connect = lambda: _FakeArchiveSSH(sftp)
    return client


def test_ssh_slurm_archives_confined_directory_and_bounds_listing(tmp_path):
    root = "/gpfs/project/root"
    bundle = f"{root}/bundle"
    nested = f"{bundle}/nested"
    sftp = _FakeArchiveSFTP(
        root,
        {root, bundle, nested},
        {
            f"{bundle}/result.txt": b"result",
            f"{nested}/metrics.json": b"{}\n",
        },
    )
    client = _ssh_archive_client(tmp_path, sftp)
    archive = tmp_path / "artifacts" / "bundle.tar"

    size, digest = client.download_directory_to(bundle, archive, 32_768, 10)

    assert size == archive.stat().st_size
    assert len(digest) == 64
    with tarfile.open(archive, "r") as stream:
        assert stream.getnames() == [
            "bundle",
            "bundle/nested",
            "bundle/nested/metrics.json",
            "bundle/result.txt",
        ]

    sftp.symlinks.add(f"{bundle}/escape")
    with pytest.raises(RuntimeError, match="symlink"):
        client.download_directory_to(bundle, tmp_path / "artifacts" / "unsafe.tar", 32_768, 10)

    many_files = {f"{bundle}/file-{index}": b"x" for index in range(10)}
    bounded_sftp = _FakeArchiveSFTP(root, {root, bundle}, many_files)
    bounded_client = _ssh_archive_client(tmp_path / "bounded", bounded_sftp)
    with pytest.raises(ArchiveError, match="too many entries"):
        bounded_client.download_directory_to(
            bundle,
            tmp_path / "artifacts" / "bounded.tar",
            32_768,
            3,
        )
    assert bounded_sftp.iterated == 4


def test_native_slurm_rejects_job_paths_outside_root(tmp_path):
    root = tmp_path / "hpc-root"
    root.mkdir()
    client = NativeSlurmClient(_settings(root))
    request = JobRequest(
        stage_id="protein_identity",
        command=("python", "main.py"),
        working_directory=str(tmp_path / "outside"),
    )

    with pytest.raises(RuntimeError, match="outside"):
        client.submit(request)


def test_native_slurm_rejects_dot_segments_at_every_file_boundary(tmp_path):
    root = tmp_path / "hpc-root"
    root.mkdir()
    client = NativeSlurmClient(_settings(root))
    unsafe = f"{root}/jobs/../outside/result"
    target = tmp_path / "artifacts" / "result"

    with pytest.raises(RuntimeError, match="unsafe component"):
        client.read_text(unsafe, 1_000)
    with pytest.raises(RuntimeError, match="unsafe component"):
        client.download_to(unsafe, target, 1_000)
    with pytest.raises(RuntimeError, match="unsafe component"):
        client.download_directory_to(unsafe, target, 32_768, 10)
    with pytest.raises(RuntimeError, match="unsafe component"):
        client.ensure_directory(unsafe)
    with pytest.raises(RuntimeError, match="unsafe component"):
        client.submit(
            JobRequest(
                stage_id="protein_identity",
                command=("python", "main.py"),
                working_directory=unsafe,
            )
        )


def test_native_stage_executor_selects_native_client(tmp_path):
    from app.features.runs.remote_executor import NativeStageExecutor

    root = tmp_path / "hpc-root"
    root.mkdir()
    settings = _settings(root)
    settings.hpc_execution_mode = "native"

    executor = NativeStageExecutor(settings)

    assert isinstance(executor.client, NativeSlurmClient)
