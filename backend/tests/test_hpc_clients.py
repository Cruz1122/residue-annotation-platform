import subprocess

import pytest
from app.core.config import Settings
from app.infrastructure.hpc.base import JobRequest, JobState
from app.infrastructure.hpc.native import NativeSlurmClient


def _settings() -> Settings:
    return Settings(
        app_env="test",
        database_url="sqlite://",
        hpc_slurm_account="bsc-test",
        hpc_slurm_partition="debug",
        hpc_slurm_qos="normal",
        hpc_slurm_time="00:10:00",
    )


def test_native_slurm_submit_propagates_resources_environment_and_paths():
    client = NativeSlurmClient(_settings())
    captured: list[list[str]] = []
    client._run = lambda args: captured.append(args) or "12345;cluster"

    handle = client.submit(
        JobRequest(
            stage_id="protein_identity",
            command=("python", "main.py", "--stage", "protein_identity"),
            working_directory="/gpfs/project/root",
            environment={"PYTHONUNBUFFERED": "1"},
            cpu=4,
            gpu=1,
            memory_gb=8,
            time_limit="00:05:00",
            job_name="rap-protein",
            stdout_path="/gpfs/project/root/job.out",
            stderr_path="/gpfs/project/root/job.err",
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
    assert "--output=/gpfs/project/root/job.out" in args
    assert "--error=/gpfs/project/root/job.err" in args
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
