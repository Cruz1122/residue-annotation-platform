from __future__ import annotations

import json
import re
import shlex
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Protocol


class HPCTransportError(Exception):
    """A temporary HPC transport failure with no scientific state decision."""


class HPCSubmissionAmbiguousError(HPCTransportError):
    """Slurm accepted a job but the local product receipt was not confirmed."""

    def __init__(self, job_id: str):
        self.job_id = job_id
        super().__init__(f"Slurm submission receipt is ambiguous for job {job_id}")


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


@dataclass(frozen=True, slots=True)
class PrefetchRequest:
    """Validated external-preparation request for one confirmed run.

    The request deliberately carries requirement identifiers rather than an
    arbitrary shell command. The configured transport adapter owns the
    command spelling; the worker only decides which approved requirements are
    needed by the selected stage.
    """

    accession: str
    requirements: tuple[str, ...]
    working_directory: str
    environment: dict[str, str] = field(default_factory=dict)
    receipt_path: str | None = None


@dataclass(frozen=True, slots=True)
class PrefetchResult:
    status: str
    requirements: tuple[str, ...]
    snapshots: dict[str, object] = field(default_factory=dict)
    message: str | None = None


_PREFETCH_MAX_OUTPUT_BYTES = 64 * 1024
_PREFETCH_MAX_SNAPSHOT_BYTES = 16 * 1024


def render_prefetch_command(template: str | None, request: PrefetchRequest) -> str:
    """Render an operator-approved, requirement-scoped prefetch command.

    The scientific pipeline's exact prefetch alias is deployment-specific. It
    is therefore configured explicitly instead of being guessed in the
    application. Requiring both placeholders makes a command that silently
    fetches every external resource impossible to enable by accident.
    """

    if not template or not template.strip():
        raise HPCConfigurationError("HPC prefetch command is not configured")
    required_placeholders = ("{accession}", "{requirements}")
    if any(placeholder not in template for placeholder in required_placeholders):
        raise HPCConfigurationError(
            "HPC prefetch command must include {accession} and {requirements}"
        )
    rendered = template
    rendered = rendered.replace("{accession}", shlex.quote(request.accession))
    rendered = rendered.replace(
        "{requirements}",
        shlex.quote(json.dumps(list(request.requirements), separators=(",", ":"))),
    )
    rendered = rendered.replace("{working_directory}", shlex.quote(request.working_directory))
    exports: list[str] = []
    for key, value in request.environment.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise HPCConfigurationError("prefetch environment contains an invalid variable name")
        exports.append(f"export {key}={shlex.quote(value)}")
    return " && ".join(
        [f"cd -- {shlex.quote(request.working_directory)}", *exports, rendered]
    ).strip()


def parse_prefetch_result(output: str, request: PrefetchRequest) -> PrefetchResult:
    """Parse the bounded JSON acknowledgement emitted by the prefetch tool."""

    def failed(message: str) -> PrefetchResult:
        return PrefetchResult(
            status="failed",
            requirements=request.requirements,
            snapshots={},
            message=message[:1000],
        )

    try:
        if len(output.encode("utf-8")) > _PREFETCH_MAX_OUTPUT_BYTES:
            return failed("prefetch acknowledgement exceeds the configured size limit")
    except UnicodeEncodeError:
        return failed("prefetch acknowledgement is not valid UTF-8")
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if not lines:
        return failed("prefetch command returned no acknowledgement")
    try:
        payload = json.loads(lines[-1])
    except json.JSONDecodeError:
        return failed("prefetch command returned a malformed acknowledgement")
    if not isinstance(payload, dict):
        return failed("prefetch acknowledgement must be a JSON object")

    declared_status = payload.get("status")
    if declared_status == "failed":
        message = payload.get("message")
        return failed(str(message or "prefetch command reported failure"))
    if declared_status != "success":
        return failed("prefetch acknowledgement must declare status=success")

    declared_requirements = payload.get("requirements")
    if not isinstance(declared_requirements, list) or not all(
        isinstance(item, str) and item for item in declared_requirements
    ):
        return failed("prefetch acknowledgement must list requirements")
    acknowledged = tuple(sorted(declared_requirements))
    if len(acknowledged) != len(set(acknowledged)) or set(acknowledged) != set(
        request.requirements
    ):
        return failed("prefetch acknowledgement requirements do not match the request")

    snapshots = payload.get("snapshots", {})
    if not isinstance(snapshots, dict) or not all(
        isinstance(key, str) and key for key in snapshots
    ):
        return failed("prefetch acknowledgement snapshots must be an object")
    try:
        encoded_snapshots = json.dumps(
            snapshots,
            allow_nan=False,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError):
        return failed("prefetch acknowledgement snapshots are not JSON serializable")
    if len(encoded_snapshots) > _PREFETCH_MAX_SNAPSHOT_BYTES:
        return failed("prefetch acknowledgement snapshots exceed the size limit")

    declared_message = payload.get("message")
    message = declared_message[:1000] if isinstance(declared_message, str) else None
    return PrefetchResult(
        status="success",
        requirements=acknowledged,
        snapshots=snapshots,
        message=message,
    )


class HPCClient(Protocol):
    def submit(self, request: JobRequest) -> JobHandle: ...

    def status(self, job_id: str) -> JobStatus: ...

    def cancel(self, job_id: str) -> JobStatus: ...

    def prepare_external(self, request: PrefetchRequest) -> PrefetchResult: ...
