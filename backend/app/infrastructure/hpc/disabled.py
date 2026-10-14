from app.infrastructure.hpc.base import JobHandle, JobRequest, JobState, JobStatus


class HPCUnavailableError(RuntimeError):
    pass


class DisabledHPCClient:
    def submit(self, request: JobRequest) -> JobHandle:
        raise HPCUnavailableError("HPC execution is not configured")

    def status(self, job_id: str) -> JobStatus:
        return JobStatus(job_id=job_id, state=JobState.UNKNOWN, message="HPC is not configured")

    def cancel(self, job_id: str) -> JobStatus:
        return JobStatus(job_id=job_id, state=JobState.UNKNOWN, message="HPC is not configured")
