from __future__ import annotations

from collections.abc import Iterable
from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.features.annotations.models import ANNOTATION_TABLES
from app.features.runs.models import Run
from app.features.runs.schemas import AnnotationRead, AnnotationsResponse
from app.features.runs.state import RunStageStatus

ANNOTATION_INSERT_BATCH_SIZE = 1_000


def insert_annotation_rows(
    session: Session,
    stage_id: str,
    stage_result_id: str,
    rows: Iterable[dict[str, object]],
) -> None:
    table = ANNOTATION_TABLES[stage_id]
    batch: list[dict[str, object]] = []

    def flush_batch() -> None:
        if not batch:
            return
        session.execute(
            table.insert(),
            [
                {
                    "id": str(uuid4()),
                    "stage_result_id": stage_result_id,
                    "aa_position": row["aa_position"],
                    "aa_ref": row["aa_ref"],
                    "values": row.get("values", {}),
                    "units": row.get("units", {}),
                    "qc_status": row.get("qc_status", "unverified"),
                    "source_row": row.get("source_row"),
                }
                for row in batch
            ],
        )
        batch.clear()

    for row in rows:
        batch.append(row)
        if len(batch) >= ANNOTATION_INSERT_BATCH_SIZE:
            flush_batch()
    flush_batch()


def _position(row: dict[str, object]) -> int:
    return int(str(row["aa_position"]))


def _validate_rows(
    rows: Iterable[dict[str, object]],
    sequence: str,
    *,
    expected_positions: set[int] | None = None,
) -> None:
    """Validate positions and references in a single pass without allocating
    a per-sequence position set: a plain range check is O(1) memory."""

    sequence_length = len(sequence)
    for row in rows:
        position = _position(row)
        if expected_positions is not None:
            if position not in expected_positions:
                raise ValueError("annotation position is outside the canonical sequence")
        elif position < 1 or position > sequence_length:
            raise ValueError("annotation position is outside the canonical sequence")
        if str(row["aa_ref"]).upper() != sequence[position - 1]:
            raise ValueError(f"aa_ref mismatch at position {position}")


def annotations_for_run(
    session: Session,
    run: Run,
    *,
    limit: int | None = None,
    offset: int = 0,
) -> AnnotationsResponse:
    if offset < 0:
        raise ValueError("offset must not be negative")
    if limit is not None and limit < 1:
        raise ValueError("limit must be positive")

    protein_sequence = run.protein.sequence
    pending: list[str] = []
    failed: list[str] = []
    buffer: list[tuple[str, str, dict[str, object]]] = []
    truncated = False
    # Fetch one extra row to know whether another page exists without loading
    # every published row into memory.
    fetch_target = None if limit is None else limit + 1
    # Rows skipped by a deep offset are counted in SQL, not fetched and sliced.
    skip = offset

    for run_stage in run.stages:
        if run_stage.status in {
            RunStageStatus.PENDING,
            RunStageStatus.READY,
            RunStageStatus.QUEUED,
            RunStageStatus.RUNNING,
        }:
            pending.append(run_stage.stage_id)
            continue
        if run_stage.status == RunStageStatus.FAILED:
            failed.append(run_stage.stage_id)
            continue
        if run_stage.stage_result_id is None or run_stage.status not in {
            RunStageStatus.SUCCESS,
            RunStageStatus.REUSED,
        }:
            continue
        if fetch_target is not None and len(buffer) >= fetch_target:
            truncated = True
            break
        table = ANNOTATION_TABLES[run_stage.stage_id]
        query = (
            select(table)
            .where(table.c.stage_result_id == run_stage.stage_result_id)
            .order_by(table.c.aa_position)
        )
        if skip:
            total = session.scalar(
                select(func.count()).select_from(query.order_by(None).subquery())
            )
            if (total or 0) <= skip:
                skip -= total or 0
                continue
            query = query.offset(skip)
            skip = 0
        if fetch_target is not None:
            query = query.limit(fetch_target - len(buffer))
        stage_rows = [dict(row) for row in session.execute(query).mappings()]
        _validate_rows(stage_rows, protein_sequence)
        buffer.extend((run_stage.stage_id, run_stage.stage_result_id, row) for row in stage_rows)

    if fetch_target is not None and len(buffer) >= fetch_target:
        truncated = True
        buffer = buffer[: fetch_target - 1]

    page = buffer if limit is None else buffer[:limit]
    rows = [
        AnnotationRead(
            stage_id=stage_id,
            stage_result_id=stage_result_id,
            aa_position=_position(row),
            aa_ref=str(row["aa_ref"]),
            values=dict(row["values"]) if isinstance(row["values"], dict) else {},
            units=dict(row["units"]) if isinstance(row["units"], dict) else {},
            qc_status=str(row["qc_status"]),
        )
        for stage_id, stage_result_id, row in page
    ]
    return AnnotationsResponse(
        run_id=run.id,
        rows=rows,
        pending_stage_ids=pending,
        failed_stage_ids=failed,
        truncated=truncated,
    )
