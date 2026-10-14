from enum import StrEnum


class RunStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    CANCEL_REQUESTED = "cancel_requested"
    CANCELLED = "cancelled"


class RunStageStatus(StrEnum):
    PENDING = "pending"
    READY = "ready"
    QUEUED = "queued"
    RUNNING = "running"
    REUSED = "reused"
    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"
    CANCELLED = "cancelled"


TERMINAL_STAGE_STATUSES = {
    RunStageStatus.REUSED,
    RunStageStatus.SUCCESS,
    RunStageStatus.FAILED,
    RunStageStatus.SKIPPED,
    RunStageStatus.CANCELLED,
}

# QUEUED/RUNNING may return to READY only through lease-expiry recovery in the
# worker; a terminal status (success/reused/failed/skipped/cancelled) still
# cannot transition back to an active state.
ALLOWED_STAGE_TRANSITIONS: dict[RunStageStatus, set[RunStageStatus]] = {
    RunStageStatus.PENDING: {
        RunStageStatus.READY,
        RunStageStatus.FAILED,
        RunStageStatus.SKIPPED,
        RunStageStatus.CANCELLED,
    },
    RunStageStatus.READY: {
        RunStageStatus.QUEUED,
        RunStageStatus.RUNNING,
        RunStageStatus.REUSED,
        RunStageStatus.SUCCESS,
        RunStageStatus.FAILED,
        RunStageStatus.CANCELLED,
    },
    RunStageStatus.QUEUED: {
        RunStageStatus.RUNNING,
        RunStageStatus.READY,
        RunStageStatus.REUSED,
        RunStageStatus.FAILED,
        RunStageStatus.CANCELLED,
    },
    RunStageStatus.RUNNING: {
        RunStageStatus.SUCCESS,
        RunStageStatus.REUSED,
        RunStageStatus.READY,
        RunStageStatus.FAILED,
        RunStageStatus.CANCELLED,
    },
    RunStageStatus.REUSED: set(),
    RunStageStatus.SUCCESS: set(),
    RunStageStatus.FAILED: {RunStageStatus.READY, RunStageStatus.CANCELLED},
    RunStageStatus.SKIPPED: set(),
    RunStageStatus.CANCELLED: set(),
}


def can_transition(current: RunStageStatus, target: RunStageStatus) -> bool:
    return target in ALLOWED_STAGE_TRANSITIONS.get(current, set())
