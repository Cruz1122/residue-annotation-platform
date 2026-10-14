from __future__ import annotations

from uuid import uuid4

from app.infrastructure.hpc.base import JobHandle, JobRequest, JobState, JobStatus


class OfflineHPCClient:
    """Deterministic non-scientific adapter for unit tests and CI only.

    It never produces scientific output or a successful stage result. It exists
    so state-machine and cancellation tests do not require Slurm credentials.
    """

    def __init__(self) -> None:
        self.jobs: dict[str, JobStatus] = {}

    def submit(self, request: JobRequest) -> JobHandle:
        job_id = f"offline-{uuid4()}"
        status = JobStatus(
            job_id=job_id,
            state=JobState.FAILED,
            message="offline execution has no scientific runner",
        )
        self.jobs[job_id] = status
        return JobHandle(job_id=job_id, state=status.state)

    def status(self, job_id: str) -> JobStatus:
        return self.jobs.get(job_id, JobStatus(job_id, JobState.UNKNOWN, "job not found"))

    def cancel(self, job_id: str) -> JobStatus:
        status = JobStatus(job_id=job_id, state=JobState.CANCELLED, message="cancelled offline")
        self.jobs[job_id] = status
        return status
