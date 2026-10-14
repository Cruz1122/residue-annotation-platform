from __future__ import annotations

import json
import logging
import re
from collections import defaultdict
from collections.abc import Iterable, Mapping
from threading import Lock
from typing import TYPE_CHECKING

from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

_METRIC_NAME = re.compile(r"^[a-zA-Z_:][a-zA-Z0-9_:]*$")
_LABEL_NAME = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
_COUNTERS: defaultdict[tuple[str, tuple[tuple[str, str], ...]], int] = defaultdict(int)
_LOCK = Lock()
_LOGGER = logging.getLogger("app.worker")


def increment_counter(name: str, labels: Mapping[str, object] | None = None) -> None:
    """Increment an in-process counter with bounded, non-sensitive labels."""

    if not _METRIC_NAME.fullmatch(name):
        raise ValueError("invalid metric name")
    normalized = tuple(sorted((key, str(value)) for key, value in (labels or {}).items()))
    if any(not _LABEL_NAME.fullmatch(key) for key, _ in normalized):
        raise ValueError("invalid metric label")
    with _LOCK:
        _COUNTERS[(name, normalized)] += 1


def render_metrics(session: Session | None = None) -> str:
    """Render process counters and bounded database gauges.

    The worker and API run in separate processes.  Process-local counters are
    useful for diagnosing one process, but they cannot describe work performed
    by its sibling.  When a database session is available, add aggregate
    state gauges from durable run/stage rows so the API endpoint represents the
    whole deployment.  Database failures are intentionally fail-soft: the
    endpoint still exposes process counters and a zero availability gauge.
    """

    with _LOCK:
        snapshot = dict(_COUNTERS)
    lines: list[str] = []

    for name in sorted({name for name, _ in snapshot}):
        _append_samples(
            lines,
            name,
            "counter",
            (
                (labels, value)
                for (metric_name, labels), value in snapshot.items()
                if metric_name == name
            ),
        )

    database_available = 0
    if session is not None:
        try:
            from app.features.runs.models import ActiveRunSlot, Run, RunStage

            run_counts = session.execute(
                select(Run.status, func.count()).group_by(Run.status)
            ).all()
            stage_counts = session.execute(
                select(RunStage.stage_id, RunStage.status, func.count()).group_by(
                    RunStage.stage_id, RunStage.status
                )
            ).all()
            active_slots = session.scalar(select(func.count()).select_from(ActiveRunSlot))
            database_available = 1
        except SQLAlchemyError:
            session.rollback()
        else:
            _append_samples(
                lines,
                "rap_runs_by_status",
                "gauge",
                (((("status", str(status)),), int(count)) for status, count in run_counts),
            )
            _append_samples(
                lines,
                "rap_run_stages_by_status",
                "gauge",
                (
                    ((("stage_id", str(stage_id)), ("status", str(status))), int(count))
                    for stage_id, status, count in stage_counts
                ),
            )
            _append_samples(
                lines,
                "rap_active_run_slots",
                "gauge",
                (((), int(active_slots or 0)),),
            )

    _append_samples(
        lines,
        "rap_metrics_database_available",
        "gauge",
        (((), database_available),),
    )
    return "\n".join(lines) + ("\n" if lines else "")


def _append_samples(
    lines: list[str],
    name: str,
    metric_type: str,
    samples: Iterable[tuple[tuple[tuple[str, str], ...], int]],
) -> None:
    lines.append(f"# TYPE {name} {metric_type}")
    for labels, value in samples:
        label_text = ""
        if labels:
            label_text = (
                "{" + ",".join(f'{key}="{_escape_label(value)}"' for key, value in labels) + "}"
            )
        lines.append(f"{name}{label_text} {value}")


def log_worker_event(
    event: str,
    *,
    run_id: str | None = None,
    stage_id: str | None = None,
    job_id: str | None = None,
    status: str | None = None,
    error_code: str | None = None,
) -> None:
    """Emit a correlation-safe worker event without error text or secrets."""

    payload = {"event": event}
    for key, value in (
        ("run_id", run_id),
        ("stage_id", stage_id),
        ("job_id", job_id),
        ("status", status),
        ("error_code", error_code),
    ):
        if value is not None:
            payload[key] = value
    _LOGGER.info("worker_event %s", json.dumps(payload, sort_keys=True, separators=(",", ":")))
    labels = {"event": event}
    if stage_id is not None:
        labels["stage_id"] = stage_id
    if status is not None:
        labels["status"] = status
    increment_counter("rap_worker_stage_events_total", labels)


def _escape_label(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def reset_metrics() -> None:
    """Clear counters for isolated test processes."""

    with _LOCK:
        _COUNTERS.clear()
