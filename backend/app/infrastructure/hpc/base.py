from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Protocol


class HPCTransportError(Exception):
    """A temporary HPC transport failure with no scientific state decision."""


class HPCConfigurationError(RuntimeError):
    """A permanent HPC configuration failure requiring operator action."""


class JobState(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    CANCELLED = "cancelled"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class JobRequest:
    stage_id: str
    command: tuple[str, ...]
    working_directory: str
    environment: dict[str, str] = field(default_factory=dict)
    cpu: int = 1
    gpu: int = 0
    network: bool = False
    memory_gb: int | None = None
    time_limit: str | None = None
    job_name: str | None = None
    stdout_path: str | None = None
    stderr_path: str | None = None
    # A deterministic, confined receipt lets a worker recover a submission
    # when Slurm accepted it but the client lost the response before the
    # database commit. This is metadata, not a generated .sbatch script.
    submission_receipt_path: str | None = None


@dataclass(frozen=True, slots=True)
class JobHandle:
    job_id: str
    state: JobState


@dataclass(frozen=True, slots=True)
class JobStatus:
    job_id: str
    state: JobState
    message: str | None = None


class HPCClient(Protocol):
    def submit(self, request: JobRequest) -> JobHandle: ...

    def status(self, job_id: str) -> JobStatus: ...

    def cancel(self, job_id: str) -> JobStatus: ...
