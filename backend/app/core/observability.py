from __future__ import annotations

import json
import logging
import re
from collections import defaultdict
from collections.abc import Mapping
from threading import Lock

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


def render_metrics() -> str:
    """Render counters in Prometheus text format without run identifiers."""

    with _LOCK:
        snapshot = dict(_COUNTERS)
    names = sorted({name for name, _ in snapshot})
    lines: list[str] = []
    for name in names:
        lines.append(f"# TYPE {name} counter")
        for (metric_name, labels), value in sorted(snapshot.items()):
            if metric_name != name:
                continue
            label_text = ""
            if labels:
                label_text = (
                    "{" + ",".join(f'{key}="{_escape_label(value)}"' for key, value in labels) + "}"
                )
            lines.append(f"{name}{label_text} {value}")
    return "\n".join(lines) + ("\n" if lines else "")


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
