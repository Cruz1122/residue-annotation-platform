import subprocess
from pathlib import Path

import pytest
from app.core.config import Settings
from app.infrastructure.hpc.base import JobRequest, JobState
from app.infrastructure.hpc.native import NativeSlurmClient


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


def test_native_stage_executor_selects_native_client(tmp_path):
    from app.features.runs.remote_executor import NativeStageExecutor

    root = tmp_path / "hpc-root"
    root.mkdir()
    settings = _settings(root)
    settings.hpc_execution_mode = "native"

    executor = NativeStageExecutor(settings)

    assert isinstance(executor.client, NativeSlurmClient)
