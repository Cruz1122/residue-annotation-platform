from __future__ import annotations

import re
import shlex
import subprocess

from app.core.config import Settings
from app.infrastructure.hpc.base import JobHandle, JobRequest, JobState, JobStatus


class NativeSlurmClient:
    """Run Slurm commands only on an explicitly approved native BSC host."""

    def __init__(self, settings: Settings):
        self.settings = settings

    def _run(self, args: list[str]) -> str:
        completed = subprocess.run(
            args,
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
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
                request.working_directory,
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
        if request.stdout_path:
            args.append(f"--output={request.stdout_path}")
        if request.stderr_path:
            args.append(f"--error={request.stderr_path}")
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
