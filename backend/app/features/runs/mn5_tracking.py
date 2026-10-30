"""Read-only synchronization of externally executed MN5 runs."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import math
import mimetypes
import os
import re
import tempfile
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath
from time import monotonic
from uuid import uuid4

from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.config import Settings
from app.features.annotations.models import ANNOTATION_TABLES
from app.features.annotations.service import insert_annotation_rows
from app.features.artifacts.storage import ArtifactPathError, ArtifactStore
from app.features.proteins.models import Protein
from app.features.runs.manifest import (
    REMOTE_HASH_MAX_BYTES,
    ManifestError,
    normalize_remote_manifest_paths,
    validate_remote_manifest,
)
from app.features.runs.models import Artifact, ExternalRunTracking, Run, RunStage, StageResult
from app.features.runs.state import RunStageStatus, RunStatus
from app.features.stages.registry import STAGE_BY_ID, STAGE_DEFINITIONS
from app.infrastructure.hpc.readonly import (
    InspectionError,
    build_read_only_inspector,
    validate_relative_path,
)

logger = logging.getLogger("app.worker")

_REMOTE_STAGE_STATUS = {
    "pending": RunStageStatus.PENDING,
    "ready": RunStageStatus.READY,
    "queued": RunStageStatus.QUEUED,
    "running": RunStageStatus.RUNNING,
    "success": RunStageStatus.SUCCESS,
    "completed": RunStageStatus.SUCCESS,
    "reused": RunStageStatus.REUSED,
    "cached": RunStageStatus.REUSED,
    "failed": RunStageStatus.FAILED,
    "partial_failed": RunStageStatus.FAILED,
    "skipped": RunStageStatus.SKIPPED,
    "cancelled": RunStageStatus.CANCELLED,
}
_DONE_STAGE_STATUSES = {
    RunStageStatus.SUCCESS,
    RunStageStatus.REUSED,
    RunStageStatus.SKIPPED,
    RunStageStatus.CANCELLED,
}
_MAX_REMOTE_JSON_DEPTH = 64
_NON_FILE_RESULT_ARTIFACTS = frozenset(
    {
        "alphafold_dir",
        "conformational_ensemble_final_dir",
        "ensemble_cache",
        "msa_cache_entry",
        "native_output_dir",
        "samples_xtc",
        "variant_dir",
    }
)
_EXTERNAL_RESULT_ARTIFACTS = frozenset({"foldx_relaxed_pdb", "rosettamp_relaxed_pdb"})
_KNOWN_STAGE_ARTIFACTS = (
    frozenset(
        str(artifact_type)
        for definition in STAGE_DEFINITIONS
        for artifact_type in (*definition.produced_artifacts, *definition.optional_artifacts)
    )
    | _EXTERNAL_RESULT_ARTIFACTS
)
_TERMINAL_RUN_STATUSES = {RunStatus.SUCCESS, RunStatus.FAILED, RunStatus.CANCELLED}
_PUBLICATION_STAGE_PRIORITY = {
    "protein_relaxation_energy": 0,
    "structure_modeling": 1,
    "variant_ddg": 2,
}
_FETCH_HEARTBEAT_SECONDS = 15
# Avoid paying for one SSH/SFTP handshake per small manifest or artifact.
_MANIFEST_FETCH_GROUP_SIZE = 8
_ARTIFACT_FETCH_GROUP_SIZE = 4
# Keep lineage context reads small so a slow remote file does not discard a
# large batch of otherwise readable run snapshots.
_LINEAGE_CONTEXT_FETCH_GROUP_SIZE = 4
_CANONICAL_ANNOTATION_FIELDS = {"protein_id", "aa_position", "aa_ref"}
_VARIANT_LABEL = re.compile(r"^(?P<ref>[A-Z])(?P<position>[1-9]\d*)(?P<alt>[A-Z])$")
_LINEAGE_RUN_TIMESTAMP = re.compile(r"_(?P<timestamp>\d{8}T\d{12}Z)$")


def _now() -> datetime:
    return datetime.now(UTC)


_LEGACY_STAGE_IDS = {stage.legacy_id: stage.id for stage in STAGE_DEFINITIONS}


def _canonical_stage_id(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    if value in STAGE_BY_ID:
        return value
    return _LEGACY_STAGE_IDS.get(value)


def _remote_stage_result(context: dict[str, object], stage_id: str) -> dict[str, object] | None:
    results = context.get("stage_results")
    if not isinstance(results, dict):
        return None
    direct = results.get(stage_id)
    if isinstance(direct, dict):
        return direct
    for remote_id, result in results.items():
        if _canonical_stage_id(remote_id) == stage_id and isinstance(result, dict):
            return result
    return None


def _result_cache_key(result: dict[str, object] | None) -> str | None:
    if not isinstance(result, dict):
        return None
    cache_key = result.get("cache_key")
    return (
        cache_key
        if isinstance(cache_key, str) and re.fullmatch(r"[0-9a-f]{64}", cache_key)
        else None
    )


def _remote_stage_statuses(context: dict[str, object]) -> dict[str, RunStageStatus]:
    input_state = context.get("input_state")
    input_state = input_state if isinstance(input_state, dict) else {}
    statuses: dict[str, RunStageStatus] = {}
    for raw in (context.get("stage_status"), input_state.get("stage_status")):
        if not isinstance(raw, dict):
            continue
        for remote_id, status in raw.items():
            stage_id = _canonical_stage_id(remote_id)
            if stage_id is None or not isinstance(status, str):
                continue
            mapped = _REMOTE_STAGE_STATUS.get(status.strip().lower())
            if mapped is not None:
                statuses[str(stage_id)] = mapped
    results = context.get("stage_results")
    if isinstance(results, dict):
        for remote_id, result in results.items():
            stage_id = _canonical_stage_id(remote_id)
            if stage_id is None or stage_id in statuses or not isinstance(result, dict):
                continue
            status = result.get("status")
            if isinstance(status, str) and (mapped := _REMOTE_STAGE_STATUS.get(status.lower())):
                statuses[str(stage_id)] = mapped
    return statuses


def _remote_run_status(context: dict[str, object]) -> str | None:
    """Return MN5's global run status independently of observed stage statuses."""

    input_state = context.get("input_state")
    input_state = input_state if isinstance(input_state, dict) else {}
    value = input_state.get("run_status") or context.get("run_status")
    return value.strip().lower() if isinstance(value, str) and value.strip() else None


def _remote_stage_ids(context: dict[str, object]) -> tuple[str, ...]:
    """Return selected or observed stages from every supported context field."""

    input_state = context.get("input_state")
    input_state = input_state if isinstance(input_state, dict) else {}
    stage_results = context.get("stage_results")
    stage_results = stage_results if isinstance(stage_results, dict) else {}
    observed = set(_remote_stage_statuses(context))
    observed.update(
        stage_id
        for remote_id in stage_results
        if (stage_id := _canonical_stage_id(remote_id)) is not None
    )
    for raw in (
        context.get("stage_ids"),
        context.get("selected_stage_ids"),
        input_state.get("stage_ids"),
        input_state.get("selected_stage_ids"),
    ):
        if isinstance(raw, dict):
            observed.update(
                stage_id
                for remote_id in raw
                if (stage_id := _canonical_stage_id(remote_id)) is not None
            )
        elif isinstance(raw, (list, tuple, set)):
            observed.update(
                stage_id
                for remote_id in raw
                if (stage_id := _canonical_stage_id(remote_id)) is not None
            )
    return tuple(stage.id for stage in STAGE_DEFINITIONS if stage.id in observed)


def _is_reference_sequence_context(context: dict[str, object], query: str, reference: str) -> bool:
    """Accept a canonical sequence or an explicitly declared exact PDB chain."""

    if query == reference:
        return True
    input_state = context.get("input_state")
    input_state = input_state if isinstance(input_state, dict) else {}
    requested_chain = input_state.get("requested_pdb_chain")
    selected_chain = input_state.get("selected_pdb_chain")
    return (
        input_state.get("sequence_scope") == "declared_polymer_chain"
        and input_state.get("sequence_source") == "pdb_seqres"
        and isinstance(selected_chain, str)
        and bool(selected_chain)
        and (requested_chain is None or requested_chain == selected_chain)
        and bool(query)
        and query in reference
    )


def _lineage_prefix(remote_run_id: str) -> str | None:
    match = _LINEAGE_RUN_TIMESTAMP.search(remote_run_id)
    return remote_run_id[: match.start()] if match else None


def _discover_lineage_context_paths(
    settings: Settings,
    trackings: list[ExternalRunTracking],
) -> dict[str, list[str]]:
    """Find timestamped contexts sharing each linked base run's stable ID."""

    prefixes = {
        tracking.id: _lineage_prefix(tracking.remote_run_id)
        for tracking in trackings
        if tracking.run_type == "base"
    }
    wanted = {prefix for prefix in prefixes.values() if prefix is not None}
    if not wanted:
        return {}
    try:
        entries = build_read_only_inspector(settings).list("runs")
    except Exception as exc:  # Remote directory listing is an adapter boundary.
        logger.info("mn5_lineage_listing_unavailable type=%s", type(exc).__name__)
        return {}

    paths_by_prefix: dict[str, set[str]] = {prefix: set() for prefix in wanted}
    for entry in entries:
        if not entry.is_directory:
            continue
        remote_run_id = PurePosixPath(entry.path).name
        timestamp = _LINEAGE_RUN_TIMESTAMP.search(remote_run_id)
        if timestamp is None:
            continue
        prefix = remote_run_id[: timestamp.start()]
        if prefix in paths_by_prefix:
            try:
                paths_by_prefix[prefix].add(
                    str(validate_relative_path(f"runs/{remote_run_id}/run_context.json"))
                )
            except InspectionError:
                continue

    return {
        tracking_id: sorted(paths_by_prefix[prefix])
        for tracking_id, prefix in prefixes.items()
        if prefix is not None
    }


def _has_explicit_variant(context: dict[str, object]) -> bool:
    if isinstance(context.get("variant_ref"), str) and isinstance(context.get("variant_alt"), str):
        return True
    for value in (context.get("normalized_variants"), context.get("variants")):
        if isinstance(value, (list, tuple, dict)) and value:
            return True
    input_state = context.get("input_state")
    if isinstance(input_state, dict):
        for key in ("normalized_variants", "variants"):
            value = input_state.get(key)
            if isinstance(value, (list, tuple, dict)) and value:
                return True
    variant = context.get("variant")
    return isinstance(variant, str) and _VARIANT_LABEL.fullmatch(variant) is not None


def _aggregate_lineage_snapshot(
    tracking: ExternalRunTracking,
    primary: dict[str, object],
    sibling_contexts: list[dict[str, object]],
) -> dict[str, object]:
    """Combine latest explicit base-stage states across one stable remote lineage."""

    primary_context = {
        key: value for key, value in primary.items() if not key.startswith("_lineage_")
    }
    if tracking.run_type != "base":
        return primary_context
    prefix = _lineage_prefix(tracking.remote_run_id)
    primary_run_id = primary.get("run_id")
    primary_reference = primary.get("reference_sequence") or primary.get("sequence")
    if (
        prefix is None
        or primary_run_id != tracking.remote_run_id
        or not isinstance(primary_reference, str)
    ):
        return primary_context

    accepted: list[
        tuple[str, str, dict[str, object], tuple[str, ...], dict[str, RunStageStatus]]
    ] = []
    for context in (primary, *sibling_contexts):
        remote_run_id = context.get("run_id")
        if not isinstance(remote_run_id, str) or not remote_run_id.startswith(f"{prefix}_"):
            continue
        timestamp = _LINEAGE_RUN_TIMESTAMP.search(remote_run_id)
        if timestamp is None:
            continue
        declared_accession = context.get("uniprot_accession")
        if (
            isinstance(declared_accession, str)
            and declared_accession.strip().upper() != tracking.accession.upper()
        ):
            continue
        query = context.get("query_sequence") or context.get("sequence")
        reference = context.get("reference_sequence") or context.get("sequence")
        if (
            not isinstance(query, str)
            or not isinstance(reference, str)
            or reference != primary_reference
            or not _is_reference_sequence_context(context, query, reference)
            or _has_explicit_variant(context)
        ):
            continue
        stage_ids = _remote_stage_ids(context)
        if not stage_ids or "variant_ddg" in stage_ids:
            continue
        statuses = _remote_stage_statuses(context)
        accepted.append(
            (
                f"{timestamp.group('timestamp')}:{remote_run_id}",
                remote_run_id,
                context,
                stage_ids,
                statuses,
            )
        )

    if not any(item[1] == tracking.remote_run_id for item in accepted):
        primary_context["_lineage_context_rejected"] = True
        return primary_context

    latest_statuses: dict[str, tuple[str, RunStageStatus, str]] = {}
    latest_results: dict[str, tuple[str, str, dict[str, object]]] = {}
    observed_stage_ids: set[str] = set()
    for order, remote_run_id, _context, stage_ids, statuses in accepted:
        observed_stage_ids.update(stage_ids)
        for stage_id, status in statuses.items():
            current = latest_statuses.get(stage_id)
            if current is None or order >= current[0]:
                latest_statuses[stage_id] = (order, status, remote_run_id)

        for stage_id, status in statuses.items():
            if status not in {RunStageStatus.SUCCESS, RunStageStatus.REUSED}:
                continue
            result = _remote_stage_result(_context, stage_id)
            cache_key = _result_cache_key(result)
            if result is None or cache_key is None:
                continue
            result_status = result.get("status")
            if isinstance(result_status, str):
                mapped_result_status = _REMOTE_STAGE_STATUS.get(result_status.strip().lower())
                if mapped_result_status not in {RunStageStatus.SUCCESS, RunStageStatus.REUSED}:
                    continue
            current_result = latest_results.get(stage_id)
            if current_result is None or order >= current_result[0]:
                latest_results[stage_id] = (order, remote_run_id, result)

    latest_context = max(accepted, key=lambda item: item[0])[2]
    latest_run_status = _remote_run_status(latest_context) or _remote_run_status(primary)
    aggregate = dict(primary_context)
    aggregate["stage_status"] = {
        stage_id: status.value
        for stage_id, (_order, status, _remote_run_id) in latest_statuses.items()
    }
    aggregate["stage_ids"] = [
        stage.id for stage in STAGE_DEFINITIONS if stage.id in observed_stage_ids
    ]
    aggregate["_lineage_stage_sources"] = {
        stage_id: remote_run_id
        for stage_id, (_order, _status, remote_run_id) in latest_statuses.items()
    }
    primary_results = primary_context.get("stage_results")
    merged_results: dict[str, object] = {}
    if isinstance(primary_results, dict):
        for remote_id, result in primary_results.items():
            stage_id = _canonical_stage_id(remote_id)
            if stage_id is not None and isinstance(result, dict):
                merged_results[stage_id] = result
    result_sources: dict[str, str] = {}
    for stage_id in observed_stage_ids:
        latest_status = latest_statuses.get(stage_id)
        merged_results.pop(stage_id, None)
        if latest_status is None or latest_status[1] not in {
            RunStageStatus.SUCCESS,
            RunStageStatus.REUSED,
        }:
            continue
        latest_result = latest_results.get(stage_id)
        if latest_result is not None and latest_result[1] == latest_status[2]:
            merged_results[stage_id] = latest_result[2]
            result_sources[stage_id] = latest_result[1]
    aggregate["stage_results"] = merged_results
    aggregate["_lineage_stage_result_sources"] = result_sources
    input_state = primary_context.get("input_state")
    input_state = dict(input_state) if isinstance(input_state, dict) else {}
    input_state.pop("stage_status", None)
    if latest_run_status is not None:
        input_state["run_status"] = latest_run_status
    aggregate["input_state"] = input_state
    return aggregate


def _verified_lineage_result_contexts(
    aggregate: dict[str, object],
    candidates: dict[str, dict[str, object]],
) -> dict[str, dict[str, object]]:
    """Keep only primary and result-source contexts accepted by the aggregator."""

    if aggregate.get("_lineage_context_rejected") is True:
        return {}
    primary_run_id = aggregate.get("run_id")
    accepted_run_ids = {primary_run_id} if isinstance(primary_run_id, str) else set()
    sources = aggregate.get("_lineage_stage_result_sources")
    if isinstance(sources, dict):
        accepted_run_ids.update(source for source in sources.values() if isinstance(source, str))
    return {
        run_id: context
        for run_id, context in candidates.items()
        if run_id in accepted_run_ids and context.get("run_id") == run_id
    }


def _has_missing_selected_stage_status(run: Run, context: dict[str, object]) -> bool:
    selected = run.configuration.selected_stage_ids if run.configuration else []
    statuses = _remote_stage_statuses(context)
    return any(stage_id not in statuses for stage_id in selected)


def _should_continue_external_sync(
    run: Run,
    context: dict[str, object],
    *,
    pending_publications: bool,
) -> bool:
    return (
        run.status not in _TERMINAL_RUN_STATUSES
        or pending_publications
        or _has_missing_selected_stage_status(run, context)
    )


def _external_run_status(
    statuses: dict[str, RunStageStatus],
    stage_ids: list[str],
    remote_status: str | None = None,
) -> str:
    if not stage_ids or any(stage_id not in statuses for stage_id in stage_ids):
        values = [statuses[stage_id] for stage_id in stage_ids if stage_id in statuses]
        computed = (
            RunStatus.RUNNING
            if any(value in {RunStageStatus.QUEUED, RunStageStatus.RUNNING} for value in values)
            else RunStatus.PENDING
        )
    else:
        values = [statuses[stage_id] for stage_id in stage_ids]
        if RunStageStatus.FAILED in values:
            computed = RunStatus.FAILED
        elif RunStageStatus.CANCELLED in values:
            computed = (
                RunStatus.CANCELLED
                if all(value in _DONE_STAGE_STATUSES for value in values)
                else RunStatus.RUNNING
            )
        elif any(value in {RunStageStatus.QUEUED, RunStageStatus.RUNNING} for value in values):
            computed = RunStatus.RUNNING
        elif all(value in _DONE_STAGE_STATUSES for value in values):
            computed = RunStatus.SUCCESS
        elif any(value in {RunStageStatus.READY, RunStageStatus.PENDING} for value in values):
            computed = RunStatus.PENDING
        else:
            computed = RunStatus.PENDING

    if remote_status in {"running", "partial_running"}:
        return RunStatus.RUNNING
    if remote_status == "partial_failed":
        return (
            RunStatus.RUNNING
            if any(value in {RunStageStatus.QUEUED, RunStageStatus.RUNNING} for value in values)
            else RunStatus.FAILED
        )
    if remote_status == "failed":
        return RunStatus.FAILED
    if remote_status in {"cancelled", "canceled"}:
        return (
            RunStatus.CANCELLED
            if values and all(value in _DONE_STAGE_STATUSES for value in values)
            else RunStatus.RUNNING
        )
    if remote_status in {"pending", "ready", "queued"} and computed != RunStatus.RUNNING:
        return RunStatus.PENDING
    return computed


def _run_status(
    run: Run,
    statuses: dict[str, RunStageStatus],
    remote_status: str | None = None,
) -> str:
    selected = list(run.configuration.selected_stage_ids if run.configuration else [])
    return _external_run_status(statuses, selected or list(statuses), remote_status)


def _fetch_group(
    settings: Settings,
    items: list[tuple[str, str]],
    limit: int | None = None,
) -> tuple[dict[str, bytes | None], str | None]:
    """Read bounded regular files through one read-only SFTP connection."""

    max_bytes = limit or settings.mn5_max_preview_bytes
    try:
        inspector = build_read_only_inspector(settings)
        read_many = getattr(inspector, "read_many_previews", None)
        if callable(read_many):
            result = read_many([path for _, path in items], max_bytes)
        else:
            result = {path: inspector.read_preview(path, max_bytes) for _, path in items}
        return result, None
    except (InspectionError, OSError, UnicodeError, ValueError):
        logger.info("mn5_external_sync_unavailable count=%s", len(items))
        return {}, "mn5_unavailable"
    except Exception as exc:  # Keep an unexpected adapter failure from changing remote work.
        logger.warning("mn5_external_sync_error type=%s", type(exc).__name__)
        return {}, "mn5_unavailable"


def _decode_context(payload: bytes | None) -> dict[str, object] | None:
    if payload is None:
        return None
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        return None
    if not isinstance(value, dict) or not _json_depth_within_limit(value):
        return None
    return {key: item for key, item in value.items() if not key.startswith("_lineage_")}


def _json_depth_within_limit(value: object, max_depth: int = _MAX_REMOTE_JSON_DEPTH) -> bool:
    pending = [(value, 0)]
    while pending:
        current, depth = pending.pop()
        if depth > max_depth:
            return False
        if isinstance(current, dict):
            pending.extend((child, depth + 1) for child in current.values())
        elif isinstance(current, list):
            pending.extend((child, depth + 1) for child in current)
    return True


def _apply_snapshot(
    tracking: ExternalRunTracking,
    run: Run,
    context: dict[str, object],
    *,
    now: datetime,
    interval_seconds: int,
) -> None:
    remote_run_id = context.get("run_id")
    if remote_run_id != tracking.remote_run_id:
        raise ValueError("external run identity changed")
    statuses = _remote_stage_statuses(context)
    snapshot_stage_ids = _remote_stage_ids(context)
    if not snapshot_stage_ids:
        raise ValueError("external stage snapshot is empty")
    existing = {stage.stage_id: stage for stage in run.stages}
    for stage_id in snapshot_stage_ids:
        stage = existing.get(stage_id)
        if stage is None:
            stage = RunStage(stage_id=stage_id, status=RunStageStatus.PENDING)
            run.stages.append(stage)
            existing[stage_id] = stage
        status = statuses.get(stage_id)
        if status is None:
            continue
        stage.status = status
        remote_result = _remote_stage_result(context, stage_id)
        previous_cache_key = stage.cache_key
        published_cache_key = (tracking.published_cache_keys or {}).get(stage_id)
        remote_cache_key = (
            _result_cache_key(remote_result)
            if status in {RunStageStatus.SUCCESS, RunStageStatus.REUSED}
            else None
        )
        if remote_cache_key is not None:
            stage.cache_key = remote_cache_key
            if previous_cache_key != remote_cache_key:
                stage.stage_result_id = None
        elif (
            status in {RunStageStatus.SUCCESS, RunStageStatus.REUSED}
            and published_cache_key is not None
            and published_cache_key == previous_cache_key
        ):
            # A successful manifest may already have been published for this
            # exact cache key even when a later snapshot omits its result row.
            stage.cache_key = previous_cache_key
        else:
            stage.cache_key = None
            stage.stage_result_id = None
        stage.error_code = "external_stage_failed" if status == RunStageStatus.FAILED else None
        stage.error_message = None
        # No stage-level start/end times are read from the external context.
        stage.started_at = None
        stage.finished_at = None

    if run.configuration is not None:
        selected = set(run.configuration.selected_stage_ids or [])
        selected.update(snapshot_stage_ids)
        run.configuration.selected_stage_ids = [
            stage.id for stage in STAGE_DEFINITIONS if stage.id in selected
        ]

    confirmed_statuses = {
        stage.stage_id: stage.status for stage in run.stages if stage.status is not None
    }
    status = _run_status(run, confirmed_statuses, _remote_run_status(context))
    selected_ids = (run.configuration.selected_stage_ids or []) if run.configuration else []
    selected_statuses = [statuses.get(stage_id) for stage_id in selected_ids]
    snapshot_incomplete = any(item is None for item in selected_statuses)
    if snapshot_incomplete and status == RunStatus.SUCCESS:
        # Preserve each last-confirmed stage state, but do not derive a fresh
        # terminal success from cached states while the remote snapshot omits
        # a selected stage.
        status = RunStatus.PENDING
    run.status = status
    run.error_code = "external_stage_failed" if status == RunStatus.FAILED else None
    run.error_message = None
    # The snapshot does not include verified remote execution timestamps.
    run.started_at = None
    run.finished_at = None
    pending_publications = _has_pending_result_publications(tracking, run, context)
    if (
        status in {RunStatus.SUCCESS, RunStatus.FAILED, RunStatus.CANCELLED}
        and not pending_publications
    ):
        tracking.next_sync_at = None
    else:
        tracking.next_sync_at = now + timedelta(seconds=interval_seconds)
    # Prevent an incomplete snapshot from being interpreted as completed just
    # because the remote context carries a top-level success marker.
    if snapshot_incomplete:
        tracking.next_sync_at = now + timedelta(seconds=interval_seconds)
    tracking.last_synced_at = now
    tracking.last_attempt_at = now
    tracking.connection_status = "connected"
    tracking.sync_error_code = "result_publication_pending" if pending_publications else None


def _fetch_many(
    settings: Settings,
    paths: list[str],
    *,
    limit: int | None = None,
    on_progress: Callable[[], None] | None = None,
    on_group_result: Callable[[dict[str, bytes | None], set[str]], None] | None = None,
    group_size: int = 1,
) -> tuple[dict[str, bytes | None], set[str]]:
    if group_size < 1:
        raise ValueError("group_size must be positive")
    unique_paths = sorted(set(paths))
    max_bytes = limit or settings.mn5_max_preview_bytes
    if max_bytes < 1 or max_bytes > max(
        settings.mn5_max_preview_bytes, settings.mn5_max_artifact_bytes
    ):
        raise ValueError("external file read exceeds the configured bound")
    # Small context reads can share SFTP sessions. Large artifacts default to
    # one file per session so they publish independently as soon as verified.
    groups = [
        unique_paths[index : index + group_size]
        for index in range(0, len(unique_paths), group_size)
    ]
    if not groups:
        if on_progress is not None:
            on_progress()
        return {}, set()
    batch_count = min(settings.mn5_external_sync_parallelism, len(groups))
    fetched: dict[str, bytes | None] = {}
    failed: set[str] = set()
    if on_progress is not None:
        on_progress()
    with ThreadPoolExecutor(max_workers=batch_count) as pool:
        future_groups = {
            pool.submit(_fetch_group, settings, [(path, path) for path in group], max_bytes): group
            for group in groups
        }
        pending = set(future_groups)
        last_heartbeat = monotonic()
        while pending:
            completed, pending = wait(
                pending,
                timeout=_FETCH_HEARTBEAT_SECONDS,
                return_when=FIRST_COMPLETED,
            )
            if not completed:
                if on_progress is not None:
                    on_progress()
                last_heartbeat = monotonic()
                continue
            for future in completed:
                group = future_groups[future]
                try:
                    result, error = future.result()
                except Exception as exc:  # Keep one failed SFTP read isolated.
                    logger.warning("mn5_external_sync_error type=%s", type(exc).__name__)
                    failed.update(group)
                    if on_group_result is not None:
                        on_group_result({}, set(group))
                    continue
                if error:
                    failed.update(group)
                    if on_group_result is not None:
                        on_group_result({}, set(group))
                else:
                    fetched.update(result)
                    if on_group_result is not None:
                        on_group_result(result, set())
            if on_progress is not None and monotonic() - last_heartbeat >= _FETCH_HEARTBEAT_SECONDS:
                on_progress()
                last_heartbeat = monotonic()
    if on_progress is not None:
        on_progress()
    return fetched, failed


def _result_directory(
    context: dict[str, object], stage_id: str, cache_key: str, settings: Settings
) -> str:
    stage_result = _remote_stage_result(context, stage_id)
    declared = stage_result.get("result_dir") if isinstance(stage_result, dict) else None
    if isinstance(declared, str) and declared:
        path = PurePosixPath(declared)
        if path.is_absolute():
            try:
                path = path.relative_to(PurePosixPath(settings.mn5_root))
            except ValueError as exc:
                raise ValueError("external result path is outside the configured root") from exc
    else:
        path = PurePosixPath("results", stage_id, cache_key)
    path = validate_relative_path(str(path))
    remote_run_id = context.get("run_id")
    if (
        not isinstance(remote_run_id, str)
        or not remote_run_id
        or PurePosixPath(remote_run_id).name != remote_run_id
    ):
        raise ValueError("external result context has no run identity")
    run_root = validate_relative_path(f"runs/{remote_run_id}")
    shared_result_root = PurePosixPath("results", stage_id, cache_key)
    if not any(root == path or root in path.parents for root in (run_root, shared_result_root)):
        raise ValueError("external result directory is not scoped to this run or stage cache")
    return str(path)


def _manifest_path_for(
    context: dict[str, object], stage_id: str, cache_key: str, settings: Settings
) -> tuple[str, str]:
    result_dir = _result_directory(context, stage_id, cache_key, settings)
    manifest_path = str(validate_relative_path(f"{result_dir}/result_manifest.json"))
    return result_dir, manifest_path


def _manifest_artifact_path(
    path_value: str,
    *,
    external: bool,
    stage_id: str,
    cache_key: str,
    result_dir: str,
    remote_run_id: str | None = None,
    artifact_type: str | None = None,
) -> str:
    path = PurePosixPath(path_value)
    if not external:
        return str(validate_relative_path(str(PurePosixPath(result_dir) / path)))

    path = validate_relative_path(str(path))
    allowed_roots = [
        PurePosixPath(result_dir),
        PurePosixPath("results", stage_id, cache_key),
        PurePosixPath("cache", stage_id, cache_key),
    ]
    if remote_run_id is not None:
        run_root = validate_relative_path(f"runs/{remote_run_id}")
        if len(PurePosixPath(run_root).parts) != 2:
            raise ManifestError("external result has an invalid run identity")
        allowed_roots.append(PurePosixPath(run_root))
    is_shared_genomic_mapping = (
        artifact_type == "genomic_mapping"
        and len(path.parts) == 4
        and path.parts[:2] == ("cache", "genomic_mapping")
        and re.fullmatch(r"[0-9a-f]{16,64}", path.parts[2]) is not None
        and path.name == "residue_genomic_mapping.tsv"
    )
    if not is_shared_genomic_mapping and not any(root in path.parents for root in allowed_roots):
        raise ManifestError("external artifact path is outside the run or its shared stage cache")
    return str(path)


def _published_stage_jobs(
    tracking: ExternalRunTracking,
    run: Run,
    context: dict[str, object],
    settings: Settings,
    result_contexts: dict[str, dict[str, object]] | None = None,
) -> tuple[list[dict[str, str]], set[str]]:
    """Select valid pending publications and report stage-local path errors."""

    statuses = _remote_stage_statuses(context)
    published = tracking.published_cache_keys or {}
    selected = run.configuration.selected_stage_ids if run.configuration else []
    if context.get("_lineage_context_rejected") is True:
        invalid_stages = {
            stage_id
            for stage_id in selected
            if statuses.get(stage_id) in {RunStageStatus.SUCCESS, RunStageStatus.REUSED}
            and _result_cache_key(_remote_stage_result(context, stage_id)) is not None
        }
        return [], invalid_stages
    result_sources = context.get("_lineage_stage_result_sources")
    result_sources = result_sources if isinstance(result_sources, dict) else {}
    jobs: list[dict[str, str]] = []
    invalid_stages: set[str] = set()
    for stage_id in selected:
        if statuses.get(stage_id) not in {RunStageStatus.SUCCESS, RunStageStatus.REUSED}:
            continue
        result = _remote_stage_result(context, stage_id)
        cache_key = result.get("cache_key") if isinstance(result, dict) else None
        if not isinstance(cache_key, str) or not re.fullmatch(r"[0-9a-f]{64}", cache_key):
            continue
        if published.get(stage_id) == cache_key:
            continue

        result_source = result_sources.get(stage_id)
        result_run_id = result_source if isinstance(result_source, str) else context.get("run_id")
        result_context = context
        if result_run_id != context.get("run_id"):
            result_context = (result_contexts or {}).get(result_run_id)
        if (
            not isinstance(result_run_id, str)
            or not isinstance(result_context, dict)
            or result_context.get("run_id") != result_run_id
            or _result_cache_key(_remote_stage_result(result_context, stage_id)) != cache_key
        ):
            invalid_stages.add(stage_id)
            continue
        try:
            result_dir, manifest_path = _manifest_path_for(
                result_context,
                stage_id,
                cache_key,
                settings,
            )
        except (InspectionError, ValueError, RecursionError):
            invalid_stages.add(stage_id)
            continue
        jobs.append(
            {
                "tracking_id": tracking.id,
                "remote_run_id": result_run_id,
                "stage_id": stage_id,
                "cache_key": cache_key,
                "result_dir": result_dir,
                "manifest_path": manifest_path,
            }
        )
    jobs.sort(key=lambda job: _PUBLICATION_STAGE_PRIORITY.get(job["stage_id"], 3))
    return jobs, invalid_stages


def _select_publication_jobs(
    jobs: list[dict[str, str]],
    cursor: int,
    *,
    limit: int = 2,
) -> tuple[list[dict[str, str]], int]:
    """Rotate bounded publication work so a repeatedly incomplete stage cannot starve peers."""

    if not jobs:
        return [], cursor
    start = cursor % len(jobs)
    rotated = jobs[start:] + jobs[:start]
    return rotated[:limit], (start + 1) % len(jobs)


def _has_pending_result_publications(
    tracking: ExternalRunTracking,
    run: Run,
    context: dict[str, object],
) -> bool:
    statuses = _remote_stage_statuses(context)
    published = tracking.published_cache_keys or {}
    selected = run.configuration.selected_stage_ids if run.configuration else []
    for stage_id in selected:
        if statuses.get(stage_id) not in {RunStageStatus.SUCCESS, RunStageStatus.REUSED}:
            continue
        result = _remote_stage_result(context, stage_id)
        cache_key = result.get("cache_key") if isinstance(result, dict) else None
        if not isinstance(cache_key, str) or not re.fullmatch(r"[0-9a-f]{64}", cache_key):
            return True
        if published.get(stage_id) != cache_key:
            return True
    return False


def _manifest_artifact_specs(
    manifest: dict[str, object],
    *,
    stage_id: str,
    cache_key: str,
    result_dir: str,
    settings: Settings,
    remote_run_id: str | None = None,
) -> tuple[list[dict[str, object]], bool]:
    normalized = normalize_remote_manifest_paths(manifest, settings.mn5_root)
    validate_remote_manifest(
        normalized,
        stage_id,
        annotations_required=bool(STAGE_BY_ID[stage_id].produced_annotations),
        allow_partial=True,
    )
    if normalized.get("cache_key") != cache_key:
        raise ManifestError("result manifest cache key changed")
    raw_artifacts = normalized.get("artifacts")
    integrity = normalized.get("file_integrity")
    if not isinstance(raw_artifacts, dict) or not isinstance(integrity, dict):
        raise ManifestError("result manifest artifact metadata is incomplete")

    specs: list[dict[str, object]] = []
    definition = STAGE_BY_ID[stage_id]
    allowed_artifacts = {
        str(artifact_type)
        for artifact_type in (*definition.produced_artifacts, *definition.optional_artifacts)
    }
    if stage_id == "protein_relaxation_energy":
        allowed_artifacts.update(_EXTERNAL_RESULT_ARTIFACTS)
    if "annotations" in raw_artifacts:
        raise ManifestError("annotations must use the separate manifest annotations field")
    wrong_stage_artifacts = (_KNOWN_STAGE_ARTIFACTS.intersection(raw_artifacts)) - allowed_artifacts
    if wrong_stage_artifacts:
        raise ManifestError("remote manifest contains artifacts assigned to another stage")

    required_artifacts = set(definition.produced_artifacts)
    complete = manifest.get("partial") is not True and required_artifacts.issubset(raw_artifacts)
    stage_artifacts = allowed_artifacts - _NON_FILE_RESULT_ARTIFACTS
    if stage_id == "variant_ddg" and not {"variant_annotations", "ddg_replicates"}.issubset(
        raw_artifacts
    ):
        complete = False

    for artifact_type in sorted(stage_artifacts.intersection(raw_artifacts)):
        entry = raw_artifacts[artifact_type]
        required = artifact_type in required_artifacts
        if not isinstance(entry, dict):
            complete = complete and not required
            continue
        size = entry.get("size")
        sha256 = entry.get("sha256")
        relative = entry.get("path")
        has_manifest_digest = isinstance(sha256, str) and re.fullmatch(r"[0-9a-f]{64}", sha256)
        is_bounded_unhashed_file = (
            sha256 is None
            and isinstance(size, int)
            and not isinstance(size, bool)
            and size > REMOTE_HASH_MAX_BYTES
        )
        if (
            isinstance(size, bool)
            or not isinstance(size, int)
            or size < 0
            or not (has_manifest_digest or is_bounded_unhashed_file)
            or not isinstance(relative, str)
        ):
            complete = complete and not required
            continue
        remote_path = _manifest_artifact_path(
            relative,
            external=entry.get("external") is True,
            stage_id=stage_id,
            cache_key=cache_key,
            result_dir=result_dir,
            remote_run_id=remote_run_id,
            artifact_type=artifact_type,
        )
        if size > settings.mn5_max_artifact_bytes:
            complete = complete and not required
            continue
        specs.append(
            {
                "artifact_type": artifact_type,
                "remote_path": remote_path,
                "size": size,
                "sha256": sha256 if has_manifest_digest else None,
            }
        )

    annotations_path = normalized.get("annotations")
    annotation_record = integrity.get("annotations")
    if annotations_path is not None:
        if (
            isinstance(annotation_record, dict)
            and isinstance(annotation_record.get("size"), int)
            and not isinstance(annotation_record.get("size"), bool)
            and isinstance(annotation_record.get("sha256"), str)
            and re.fullmatch(r"[0-9a-f]{64}", annotation_record["sha256"])
            and isinstance(annotations_path, str)
        ):
            annotation_path = str(
                validate_relative_path(str(PurePosixPath(result_dir) / annotations_path))
            )
            annotation_size = annotation_record["size"]
            if annotation_size <= settings.mn5_max_artifact_bytes:
                specs.append(
                    {
                        "artifact_type": "annotations",
                        "remote_path": annotation_path,
                        "size": annotation_size,
                        "sha256": annotation_record["sha256"],
                    }
                )
            else:
                complete = False
        else:
            complete = False
    return specs, complete


def _storage_key(
    protein_id: str,
    stage_id: str,
    cache_key: str,
    artifact_type: str,
    filename: str,
) -> str:
    return "/".join(
        (
            "external",
            "mn5",
            protein_id,
            stage_id,
            cache_key,
            artifact_type,
            filename,
        )
    )


def _artifact_media_type(filename: str) -> str:
    normalized = filename.lower()
    if normalized.endswith((".gz", ".gzip")):
        return "application/gzip"
    if normalized.endswith(".tsv"):
        return "text/tab-separated-values"
    return mimetypes.guess_type(filename)[0] or "application/octet-stream"


def _ensure_stage_result(
    session: Session,
    run: Run,
    tracking: ExternalRunTracking,
    stage_id: str,
    cache_key: str,
    source_remote_run_id: str | None = None,
) -> StageResult | None:
    stage = next((item for item in run.stages if item.stage_id == stage_id), None)
    if stage is None:
        return None
    result = session.scalar(
        select(StageResult).where(
            StageResult.protein_id == run.protein_id,
            StageResult.stage_id == stage_id,
            StageResult.cache_key == cache_key,
            StageResult.project_id == run.project_id,
        )
    )
    if result is None:
        result = StageResult(
            protein_id=run.protein_id,
            stage_id=stage_id,
            cache_key=cache_key,
            status=RunStageStatus.SUCCESS,
            provenance={
                "source": "MN5",
                "external_run_id": source_remote_run_id or tracking.remote_run_id,
            },
            owner_id=run.owner_id,
            project_id=run.project_id,
            published_at=_now(),
        )
        session.flush()
        try:
            with session.begin_nested():
                session.add(result)
                session.flush()
        except IntegrityError:
            result = session.scalar(
                select(StageResult).where(
                    StageResult.protein_id == run.protein_id,
                    StageResult.stage_id == stage_id,
                    StageResult.cache_key == cache_key,
                    StageResult.project_id == run.project_id,
                )
            )
            if result is None:
                raise
    if result is None:
        return None
    stage.cache_key = cache_key
    stage.stage_result_id = result.id
    if stage.status not in {RunStageStatus.SUCCESS, RunStageStatus.REUSED}:
        stage.status = RunStageStatus.SUCCESS
    return result


def _restore_published_stage_result_references(
    session: Session,
    run: Run,
    tracking: ExternalRunTracking,
    context: dict[str, object],
) -> None:
    """Reattach stage results whose verified external cache keys were published."""

    published = tracking.published_cache_keys or {}
    for stage in run.stages:
        if stage.status not in {RunStageStatus.SUCCESS, RunStageStatus.REUSED}:
            continue
        cache_key = published.get(stage.stage_id)
        if not isinstance(cache_key, str) or not re.fullmatch(r"[0-9a-f]{64}", cache_key):
            continue
        remote_cache_key = _result_cache_key(_remote_stage_result(context, stage.stage_id))
        if remote_cache_key != cache_key or stage.cache_key != cache_key:
            continue
        if stage.stage_result_id is not None:
            if stage.stage_result_id == session.scalar(
                select(StageResult.id).where(
                    StageResult.id == stage.stage_result_id,
                    StageResult.protein_id == run.protein_id,
                    StageResult.stage_id == stage.stage_id,
                    StageResult.cache_key == cache_key,
                    StageResult.project_id == run.project_id,
                )
            ):
                continue
            stage.stage_result_id = None
        result_id = session.scalar(
            select(StageResult.id).where(
                StageResult.protein_id == run.protein_id,
                StageResult.stage_id == stage.stage_id,
                StageResult.cache_key == cache_key,
                StageResult.project_id == run.project_id,
            )
        )
        if result_id is not None:
            stage.stage_result_id = result_id


def _persist_artifact(
    session: Session,
    store: ArtifactStore,
    run: Run,
    *,
    stage_result: StageResult,
    stage_id: str,
    cache_key: str,
    spec: dict[str, object],
    payload: bytes,
) -> bool:
    size = spec["size"]
    digest = spec["sha256"]
    artifact_type = spec["artifact_type"]
    remote_path = spec["remote_path"]
    actual_digest = hashlib.sha256(payload).hexdigest()
    if (
        not isinstance(size, int)
        or (digest is not None and not isinstance(digest, str))
        or not isinstance(artifact_type, str)
        or not isinstance(remote_path, str)
        or len(payload) != size
        or (isinstance(digest, str) and actual_digest != digest)
    ):
        return False
    digest = actual_digest
    filename = PurePosixPath(remote_path).name
    media_type = _artifact_media_type(filename)
    storage_key = _storage_key(run.protein_id, stage_id, cache_key, artifact_type, filename)
    existing = session.scalar(select(Artifact).where(Artifact.storage_key == storage_key))
    if existing is not None:
        if (
            existing.stage_result_id != stage_result.id
            or existing.run_id is not None
            or existing.size != size
            or existing.sha256 != digest
        ):
            return False
    try:
        destination = store.resolve(storage_key)
    except (ArtifactPathError, OSError):
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        try:
            current_size, current_digest = store.metadata(storage_key)
        except (ArtifactPathError, OSError):
            return False
        if (current_size, current_digest) == (size, digest):
            if existing is not None:
                existing.media_type = media_type
                return True
            return _attach_stage_artifact(
                session,
                stage_result,
                storage_key=storage_key,
                artifact_type=artifact_type,
                filename=filename,
                size=size,
                digest=digest,
            )
        if existing is None:
            return False
    descriptor, temporary_name = tempfile.mkstemp(prefix=".mn5-external-", dir=destination.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o660)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        if existing is None:
            # A stage cache can be published by several imported runs at once.
            # Link the fully written temporary file into place without replacing
            # a blob another tracker may have just published for this key.
            try:
                os.link(temporary, destination)
            except FileExistsError:
                try:
                    current_size, current_digest = store.metadata(storage_key)
                except (ArtifactPathError, OSError):
                    return False
                if (current_size, current_digest) != (size, digest):
                    return False
            finally:
                temporary.unlink(missing_ok=True)
        else:
            # An existing database row fixes the expected digest, so repairing
            # its corrupt or missing blob can safely use an atomic replacement.
            os.replace(temporary, destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    if existing is not None:
        existing.media_type = media_type
        return True
    return _attach_stage_artifact(
        session,
        stage_result,
        storage_key=storage_key,
        artifact_type=artifact_type,
        filename=filename,
        size=size,
        digest=digest,
    )


def _attach_stage_artifact(
    session: Session,
    stage_result: StageResult,
    *,
    storage_key: str,
    artifact_type: str,
    filename: str,
    size: int,
    digest: str,
) -> bool:
    media_type = _artifact_media_type(filename)
    artifact = Artifact(
        stage_result_id=stage_result.id,
        artifact_type=artifact_type,
        storage_backend="filesystem",
        storage_key=storage_key,
        sha256=digest,
        size=size,
        media_type=media_type,
    )
    try:
        with session.begin_nested():
            session.add(artifact)
            session.flush()
    except IntegrityError:
        existing = session.scalar(select(Artifact).where(Artifact.storage_key == storage_key))
        if (
            existing is None
            or existing.stage_result_id != stage_result.id
            or existing.run_id is not None
            or existing.size != size
            or existing.sha256 != digest
        ):
            raise
        existing.media_type = media_type
        if existing not in stage_result.artifacts:
            stage_result.artifacts.append(existing)
        return True
    stage_result.artifacts.append(artifact)
    return True


def _insert_verified_annotations(
    session: Session,
    run: Run,
    tracking: ExternalRunTracking,
    stage_result: StageResult,
    stage_id: str,
    payload: bytes,
    reference_sequence: str | None = None,
) -> bool:
    definition = STAGE_BY_ID[stage_id]
    expected_mutation: tuple[int, str, str] | None = None
    sequence = run.protein.sequence
    reference = reference_sequence.strip().upper() if reference_sequence else None
    position_offset = 0
    if reference is not None and tracking.run_type == "base":
        base_protein = session.get(Protein, tracking.base_protein_id)
        if (
            base_protein is None
            or base_protein.sequence != reference
            or not re.fullmatch(r"[ACDEFGHIKLMNPQRSTVWY]+", reference)
        ):
            return False
        first_offset = reference.find(sequence)
        if first_offset < 0 or reference.find(sequence, first_offset + 1) >= 0:
            return False
        position_offset = first_offset
    if tracking.run_type == "mutant" and tracking.variant:
        variant_match = _VARIANT_LABEL.fullmatch(tracking.variant)
        base_protein = session.get(Protein, tracking.base_protein_id)
        if variant_match is not None and base_protein is not None:
            variant_position = int(variant_match.group("position"))
            variant_ref = variant_match.group("ref")
            variant_alt = variant_match.group("alt")
            base_sequence = base_protein.sequence
            if (
                len(base_sequence) == len(sequence)
                and 1 <= variant_position <= len(sequence)
                and base_sequence[variant_position - 1] == variant_ref
                and sequence[variant_position - 1] == variant_alt
                and all(
                    base_aa == run_aa
                    for position, (base_aa, run_aa) in enumerate(
                        zip(base_sequence, sequence, strict=True), start=1
                    )
                    if position != variant_position
                )
            ):
                expected_mutation = (variant_position, variant_ref, variant_alt)
    try:
        reader = csv.DictReader(io.StringIO(payload.decode("utf-8")), delimiter="\t")
        fieldnames = set(reader.fieldnames or [])
        if not _CANONICAL_ANNOTATION_FIELDS.issubset(fieldnames):
            return False
        if not set(definition.produced_annotations).issubset(fieldnames):
            return False
        accepted_ids = {run.protein_id, tracking.accession}
        positions: set[int] = set()
        source_positions: set[int] = set()
        rows: list[dict[str, object]] = []
        source_rows_seen = False
        for source_row in reader:
            if not source_row or all(value in {None, ""} for value in source_row.values()):
                continue
            if str(source_row.get("protein_id", "")).strip() not in accepted_ids:
                return False
            try:
                source_position = int(str(source_row.get("aa_position", "")))
            except ValueError:
                return False
            aa_ref = str(source_row.get("aa_ref", "")).strip().upper()
            if len(aa_ref) != 1 or source_position in source_positions:
                return False
            source_positions.add(source_position)
            position = source_position - position_offset
            if reference is not None and tracking.run_type == "base":
                if (
                    source_position < 1
                    or source_position > len(reference)
                    or reference[source_position - 1] != aa_ref
                ):
                    return False
                source_rows_seen = True
                if position < 1 or position > len(sequence):
                    # The source is on the canonical axis; residues outside the
                    # submitted sequence have no query position to annotate.
                    continue
            if (
                position < 1
                or position > len(sequence)
                or len(aa_ref) != 1
                or position in positions
            ):
                return False
            if sequence[position - 1] != aa_ref:
                if (
                    expected_mutation is None
                    or position != expected_mutation[0]
                    or aa_ref != expected_mutation[1]
                ):
                    return False
                # Upstream identity and UniProt evidence use the canonical reference residue.
                # Store it against the validated mutant sequence position for viewer alignment.
                aa_ref = expected_mutation[2]
            source_rows_seen = True
            positions.add(position)
            values = {
                key: str(value)
                for key, value in source_row.items()
                if key not in _CANONICAL_ANNOTATION_FIELDS and value not in {None, ""}
            }
            rows.append(
                {
                    "aa_position": position,
                    "aa_ref": aa_ref,
                    "values": values,
                    "units": {},
                    "qc_status": "verified",
                    "source_row": "\t".join(
                        str(source_row.get(field, "")) for field in reader.fieldnames or []
                    ),
                }
            )
    except (UnicodeDecodeError, csv.Error):
        return False
    if not rows and (reference is None or tracking.run_type != "base" or not source_rows_seen):
        return False
    table = ANNOTATION_TABLES[stage_id]
    existing_rows = session.execute(
        select(
            table.c.aa_position,
            table.c.aa_ref,
            table.c["values"],
            table.c.units,
            table.c.qc_status,
            table.c.source_row,
        )
        .where(table.c.stage_result_id == stage_result.id)
        .order_by(table.c.aa_position)
    ).all()
    existing = [
        (
            row.aa_position,
            row.aa_ref,
            row._mapping["values"],
            row.units,
            row.qc_status,
            row.source_row,
        )
        for row in existing_rows
    ]
    desired = [
        (
            row["aa_position"],
            row["aa_ref"],
            row.get("values", {}),
            row.get("units", {}),
            row.get("qc_status", "unverified"),
            row.get("source_row"),
        )
        for row in sorted(rows, key=lambda item: int(str(item["aa_position"])))
    ]
    if existing != desired:
        session.execute(table.delete().where(table.c.stage_result_id == stage_result.id))
        if rows:
            insert_annotation_rows(session, stage_id, stage_result.id, rows)
    return True


def _persist_verified_external_artifact(
    session: Session,
    store: ArtifactStore,
    run: Run,
    tracking: ExternalRunTracking,
    *,
    stage_result: StageResult,
    stage_id: str,
    cache_key: str,
    spec: dict[str, object],
    payload: bytes,
    reference_sequence: str | None = None,
) -> bool:
    """Validate scientific TSV semantics before publishing a downloadable file."""

    size = spec.get("size")
    digest = spec.get("sha256")
    has_verified_manifest_digest = (
        isinstance(digest, str)
        and len(digest) == 64
        and re.fullmatch(r"[0-9a-f]{64}", digest) is not None
    )
    allows_bounded_unhashed_artifact = (
        digest is None
        and isinstance(size, int)
        and not isinstance(size, bool)
        and size > REMOTE_HASH_MAX_BYTES
    )
    if (
        not isinstance(size, int)
        or isinstance(size, bool)
        or not (has_verified_manifest_digest or allows_bounded_unhashed_artifact)
        or len(payload) != size
        or (has_verified_manifest_digest and hashlib.sha256(payload).hexdigest() != digest)
    ):
        return False
    artifact_type = spec.get("artifact_type")
    if artifact_type == "variant_annotations" and not _verify_ddg_variant_export(tracking, payload):
        return False
    if artifact_type == "annotations" and not _insert_verified_annotations(
        session,
        run,
        tracking,
        stage_result,
        stage_id,
        payload,
        reference_sequence=reference_sequence,
    ):
        return False
    return _persist_artifact(
        session,
        store,
        run,
        stage_result=stage_result,
        stage_id=stage_id,
        cache_key=cache_key,
        spec=spec,
        payload=payload,
    )


def _verify_ddg_variant_export(
    tracking: ExternalRunTracking,
    payload: bytes,
) -> bool:
    if tracking.run_type != "ddg":
        return True
    match = _VARIANT_LABEL.fullmatch(tracking.variant or "")
    if match is None:
        return False
    try:
        reader = csv.DictReader(io.StringIO(payload.decode("utf-8")), delimiter="\t")
        if not {"protein_id", "aa_position", "aa_ref", "aa_alt", "ddg_value"}.issubset(
            reader.fieldnames or []
        ):
            return False
        rows = list(reader)
        if len(rows) != 1:
            return False
        row = rows[0]
        ddg_value = float(str(row.get("ddg_value", "")).strip())
        return (
            str(row.get("protein_id", "")).strip() == tracking.accession
            and int(str(row.get("aa_position", ""))) == int(match.group("position"))
            and str(row.get("aa_ref", "")).strip().upper() == match.group("ref")
            and str(row.get("aa_alt", "")).strip().upper() == match.group("alt")
            and math.isfinite(ddg_value)
        )
    except (UnicodeDecodeError, csv.Error, TypeError, ValueError):
        return False


def _load_claimed_tracking(
    session: Session,
    tracking_id: str,
    claim_token: str,
) -> ExternalRunTracking | None:
    """Lock and refresh only a row still owned by this worker's claim token."""

    return session.scalar(
        select(ExternalRunTracking)
        .options(
            selectinload(ExternalRunTracking.run).selectinload(Run.configuration),
            selectinload(ExternalRunTracking.run).selectinload(Run.stages),
            selectinload(ExternalRunTracking.run).selectinload(Run.run_artifacts),
            selectinload(ExternalRunTracking.run).selectinload(Run.protein),
        )
        .where(
            ExternalRunTracking.id == tracking_id,
            ExternalRunTracking.claim_token == claim_token,
            ExternalRunTracking.claim_expires_at > _now(),
        )
        .with_for_update(skip_locked=True)
        .execution_options(populate_existing=True)
    )


def _load_claimed_tracking_batch(
    session: Session,
    tracking_ids: list[str],
    claim_token: str,
) -> dict[str, ExternalRunTracking]:
    """Lock one SFTP context group and load only stage-sync relationships."""

    if not tracking_ids:
        return {}
    now = _now()
    rows = session.scalars(
        select(ExternalRunTracking)
        .options(
            selectinload(ExternalRunTracking.run).selectinload(Run.configuration),
            selectinload(ExternalRunTracking.run).selectinload(Run.stages),
        )
        .where(
            ExternalRunTracking.id.in_(tracking_ids),
            ExternalRunTracking.claim_token == claim_token,
            ExternalRunTracking.claim_expires_at > now,
        )
        .with_for_update(skip_locked=True)
        .execution_options(populate_existing=True)
    )
    return {row.id: row for row in rows}


def _renew_tracking_claims(
    session: Session,
    tracking_ids: list[str],
    claim_token: str,
    lease_seconds: int,
) -> int:
    """Extend only unexpired tracking claims still owned by this sync cycle."""

    now = _now()
    result = session.execute(
        update(ExternalRunTracking)
        .where(
            ExternalRunTracking.id.in_(tracking_ids),
            ExternalRunTracking.claim_token == claim_token,
            ExternalRunTracking.claim_expires_at > now,
        )
        .values(claim_expires_at=now + timedelta(seconds=lease_seconds))
        .execution_options(synchronize_session=False)
    )
    session.commit()
    return result.rowcount or 0


def sync_due_external_snapshots(session: Session, settings: Settings) -> int:
    """Refresh remote stage states without waiting for result artifact downloads."""

    now = _now()
    interval_seconds = settings.mn5_external_sync_interval_seconds
    token = str(uuid4())
    claimed = list(
        session.scalars(
            select(ExternalRunTracking)
            .join(Run, Run.id == ExternalRunTracking.run_id)
            .options(
                selectinload(ExternalRunTracking.run).selectinload(Run.configuration),
                selectinload(ExternalRunTracking.run).selectinload(Run.stages),
            )
            .where(Run.is_external_import.is_(True))
            .where(
                or_(
                    Run.status.in_([RunStatus.PENDING, RunStatus.RUNNING]),
                    ExternalRunTracking.next_sync_at.is_not(None),
                )
            )
            .where(
                or_(
                    ExternalRunTracking.next_sync_at.is_(None),
                    ExternalRunTracking.next_sync_at <= now,
                )
            )
            .where(
                or_(
                    ExternalRunTracking.last_attempt_at.is_(None),
                    ExternalRunTracking.last_attempt_at
                    <= now - timedelta(seconds=interval_seconds),
                )
            )
            .where(
                or_(
                    ExternalRunTracking.claim_token.is_(None),
                    ExternalRunTracking.claim_expires_at.is_(None),
                    ExternalRunTracking.claim_expires_at < now,
                )
            )
            .order_by(
                ExternalRunTracking.last_attempt_at,
                ExternalRunTracking.next_sync_at,
                ExternalRunTracking.id,
            )
            .limit(settings.mn5_external_sync_batch_size)
            .with_for_update(skip_locked=True)
        )
    )
    if not claimed:
        return 0

    lease_seconds = max(60, interval_seconds * 4)
    lease = now + timedelta(seconds=lease_seconds)
    for tracking in claimed:
        tracking.claim_token = token
        tracking.claim_expires_at = lease
    session.commit()

    tracking_ids = [tracking.id for tracking in claimed]

    def renew_claims() -> None:
        _renew_tracking_claims(session, tracking_ids, token, lease_seconds)

    context_paths = {
        f"{tracking.remote_path}/run_context.json": tracking.id for tracking in claimed
    }
    processed: set[str] = set()

    def apply_contexts(
        fetched: dict[str, bytes | None],
        failed: set[str],
        lineage_contexts: dict[str, dict[str, object]],
        lineage_result_contexts: dict[str, dict[str, dict[str, object]]],
    ) -> None:
        snapshot_now = _now()
        paths = sorted(path for path in set(fetched) | failed if path in context_paths)
        group_tracking_ids = sorted({context_paths[path] for path in paths})
        current_by_id = _load_claimed_tracking_batch(
            session,
            list(group_tracking_ids),
            token,
        )
        for path in paths:
            tracking_id = context_paths[path]
            current = current_by_id.get(tracking_id)
            if current is None:
                continue
            current.last_attempt_at = snapshot_now
            error_code: str | None = None
            pending_publications = False
            context = None if path in failed else lineage_contexts.get(tracking_id)
            if context is None and path not in failed:
                context = _decode_context(fetched.get(path))
            if path in failed:
                error_code = "mn5_unavailable"
            elif context is None or context.get("run_id") != current.remote_run_id:
                error_code = "snapshot_unavailable"
            else:
                try:
                    _apply_snapshot(
                        current,
                        current.run,
                        context,
                        now=snapshot_now,
                        interval_seconds=interval_seconds,
                    )
                    _restore_published_stage_result_references(
                        session,
                        current.run,
                        current,
                        context,
                    )
                except (InspectionError, RecursionError, ValueError):
                    error_code = "snapshot_invalid"
                else:
                    try:
                        jobs, invalid_stages = _published_stage_jobs(
                            current,
                            current.run,
                            context,
                            settings,
                            result_contexts=lineage_result_contexts.get(tracking_id),
                        )
                    except (InspectionError, RecursionError, ValueError):
                        # A bad result path does not invalidate a valid stage
                        # snapshot; keep the last remote state visible and
                        # retry result publication independently.
                        jobs = []
                        invalid_stages = {"publication"}
                    pending_publications = (
                        _has_pending_result_publications(
                            current,
                            current.run,
                            context,
                        )
                        or bool(jobs)
                        or bool(invalid_stages)
                    )
                    if _should_continue_external_sync(
                        current.run,
                        context,
                        pending_publications=pending_publications,
                    ):
                        # Advance the shared due time after a snapshot. Keeping
                        # an expired publication timestamp here would pin this
                        # row at the front of the publication queue.
                        current.next_sync_at = snapshot_now + timedelta(seconds=interval_seconds)
                    else:
                        current.next_sync_at = None
                    current.connection_status = "connected"
                    current.sync_error_code = (
                        "result_publication_pending" if pending_publications else None
                    )

            if error_code is not None:
                current.connection_status = "unavailable"
                current.sync_error_code = error_code
                if current.next_sync_at is None and current.run.status in {
                    RunStatus.PENDING,
                    RunStatus.RUNNING,
                }:
                    current.next_sync_at = snapshot_now + timedelta(seconds=interval_seconds)
            current.claim_token = None
            current.claim_expires_at = None
            processed.add(tracking_id)
        session.commit()

    lineage_context_paths = _discover_lineage_context_paths(settings, claimed)
    fetch_paths = set(context_paths)
    for paths in lineage_context_paths.values():
        fetch_paths.update(paths)
    fetched, failed = _fetch_many(
        settings,
        sorted(fetch_paths),
        on_progress=renew_claims,
        group_size=_LINEAGE_CONTEXT_FETCH_GROUP_SIZE,
    )
    lineage_contexts: dict[str, dict[str, object]] = {}
    lineage_result_contexts: dict[str, dict[str, dict[str, object]]] = {}
    for tracking in claimed:
        primary_path = next(
            (path for path, tracking_id in context_paths.items() if tracking_id == tracking.id),
            None,
        )
        if primary_path is None or primary_path in failed:
            continue
        primary = _decode_context(fetched.get(primary_path))
        if primary is None or primary.get("run_id") != tracking.remote_run_id:
            continue
        siblings: list[dict[str, object]] = []
        for path in lineage_context_paths.get(tracking.id, []):
            if path == primary_path or path in failed:
                continue
            context = _decode_context(fetched.get(path))
            expected_run_id = PurePosixPath(path).parent.name
            if context is not None and context.get("run_id") == expected_run_id:
                siblings.append(context)
        candidates = {
            context["run_id"]: context
            for context in (primary, *siblings)
            if isinstance(context.get("run_id"), str)
        }
        aggregate = _aggregate_lineage_snapshot(
            tracking,
            primary,
            siblings,
        )
        lineage_contexts[tracking.id] = aggregate
        lineage_result_contexts[tracking.id] = _verified_lineage_result_contexts(
            aggregate,
            candidates,
        )
    apply_contexts(fetched, failed, lineage_contexts, lineage_result_contexts)

    # Keep the lease tidy if a transport adapter returns an incomplete result
    # without invoking the per-group callback for every requested path.
    for tracking_id in sorted(set(tracking_ids) - processed):
        current = _load_claimed_tracking(session, tracking_id, token)
        if current is None:
            continue
        current.last_attempt_at = _now()
        current.connection_status = "unavailable"
        current.sync_error_code = "snapshot_unavailable"
        if current.next_sync_at is None and current.run.status in {
            RunStatus.PENDING,
            RunStatus.RUNNING,
        }:
            current.next_sync_at = _now() + timedelta(seconds=interval_seconds)
        current.claim_token = None
        current.claim_expires_at = None
    session.commit()
    return len(claimed)


def sync_due_external_runs(session: Session, settings: Settings) -> int:
    """Synchronize external stage states and verified partial publications."""

    now = _now()
    token = str(uuid4())
    claimed = list(
        session.scalars(
            select(ExternalRunTracking)
            .join(Run, Run.id == ExternalRunTracking.run_id)
            .options(
                selectinload(ExternalRunTracking.run).selectinload(Run.configuration),
                selectinload(ExternalRunTracking.run).selectinload(Run.stages),
                selectinload(ExternalRunTracking.run).selectinload(Run.run_artifacts),
                selectinload(ExternalRunTracking.run).selectinload(Run.protein),
            )
            .where(Run.is_external_import.is_(True))
            .where(
                or_(
                    Run.status.in_([RunStatus.PENDING, RunStatus.RUNNING]),
                    ExternalRunTracking.next_sync_at.is_not(None),
                )
            )
            .where(
                or_(
                    ExternalRunTracking.next_sync_at.is_(None),
                    ExternalRunTracking.next_sync_at <= now,
                )
            )
            .where(
                or_(
                    ExternalRunTracking.claim_token.is_(None),
                    ExternalRunTracking.claim_expires_at.is_(None),
                    ExternalRunTracking.claim_expires_at < now,
                )
            )
            .order_by(ExternalRunTracking.next_sync_at, ExternalRunTracking.id)
            .limit(settings.mn5_external_sync_batch_size)
            .with_for_update(skip_locked=True)
        )
    )
    if not claimed:
        return 0
    lease = now + timedelta(seconds=max(60, settings.mn5_external_sync_interval_seconds * 4))
    for tracking in claimed:
        tracking.claim_token = token
        tracking.claim_expires_at = lease
        tracking.next_sync_at = now + timedelta(seconds=settings.mn5_external_sync_interval_seconds)
    session.commit()
    tracking_ids = [tracking.id for tracking in claimed]
    lease_seconds = max(60, settings.mn5_external_sync_interval_seconds * 4)

    def renew_claims() -> None:
        _renew_tracking_claims(session, tracking_ids, token, lease_seconds)

    context_paths = {
        tracking.id: f"{tracking.remote_path}/run_context.json" for tracking in claimed
    }
    lineage_context_paths = _discover_lineage_context_paths(settings, claimed)
    fetch_paths = {path for path in context_paths.values()}
    for paths in lineage_context_paths.values():
        fetch_paths.update(paths)
    contexts_fetched, context_failures = _fetch_many(
        settings,
        sorted(fetch_paths),
        on_progress=renew_claims,
        group_size=_LINEAGE_CONTEXT_FETCH_GROUP_SIZE,
    )
    contexts: dict[str, dict[str, object]] = {}
    snapshot_contexts: dict[str, dict[str, object]] = {}
    manifest_jobs: list[dict[str, str]] = []
    result_contexts_by_tracking: dict[str, dict[str, dict[str, object]]] = {}
    invalid_contexts: set[str] = set()
    invalid_publications: set[str] = set()
    publication_cursors: dict[str, int] = {}
    for tracking in claimed:
        path = context_paths[tracking.id]
        if path in context_failures:
            continue
        context = _decode_context(contexts_fetched.get(path))
        if context is None or context.get("run_id") != tracking.remote_run_id:
            invalid_contexts.add(tracking.id)
            continue
        contexts[tracking.id] = context
        sibling_contexts: list[dict[str, object]] = []
        for sibling_path in lineage_context_paths.get(tracking.id, []):
            if sibling_path == path or sibling_path in context_failures:
                continue
            sibling = _decode_context(contexts_fetched.get(sibling_path))
            expected_run_id = PurePosixPath(sibling_path).parent.name
            if sibling is not None and sibling.get("run_id") == expected_run_id:
                sibling_contexts.append(sibling)
        candidates = {
            candidate["run_id"]: candidate
            for candidate in (context, *sibling_contexts)
            if isinstance(candidate.get("run_id"), str)
        }
        snapshot_contexts[tracking.id] = _aggregate_lineage_snapshot(
            tracking,
            context,
            sibling_contexts,
        )
        result_contexts_by_tracking[tracking.id] = _verified_lineage_result_contexts(
            snapshot_contexts[tracking.id],
            candidates,
        )
        try:
            jobs, invalid_stages = _published_stage_jobs(
                tracking,
                tracking.run,
                snapshot_contexts[tracking.id],
                settings,
                result_contexts=result_contexts_by_tracking[tracking.id],
            )
        except (InspectionError, ValueError, RecursionError):
            invalid_publications.add(tracking.id)
            continue
        if invalid_stages:
            invalid_publications.add(tracking.id)
        # Publish the structural preview first, then the DDG result. Limiting
        # each run to two stages keeps one slow publication from delaying the
        # entire campaign's stage snapshots and PDB previews. The persisted
        # cursor rotates the window when an earlier publication is incomplete.
        selected_jobs, next_cursor = _select_publication_jobs(
            jobs,
            tracking.publication_cursor,
        )
        if selected_jobs:
            publication_cursors[tracking.id] = next_cursor
        manifest_jobs.extend(selected_jobs)

    # Persist stage progress as soon as the remote contexts are available.
    # Manifest and artifact reads can take minutes for a large campaign; a
    # worker restart during those reads must not hide already-confirmed stages.
    snapshot_now = _now()
    for tracking in claimed:
        if tracking.id not in contexts or tracking.id in invalid_contexts:
            continue
        current = _load_claimed_tracking(session, tracking.id, token)
        if current is None:
            continue
        try:
            _apply_snapshot(
                current,
                current.run,
                snapshot_contexts[tracking.id],
                now=snapshot_now,
                interval_seconds=settings.mn5_external_sync_interval_seconds,
            )
            _restore_published_stage_result_references(
                session,
                current.run,
                current,
                snapshot_contexts[tracking.id],
            )
            if tracking.id in publication_cursors:
                current.publication_cursor = publication_cursors[tracking.id]
        except ValueError:
            invalid_contexts.add(tracking.id)
    session.commit()

    manifest_paths = [job["manifest_path"] for job in manifest_jobs]
    manifests_fetched, manifest_failures = _fetch_many(
        settings,
        manifest_paths,
        on_progress=renew_claims,
        group_size=_MANIFEST_FETCH_GROUP_SIZE,
    )
    manifest_specs: dict[tuple[str, str, str], list[dict[str, object]]] = {}
    manifest_complete: dict[tuple[str, str, str], bool] = {}
    artifact_paths: list[str] = []
    artifact_targets: dict[
        str,
        list[tuple[str, str, str, str, dict[str, object]]],
    ] = {}
    for job in manifest_jobs:
        key = (job["tracking_id"], job["stage_id"], job["cache_key"])
        manifest_path = job["manifest_path"]
        if manifest_path in manifest_failures:
            manifest_complete[key] = False
            continue
        payload = manifests_fetched.get(manifest_path)
        try:
            manifest = json.loads(payload) if payload is not None else None
            if not isinstance(manifest, dict) or not _json_depth_within_limit(manifest):
                raise ManifestError("result manifest is unavailable")
            specs, complete = _manifest_artifact_specs(
                manifest,
                stage_id=job["stage_id"],
                cache_key=job["cache_key"],
                result_dir=job["result_dir"],
                settings=settings,
                remote_run_id=job["remote_run_id"],
            )
            manifest_specs[key] = specs
            manifest_complete[key] = complete
            for spec in specs:
                remote_path = spec.get("remote_path")
                if not isinstance(remote_path, str):
                    continue
                artifact_paths.append(remote_path)
                artifact_targets.setdefault(remote_path, []).append(
                    (
                        job["tracking_id"],
                        job["stage_id"],
                        job["cache_key"],
                        job["remote_run_id"],
                        spec,
                    )
                )
        except (
            UnicodeDecodeError,
            json.JSONDecodeError,
            RecursionError,
            ManifestError,
            InspectionError,
            ValueError,
        ):
            manifest_complete[key] = False

    store: ArtifactStore | None = None
    if artifact_paths:
        try:
            store = ArtifactStore(settings)
        except (ArtifactPathError, OSError):
            store = None

    def publish_artifact_group(
        fetched: dict[str, bytes | None],
        failed: set[str],
    ) -> None:
        if store is None or not fetched:
            return
        published_any = False
        for remote_path, payload in fetched.items():
            if remote_path in failed or payload is None:
                continue
            targets = artifact_targets.get(remote_path, [])
            for tracking_id, stage_id, cache_key, source_remote_run_id, spec in targets:
                current = _load_claimed_tracking(session, tracking_id, token)
                if current is None:
                    continue
                stage_result = _ensure_stage_result(
                    session,
                    current.run,
                    current,
                    stage_id=stage_id,
                    cache_key=cache_key,
                    source_remote_run_id=source_remote_run_id,
                )
                if stage_result is None:
                    continue
                try:
                    published_any = (
                        _persist_verified_external_artifact(
                            session,
                            store,
                            current.run,
                            current,
                            stage_result=stage_result,
                            stage_id=stage_id,
                            cache_key=cache_key,
                            spec=spec,
                            payload=payload,
                            reference_sequence=(
                                contexts.get(tracking_id, {}).get("reference_sequence")
                                if isinstance(
                                    contexts.get(tracking_id, {}).get("reference_sequence"),
                                    str,
                                )
                                else None
                            ),
                        )
                        or published_any
                    )
                except (ArtifactPathError, OSError, ValueError) as exc:
                    logger.warning(
                        "mn5_external_artifact_publish_error type=%s",
                        type(exc).__name__,
                    )
        if published_any:
            session.commit()

    if artifact_paths:
        artifacts_fetched, artifact_failures = _fetch_many(
            settings,
            artifact_paths,
            limit=settings.mn5_max_artifact_bytes,
            on_progress=renew_claims,
            on_group_result=publish_artifact_group,
            group_size=_ARTIFACT_FETCH_GROUP_SIZE,
        )
    else:
        artifacts_fetched, artifact_failures = {}, set()

    for tracking_id in tracking_ids:
        row = _load_claimed_tracking(session, tracking_id, token)
        if row is None:
            continue
        run = row.run
        row.last_attempt_at = snapshot_now
        row.claim_token = None
        row.claim_expires_at = None
        context_path = context_paths[row.id]
        if context_path in context_failures:
            row.connection_status = "unavailable"
            row.sync_error_code = "mn5_unavailable"
            row.next_sync_at = now + timedelta(seconds=settings.mn5_external_sync_interval_seconds)
            continue
        if row.id in invalid_contexts or row.id not in contexts:
            row.connection_status = "unavailable"
            row.sync_error_code = "snapshot_unavailable"
            row.next_sync_at = now + timedelta(seconds=settings.mn5_external_sync_interval_seconds)
            continue
        context = contexts[row.id]
        snapshot_context = snapshot_contexts[row.id]
        try:
            _apply_snapshot(
                row,
                run,
                snapshot_context,
                now=snapshot_now,
                interval_seconds=settings.mn5_external_sync_interval_seconds,
            )
            _restore_published_stage_result_references(
                session,
                run,
                row,
                snapshot_context,
            )
        except ValueError:
            row.connection_status = "unavailable"
            row.sync_error_code = "snapshot_invalid"
            row.next_sync_at = now + timedelta(seconds=settings.mn5_external_sync_interval_seconds)
            continue

        result_error = row.id in invalid_publications
        published = dict(row.published_cache_keys or {})
        for job in manifest_jobs:
            if job["tracking_id"] != row.id:
                continue
            key = (row.id, job["stage_id"], job["cache_key"])
            complete = manifest_complete.get(key, False)
            if complete and store is not None:
                stage_result = _ensure_stage_result(
                    session,
                    run,
                    row,
                    stage_id=job["stage_id"],
                    cache_key=job["cache_key"],
                    source_remote_run_id=job["remote_run_id"],
                )
                if stage_result is None:
                    complete = False
                    result_error = True
                for spec in manifest_specs.get(key, []):
                    if not complete or stage_result is None:
                        break
                    remote_path = str(spec["remote_path"])
                    payload = artifacts_fetched.get(remote_path)
                    if (
                        remote_path in artifact_failures
                        or payload is None
                        or not _persist_verified_external_artifact(
                            session,
                            store,
                            run,
                            row,
                            stage_result=stage_result,
                            stage_id=job["stage_id"],
                            cache_key=job["cache_key"],
                            spec=spec,
                            payload=payload,
                            reference_sequence=(
                                context.get("reference_sequence")
                                if isinstance(context.get("reference_sequence"), str)
                                else None
                            ),
                        )
                    ):
                        complete = False
                        result_error = True
                        continue
            elif complete:
                complete = False
                result_error = True
            if complete:
                published[job["stage_id"]] = job["cache_key"]
            else:
                result_error = True
        row.published_cache_keys = published
        try:
            pending_jobs, invalid_stages = _published_stage_jobs(
                row,
                run,
                snapshot_context,
                settings,
                result_contexts=result_contexts_by_tracking.get(row.id),
            )
            pending_publications = (
                _has_pending_result_publications(row, run, snapshot_context)
                or bool(pending_jobs)
                or bool(invalid_stages)
            )
            result_error = result_error or bool(invalid_stages)
        except (InspectionError, ValueError):
            pending_publications = True
            result_error = True
        if _should_continue_external_sync(
            run,
            snapshot_context,
            pending_publications=pending_publications,
        ):
            row.next_sync_at = now + timedelta(seconds=settings.mn5_external_sync_interval_seconds)
        else:
            row.next_sync_at = None
        if row.connection_status == "connected":
            row.sync_error_code = "result_publication_pending" if result_error else None
    session.commit()
    return len(claimed)
