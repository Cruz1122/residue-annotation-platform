from __future__ import annotations

import subprocess

from app.infrastructure.hpc.base import JobHandle, JobRequest, JobState, JobStatus


class NativeSlurmClient:
    """Run Slurm commands only on an explicitly approved native BSC host."""

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
        output = self._run(
            [
                "sbatch",
                "--parsable",
                "--chdir",
                request.working_directory,
                *([f"--cpus-per-task={request.cpu}"] if request.cpu else []),
                *([f"--gres=gpu:{request.gpu}"] if request.gpu else []),
                *([f"--mem={request.memory_gb}G"] if request.memory_gb else []),
                *request.command,
            ]
        )
        job_id = output.split(";", 1)[0].strip()
        return JobHandle(job_id=job_id, state=JobState.QUEUED)

    def status(self, job_id: str) -> JobStatus:
        output = self._run(["squeue", "--noheader", "--format=%T", "--jobs", job_id])
        state = output.strip().lower()
        mapped = {
            "pending": JobState.QUEUED,
            "running": JobState.RUNNING,
            "completed": JobState.SUCCESS,
            "failed": JobState.FAILED,
            "cancelled": JobState.CANCELLED,
        }.get(state, JobState.UNKNOWN)
        return JobStatus(job_id=job_id, state=mapped, message=output or None)

    def cancel(self, job_id: str) -> JobStatus:
        self._run(["scancel", job_id])
        return JobStatus(job_id=job_id, state=JobState.CANCELLED)
