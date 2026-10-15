from __future__ import annotations

import hashlib
import json
import re
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session, selectinload

from app.core.config import Settings, get_settings
from app.core.observability import log_worker_event
from app.core.security import sanitize_error_message
from app.features.artifacts.storage import ArtifactPathError, ArtifactStore
from app.features.runs.cache import (
    expected_artifact_types_for_stage,
    find_verified_cache_hit,
    planned_stage_cache_identity,
)
from app.features.runs.models import (
    ActiveRunSlot,
    Run,
    RunStage,
    StageResult,
    Upload,
)
from app.features.runs.preflight import (
    PreflightFailure,
    StagePreflight,
    ensure_preparation_record,
    execution_uploads,
    inspect_stage_preflight,
)
from app.features.runs.selection import dependency_is_satisfied, has_dependency_override
from app.features.runs.service import mark_run_running, transition_stage
from app.features.runs.state import RunStageStatus, RunStatus
from app.features.stages.registry import STAGE_BY_ID
from app.infrastructure.hpc.base import (
    HPCConfigurationError,
    HPCSubmissionAmbiguousError,
    HPCTransportError,
    PrefetchResult,
)
from app.infrastructure.hpc.transfer import (
    InputTransferError,
    NativeInputTransfer,
    SCPInputTransfer,
    remote_pipeline_input_namespace,
    remote_pipeline_input_path,
)


class StageExecutionUnavailable(RuntimeError):
    pass


class ScientificStageExecutor:
    """Boundary for real stage adapters.

    Until a stage has a reviewed executable adapter and baseline, failing here
    is safer than publishing a fabricated success or synthetic annotations.
    """

    def execute(self, stage_id: str, run_id: str) -> None:
        raise StageExecutionUnavailable(f"no reviewed executable adapter for stage {stage_id}")


def _preflight_details(report: StagePreflight) -> dict[str, object]:
    return {
        "stage_id": report.stage_id,
        "required_requirements": list(report.required_requirements),
        "prefetch_requirements": list(report.prefetch_requirements),
        "preparation_key": report.preparation_key,
    }


def _persist_preparation_failure(
    session: Session,
    stage: RunStage,
    failure: PreflightFailure,
) -> None:
    preparation = ensure_preparation_record(stage, ())
    preparation.status = "blocked" if failure.retryable else "failed"
    preparation.error_code = failure.code
    preparation.error_message = sanitize_error_message(
        failure.message,
        roots=(get_settings().hpc_remote_root,),
    )
    preparation.checked_at = _utcnow()
    if not failure.retryable:
        preparation.finished_at = _utcnow()
    session.commit()


def _ensure_external_preparation(
    session: Session,
    stage: RunStage,
    settings: Settings,
    executor: object,
    report: StagePreflight,
) -> None:
    missing = report.missing_prefetch_requirements
    preparation = ensure_preparation_record(stage, report.required_requirements)
    if not missing:
        session.commit()
        return
    if settings.hpc_execution_mode not in {"ssh", "native"}:
        failure = PreflightFailure(
            "prefetch_profile_unavailable",
            "external prerequisites require an SSH or native execution profile",
            retryable=True,
            details={"missing_requirements": list(missing)},
        )
        _persist_preparation_failure(session, stage, failure)
        raise failure
    prepare_external = getattr(executor, "prepare_external", None)
    if not callable(prepare_external):
        failure = PreflightFailure(
            "prefetch_adapter_unavailable",
            "the selected execution profile has no reviewed prefetch adapter",
            retryable=True,
            details={"missing_requirements": list(missing)},
        )
        _persist_preparation_failure(session, stage, failure)
        raise failure

    preparation.preparation_key = report.preparation_key
    preparation.status = "running"
    preparation.attempt_count += 1
    preparation.started_at = _utcnow()
    preparation.checked_at = None
    preparation.finished_at = None
    preparation.error_code = None
    preparation.error_message = None
    stage.preflight_status = "running"
    stage.preflight_error_code = None
    stage.preflight_error_message = None
    stage.preflight_details = _preflight_details(report)
    stage.preflight_checked_at = _utcnow()
    session.commit()
    try:
        result = prepare_external(session, stage, missing)
    except HPCTransportError as exc:
        failure = PreflightFailure(
            "prefetch_transport_unavailable",
            "the HPC connection was lost while preparing external prerequisites",
            retryable=True,
            details={"missing_requirements": list(missing)},
        )
        _persist_preparation_failure(session, stage, failure)
        raise failure from exc
    except HPCConfigurationError as exc:
        failure = PreflightFailure(
            "prefetch_configuration_unavailable",
            "the HPC prefetch profile is not configured",
            retryable=True,
            details={"missing_requirements": list(missing)},
        )
        _persist_preparation_failure(session, stage, failure)
        raise failure from exc
    except Exception as exc:
        failure = PreflightFailure(
            "prefetch_failed",
            "external prerequisite preparation failed",
            retryable=True,
            details={"missing_requirements": list(missing)},
        )
        _persist_preparation_failure(session, stage, failure)
        raise failure from exc
    if not isinstance(result, PrefetchResult) or result.status != "success":
        failure = PreflightFailure(
            "prefetch_failed",
            "external prerequisite preparation did not complete successfully",
            retryable=True,
            details={"missing_requirements": list(missing)},
        )
        _persist_preparation_failure(session, stage, failure)
        raise failure
    completed = set(result.requirements)
    if not set(missing).issubset(completed):
        failure = PreflightFailure(
            "prefetch_incomplete",
            "the prefetch adapter did not acknowledge every required prerequisite",
            retryable=True,
            details={
                "required_requirements": list(missing),
                "completed_requirements": sorted(completed),
            },
        )
        _persist_preparation_failure(session, stage, failure)
        raise failure
    snapshots = result.snapshots if isinstance(result.snapshots, dict) else {}
    missing_snapshots = sorted(
        requirement for requirement in missing if requirement not in snapshots
    )
    if missing_snapshots:
        failure = PreflightFailure(
            "prefetch_incomplete",
            "the prefetch adapter did not publish a snapshot for every prerequisite",
            retryable=True,
            details={"missing_snapshots": missing_snapshots},
        )
        _persist_preparation_failure(session, stage, failure)
        raise failure
    satisfied = set(preparation.satisfied_requirements or [])
    satisfied.update(missing)
    preparation.satisfied_requirements = sorted(satisfied)
    persisted_snapshots = dict(preparation.snapshots or {})
    persisted_snapshots.update(snapshots)
    preparation.snapshots = persisted_snapshots
    preparation.status = "success"
    preparation.checked_at = _utcnow()
    preparation.finished_at = _utcnow()
    preparation.error_code = None
    preparation.error_message = None
    session.commit()


def _mark_preflight_passed(
    session: Session,
    stage: RunStage,
    report: StagePreflight,
) -> None:
    preparation = ensure_preparation_record(stage, report.required_requirements)
    satisfied = set(preparation.satisfied_requirements or [])
    satisfied.update(report.required_requirements)
    preparation.satisfied_requirements = sorted(satisfied)
    preparation.status = (
        "success" if set(preparation.required_requirements or []).issubset(satisfied) else "pending"
    )
    preparation.checked_at = _utcnow()
    preparation.error_code = None
    preparation.error_message = None
    stage.preflight_status = "passed"
    stage.preflight_error_code = None
    stage.preflight_error_message = None
    stage.preflight_details = _preflight_details(report)
    stage.preflight_checked_at = _utcnow()
    stage.preflight_retry_at = None
    session.commit()


def _prepare_stage_for_execution(
    session: Session,
    stage: RunStage,
    settings: Settings,
    executor: object,
) -> None:
    report = inspect_stage_preflight(stage, settings)
    _ensure_external_preparation(session, stage, settings, executor, report)
    report = inspect_stage_preflight(stage, settings)
    if report.missing_prefetch_requirements:
        failure = PreflightFailure(
            "prefetch_incomplete",
            "required external prerequisites are still unavailable",
            retryable=True,
            details={"missing_requirements": list(report.missing_prefetch_requirements)},
        )
        _persist_preparation_failure(session, stage, failure)
        raise failure
    _mark_preflight_passed(session, stage, report)


def _handle_preflight_failure(
    session: Session,
    stage: RunStage,
    settings: Settings,
    failure: PreflightFailure,
) -> None:
    current = session.get(RunStage, stage.id) if stage.id is not None else stage
    if current is None:
        return
    current.preflight_status = "blocked" if failure.retryable else "failed"
    current.preflight_error_code = failure.code
    current.preflight_error_message = sanitize_error_message(
        failure.message,
        roots=(settings.hpc_remote_root,),
    )
    current.preflight_details = failure.details
    current.preflight_checked_at = _utcnow()
    if failure.retryable:
        if current.status in {RunStageStatus.QUEUED, RunStageStatus.RUNNING}:
            try:
                transition_stage(session, current, RunStageStatus.READY)
            except ValueError:
                # Cancellation/terminalization may win the row-lock race
                # after the in-memory status check. Never revive that stage;
                # discard the stale preparation fields and let finalization
                # observe the durable terminal state.
                session.rollback()
                latest = session.get(RunStage, current.id)
                if latest is None or latest.status in {
                    RunStageStatus.SUCCESS,
                    RunStageStatus.REUSED,
                    RunStageStatus.FAILED,
                    RunStageStatus.SKIPPED,
                    RunStageStatus.CANCELLED,
                }:
                    return
                raise
        current.preflight_retry_at = _utcnow() + timedelta(
            seconds=settings.hpc_preflight_retry_seconds
        )
        current.lease_expires_at = None
        active_elsewhere = session.scalar(
            select(RunStage.id)
            .where(RunStage.run_id == current.run_id)
            .where(RunStage.id != current.id)
            .where(RunStage.status.in_([RunStageStatus.QUEUED, RunStageStatus.RUNNING]))
        )
        if active_elsewhere is None:
            current.run.status = RunStatus.PENDING
        session.commit()
        return
    session.commit()
    _fail_stage(
        session,
        current,
        failure.code,
        failure.message,
        remote_root=settings.hpc_remote_root,
    )


def prepare_run_inputs(session: Session, run: Run, settings: Settings) -> None:
    """Transfer attached small inputs only for an explicitly enabled HPC profile."""

    uploads = execution_uploads(run)
    if not uploads:
        if settings.hpc_execution_mode in {"ssh", "native"} and settings.hpc_input_transfer_enabled:
            raise InputTransferError(
                "remote execution requires an attached FASTA input for the confirmed sequence"
            )
        return
    if settings.hpc_execution_mode not in {"ssh", "native"}:
        if not settings.hpc_input_transfer_enabled:
            return
        raise InputTransferError("input transfer requires the SSH or native HPC execution profile")
    if not settings.hpc_input_transfer_enabled:
        raise InputTransferError(
            "attached inputs require HPC_INPUT_TRANSFER_ENABLED=true for HPC execution"
        )

    accession = run.configuration.scientific_accession if run.configuration else None
    if not accession:
        for identifier in run.protein.identifiers:
            source = identifier.source.lower()
            if source in {"uniprot", "uniprot_accession", "accession"}:
                accession = identifier.identifier
                break
            if source == "fasta_header":
                match = re.search(r"(?:sp|tr)\|([^|]+)\|", identifier.identifier)
                if match:
                    accession = match.group(1)
                    break
    if not accession:
        raise InputTransferError("the protein needs a UniProt accession before input transfer")

    input_namespace = remote_pipeline_input_namespace(run.id)
    store = ArtifactStore(settings)
    pending: list[tuple[Upload, Path, str]] = []
    for upload in uploads:
        local_path = store.resolve(upload.storage_key)
        suffix = Path(upload.original_filename).suffix.lower()
        try:
            remote_path = remote_pipeline_input_path(
                settings,
                input_namespace,
                run.id,
                upload.id,
                suffix,
                input_type=upload.input_type,
            )
        except InputTransferError as exc:
            upload.transfer_status = "failed"
            upload.transfer_error = str(exc)[:1000]
            session.commit()
            raise
        try:
            stored_size, stored_sha256 = store.metadata(upload.storage_key)
        except (ArtifactPathError, OSError) as exc:
            upload.transfer_status = "failed"
            upload.transfer_error = "stored input is unavailable"
            session.commit()
            raise InputTransferError("stored input is unavailable") from exc
        if stored_size != upload.size or stored_sha256 != upload.sha256:
            upload.transfer_status = "failed"
            upload.transfer_error = "stored input integrity check failed"
            session.commit()
            raise InputTransferError("stored input integrity check failed")
        if upload.transfer_status == "uploaded" and upload.remote_path == remote_path:
            continue
        pending.append((upload, local_path, remote_path))

    if not any(upload.input_type == "fasta" for upload in uploads):
        raise InputTransferError(
            "remote execution requires an attached FASTA input for the confirmed sequence"
        )

    if not pending:
        return

    transfer_type = (
        SCPInputTransfer if settings.hpc_execution_mode == "ssh" else NativeInputTransfer
    )
    with transfer_type(settings) as transfer:
        for upload, local_path, remote_path in pending:
            try:
                transfer.upload(local_path, remote_path)
            except InputTransferError as exc:
                upload.transfer_status = "failed"
                upload.transfer_error = str(exc)[:1000]
                session.commit()
                raise
            upload.transfer_status = "uploaded"
            upload.remote_path = remote_path
            upload.transfer_error = None
            upload.transferred_at = _utcnow()
            session.commit()


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _lease_deadline(settings: Settings, now: datetime) -> datetime:
    return now + timedelta(seconds=settings.run_worker_lease_seconds)


def recover_stale_stages(session: Session, settings: Settings) -> set[str]:
    """Reconcile stages whose worker lease expired without a terminal commit.

    A process that dies after claiming a stage leaves it QUEUED/RUNNING
    forever. Requeueing (bounded by attempts) frees the stage and, through
    ``finalize_run``, any run slot it was holding. Stages with an accepted
    Slurm job are left to the remote polling path, which refreshes their lease.
    """

    now = _utcnow()
    stale = list(
        session.scalars(
            select(RunStage)
            .options(selectinload(RunStage.run))
            .where(RunStage.status.in_([RunStageStatus.QUEUED, RunStageStatus.RUNNING]))
            .where(or_(RunStage.lease_expires_at.is_(None), RunStage.lease_expires_at < now))
        )
    )
    affected: set[str] = set()
    for stage in stale:
        affected.add(stage.run_id)
        if stage.slurm_job_id:
            # The remote job may still be running; the remote polling path
            # reconciles status and cancellation. Expiring both leases makes
            # an abandoned poll claim available to a different worker.
            stage.poll_claim_token = None
            stage.poll_claim_expires_at = None
            stage.lease_expires_at = _lease_deadline(settings, now)
            continue
        if stage.run.status in {RunStatus.CANCEL_REQUESTED, RunStatus.CANCELLED}:
            transition_stage(session, stage, RunStageStatus.CANCELLED)
            continue
        if stage.attempt_count >= settings.run_worker_max_attempts:
            transition_stage(session, stage, RunStageStatus.FAILED)
            stage.error_code = "lease_expired"
            stage.error_message = (
                f"stage lease expired after {stage.attempt_count} attempts without a result"
            )
            continue
        if stage.status in {RunStageStatus.QUEUED, RunStageStatus.RUNNING}:
            transition_stage(session, stage, RunStageStatus.READY)
        # attempt_count keeps the retry trace; error fields stay empty so a
        # recovered stage that later succeeds is not shown as errored.
        stage.lease_expires_at = None
        stage.error_code = None
        stage.error_message = None
        if stage.preflight_status == "running":
            stage.preflight_status = "pending"
            stage.preflight_error_code = None
            stage.preflight_error_message = None
            stage.preflight_retry_at = None
    session.commit()
    return affected


def refresh_ready_states(session: Session, run_ids: set[str] | None = None) -> None:
    if run_ids is not None and not run_ids:
        return
    query = (
        select(RunStage)
        .options(
            selectinload(RunStage.run).selectinload(Run.stages),
            selectinload(RunStage.run).selectinload(Run.configuration),
        )
        .where(RunStage.status == RunStageStatus.PENDING)
    )
    if run_ids is not None:
        query = query.where(RunStage.run_id.in_(run_ids))
    pending_stages = session.scalars(query)
    for stage in pending_stages:
        definition = STAGE_BY_ID[stage.stage_id]
        sibling_states = {item.stage_id: item.status for item in stage.run.stages}
        prerequisites = (
            stage.run.configuration.prerequisites if stage.run.configuration is not None else {}
        )
        dependency_states = [
            sibling_states.get(dependency) for dependency in definition.dependencies
        ]
        if any(
            state in {RunStageStatus.FAILED, RunStageStatus.CANCELLED}
            or (
                state == RunStageStatus.SKIPPED
                and not dependency_is_satisfied(
                    structure_source=(
                        stage.run.configuration.structure_source
                        if stage.run.configuration is not None
                        else "alphafold3"
                    ),
                    dependency_id=dependency,
                    status=str(state),
                    allow_provided_pdb_substitution=has_dependency_override(
                        prerequisites,
                        dependency,
                    ),
                )
            )
            for dependency, state in zip(definition.dependencies, dependency_states, strict=False)
        ):
            transition_stage(session, stage, RunStageStatus.SKIPPED)
            stage.error_code = "dependency_unavailable"
            stage.error_message = "a dependency did not publish a usable result"
        elif all(
            dependency_is_satisfied(
                structure_source=(
                    stage.run.configuration.structure_source
                    if stage.run.configuration is not None
                    else "alphafold3"
                ),
                dependency_id=dependency,
                status=str(sibling_states.get(dependency)),
                allow_provided_pdb_substitution=has_dependency_override(
                    prerequisites,
                    dependency,
                ),
            )
            for dependency in definition.dependencies
        ):
            transition_stage(session, stage, RunStageStatus.READY)
    session.commit()


def _claim_statement():
    return (
        select(RunStage)
        .join(Run, Run.id == RunStage.run_id)
        .options(
            selectinload(RunStage.run).selectinload(Run.stages),
            selectinload(RunStage.run).selectinload(Run.configuration),
            selectinload(RunStage.run).selectinload(Run.protein),
        )
        .where(RunStage.status == RunStageStatus.READY)
        .where(
            or_(
                RunStage.preflight_status != "blocked",
                RunStage.preflight_retry_at.is_(None),
                RunStage.preflight_retry_at <= _utcnow(),
            )
        )
        .where(Run.status.not_in([RunStatus.CANCEL_REQUESTED, RunStatus.CANCELLED]))
        .order_by(RunStage.created_at)
        # LIMIT 1 keeps SKIP LOCKED from locking every READY row, which would
        # starve other workers during the claim transaction.
        .limit(1)
        .with_for_update(skip_locked=True)
    )


def claim_ready_stage(session: Session, settings: Settings) -> RunStage | None:
    stage = session.scalar(_claim_statement())
    if stage is None:
        return None
    stage.attempt_count += 1
    if stage.preflight_status == "blocked":
        stage.preflight_status = "pending"
        stage.preflight_error_code = None
        stage.preflight_error_message = None
        stage.preflight_details = {}
        stage.preflight_retry_at = None
    stage.lease_expires_at = _lease_deadline(settings, _utcnow())
    transition_stage(session, stage, RunStageStatus.QUEUED)
    session.commit()
    log_worker_event(
        "stage_claimed",
        run_id=stage.run_id,
        stage_id=stage.stage_id,
        status=str(stage.status),
    )
    return stage


def reserve_remote_submission(session: Session, stage_id: str) -> RunStage | None:
    """Revalidate a stage immediately before the scheduler submit.

    Preflight and input transfer intentionally commit progress so a worker can
    restart without repeating expensive preparation. That creates a small
    boundary before ``sbatch`` where cancellation may otherwise terminalize a
    queued stage. Locking the stage and then its run (the same order used by
    ``request_cancel``) keeps the reservation and cancellation decisions
    serializable. The lock remains held until the executor commits the job id
    and leaves the stage queued, or observes an already-running handle.
    """

    stage = session.scalar(select(RunStage).where(RunStage.id == stage_id).with_for_update())
    if stage is None:
        session.commit()
        return None
    run = session.scalar(select(Run).where(Run.id == stage.run_id).with_for_update())
    if run is None or stage.status not in {RunStageStatus.QUEUED, RunStageStatus.RUNNING}:
        session.commit()
        return None
    if run.status in {
        RunStatus.CANCEL_REQUESTED,
        RunStatus.CANCELLED,
        RunStatus.SUCCESS,
        RunStatus.FAILED,
    }:
        session.commit()
        return None
    # The identity map normally already contains this relationship from the
    # claim query; assigning the locked object makes the lock's status the
    # object consumed by the executor even after a concurrent refresh.
    stage.run = run
    return stage


def _provided_structure_dependency_key(run: Run) -> str:
    configuration = run.configuration
    if configuration is None or not configuration.structure_sha256:
        raise StageExecutionUnavailable("provided structure configuration is incomplete")
    payload = {
        "source": configuration.structure_source,
        "sha256": configuration.structure_sha256,
        "chain": configuration.structure_chain,
        "mapping": configuration.structure_mapping or {},
    }
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def plan_stage_cache(session: Session, stage: RunStage, settings: Settings) -> bool:
    """Plan a stage key and link a verified hit before any execution submit."""

    configuration = stage.run.configuration
    if configuration is None:
        raise StageExecutionUnavailable("run has no confirmed configuration")
    dependency_keys: dict[str, str] = {}
    for dependency_id in STAGE_BY_ID[stage.stage_id].dependencies:
        dependency = next(
            (candidate for candidate in stage.run.stages if candidate.stage_id == dependency_id),
            None,
        )
        if dependency is None:
            raise StageExecutionUnavailable(f"stage dependency {dependency_id} is missing")
        if dependency.stage_result_id:
            result = session.get(StageResult, dependency.stage_result_id)
            if result is None or result.status != "success":
                raise StageExecutionUnavailable(
                    f"stage dependency {dependency_id} has no published result"
                )
            dependency_keys[dependency_id] = result.cache_key
        elif (
            configuration.structure_source == "provided_pdb"
            and dependency_id == "structure_modeling"
            and dependency.status == RunStageStatus.SKIPPED
            and has_dependency_override(configuration.prerequisites, dependency_id)
        ):
            dependency_keys[dependency_id] = _provided_structure_dependency_key(stage.run)
        else:
            raise StageExecutionUnavailable(
                f"stage dependency {dependency_id} has no cache identity"
            )

    cache_key, factors = planned_stage_cache_identity(stage, configuration, dependency_keys)
    stage.cache_key = cache_key
    stage.cache_factors = factors
    session.flush()
    hit = find_verified_cache_hit(
        session,
        stage,
        cache_key,
        ArtifactStore(settings),
        require_provenance=True,
        expected_artifact_types=expected_artifact_types_for_stage(stage.stage_id),
    )
    if hit is None:
        session.commit()
        return False
    persisted = session.scalar(
        select(RunStage.status).where(RunStage.id == stage.id).with_for_update()
    )
    if persisted not in {RunStageStatus.READY, RunStageStatus.QUEUED, RunStageStatus.RUNNING}:
        session.commit()
        return False
    if persisted != RunStageStatus.READY:
        stage.status = persisted
    if stage.status == RunStageStatus.QUEUED:
        transition_stage(session, stage, RunStageStatus.RUNNING)
    transition_stage(session, stage, RunStageStatus.REUSED)
    stage.stage_result_id = hit.id
    stage.reuse_reason = {
        "source_stage_result_id": hit.id,
        "cache_key": cache_key,
        "factors": factors,
        "authorization": "owner_or_project_scope",
        "artifact_integrity": "verified_size_and_sha256",
    }
    session.commit()
    return True


def finalize_run(session: Session, run: Run) -> None:
    current = session.scalar(select(Run.status).where(Run.id == run.id).with_for_update())
    if current is None:
        return
    run.status = current
    if current in {RunStatus.SUCCESS, RunStatus.FAILED, RunStatus.CANCELLED}:
        # Terminal run states are immutable: a stale worker must not revive a
        # run that was already cancelled or finished. The slot is still
        # released in case a previous crash left it behind.
        slot = session.scalar(select(ActiveRunSlot).where(ActiveRunSlot.run_id == run.id))
        if slot is not None:
            session.delete(slot)
        session.commit()
        return
    stages = list(session.scalars(select(RunStage).where(RunStage.run_id == run.id)))
    statuses = {RunStageStatus(stage.status) for stage in stages}
    if run.status == RunStatus.CANCEL_REQUESTED and not statuses.intersection(
        {RunStageStatus.RUNNING, RunStageStatus.QUEUED}
    ):
        run.status = RunStatus.CANCELLED
        run.finished_at = _utcnow()
    elif statuses and statuses.issubset(
        {
            RunStageStatus.SUCCESS,
            RunStageStatus.REUSED,
            RunStageStatus.FAILED,
            RunStageStatus.SKIPPED,
            RunStageStatus.CANCELLED,
        }
    ):
        run.status = RunStatus.FAILED if RunStageStatus.FAILED in statuses else RunStatus.SUCCESS
        run.finished_at = _utcnow()
    if run.status in {RunStatus.SUCCESS, RunStatus.FAILED, RunStatus.CANCELLED}:
        slot = session.scalar(select(ActiveRunSlot).where(ActiveRunSlot.run_id == run.id))
        if slot is not None:
            session.delete(slot)
    session.commit()


def _fail_stage(
    session: Session,
    stage: RunStage,
    error_code: str,
    message: str,
    *,
    remote_root: str | None = None,
) -> None:
    persisted = (
        session.scalar(select(RunStage.status).where(RunStage.id == stage.id))
        if stage.id is not None
        else stage.status
    )
    current = RunStageStatus(persisted if persisted is not None else stage.status)
    stage.status = current
    if current not in {RunStageStatus.QUEUED, RunStageStatus.RUNNING, RunStageStatus.READY}:
        # A concurrent cancel/terminal transition won; do not overwrite it.
        session.commit()
        return
    try:
        transition_stage(session, stage, RunStageStatus.FAILED)
    except ValueError:
        session.rollback()
        return
    stage.error_code = error_code
    stage.error_message = sanitize_error_message(
        message,
        roots=(remote_root,) if remote_root else (),
    )
    session.commit()
    log_worker_event(
        "stage_failed",
        run_id=stage.run_id,
        stage_id=stage.stage_id,
        job_id=stage.slurm_job_id,
        status=str(stage.status),
        error_code=error_code,
    )


def renew_stage_lease(
    session: Session,
    stage_id: str,
    settings: Settings,
    poll_claim_token: str | None = None,
) -> bool:
    """Renew a lease for a stage that is still owned by a running worker."""

    statement = select(RunStage).where(RunStage.id == stage_id)
    if poll_claim_token is not None:
        statement = statement.where(RunStage.poll_claim_token == poll_claim_token)
    stage = session.scalar(statement.with_for_update())
    if stage is None or stage.status not in {RunStageStatus.QUEUED, RunStageStatus.RUNNING}:
        return False
    deadline = _lease_deadline(settings, _utcnow())
    stage.lease_expires_at = deadline
    if poll_claim_token is not None:
        stage.poll_claim_expires_at = deadline
    session.commit()
    return True


class _LeaseHeartbeat:
    """Keep a stage lease alive while a synchronous executor runs.

    Without this, an execution longer than ``run_worker_lease_seconds`` would
    look abandoned and could be reclaimed and executed twice by another worker.
    """

    def __init__(
        self,
        stage_id: str,
        settings: Settings,
        poll_claim_token: str | None = None,
    ):
        self.stage_id = stage_id
        self.poll_claim_token = poll_claim_token
        self.interval = max(5.0, settings.run_worker_lease_seconds / 3)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def __enter__(self) -> _LeaseHeartbeat:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def _run(self) -> None:
        from app.core.db import SessionLocal

        while not self._stop.wait(self.interval):
            try:
                with SessionLocal() as session:
                    renew_stage_lease(
                        session,
                        self.stage_id,
                        get_settings(),
                        self.poll_claim_token,
                    )
            except Exception:
                continue

    def __exit__(self, *_: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)


def _remote_stage_claim_statement(now: datetime):
    return (
        select(RunStage)
        .join(Run, Run.id == RunStage.run_id)
        .options(selectinload(RunStage.run).selectinload(Run.protein))
        .where(RunStage.slurm_job_id.is_not(None))
        .where(RunStage.status.in_([RunStageStatus.QUEUED, RunStageStatus.RUNNING]))
        .where(Run.status.in_([RunStatus.PENDING, RunStatus.RUNNING, RunStatus.CANCEL_REQUESTED]))
        .where(
            or_(
                RunStage.poll_claim_token.is_(None),
                RunStage.poll_claim_expires_at.is_(None),
                RunStage.poll_claim_expires_at < now,
            )
        )
        .order_by(RunStage.created_at)
        .limit(1)
        .with_for_update(skip_locked=True)
    )


def claim_remote_stage(session: Session, settings: Settings) -> tuple[RunStage, str] | None:
    """Claim one accepted remote job for exclusive polling and ingestion."""

    now = _utcnow()
    stage = session.scalar(_remote_stage_claim_statement(now))
    if stage is None:
        return None
    token = str(uuid4())
    deadline = _lease_deadline(settings, now)
    stage.poll_claim_token = token
    stage.poll_claim_expires_at = deadline
    stage.lease_expires_at = deadline
    session.commit()
    return stage, token


def release_remote_stage_claim(session: Session, stage_id: str, token: str) -> None:
    """Release a claim only when it is still owned by this polling attempt."""

    session.execute(
        update(RunStage)
        .where(RunStage.id == stage_id)
        .where(RunStage.poll_claim_token == token)
        .values(poll_claim_token=None, poll_claim_expires_at=None)
    )
    session.commit()


def _remote_inflight_count(session: Session) -> int:
    return int(
        session.scalar(
            select(func.count())
            .select_from(RunStage)
            .join(Run, Run.id == RunStage.run_id)
            .where(RunStage.slurm_job_id.is_not(None))
            .where(RunStage.status.in_([RunStageStatus.QUEUED, RunStageStatus.RUNNING]))
            .where(
                Run.status.in_([RunStatus.PENDING, RunStatus.RUNNING, RunStatus.CANCEL_REQUESTED])
            )
        )
        or 0
    )


def _finalize_runs(session: Session, run_ids: set[str]) -> None:
    for run_id in run_ids:
        run = session.get(Run, run_id)
        if run is not None:
            finalize_run(session, run)


def _finalize_active_runs(session: Session) -> None:
    active_runs = list(
        session.scalars(select(Run).where(Run.status.in_([RunStatus.PENDING, RunStatus.RUNNING])))
    )
    for run in active_runs:
        finalize_run(session, run)


def _process_remote(session: Session, settings: Settings) -> bool:
    from app.features.runs.remote_executor import NativeStageExecutor, SSHStageExecutor

    executor_type = (
        NativeStageExecutor if settings.hpc_execution_mode == "native" else SSHStageExecutor
    )
    try:
        executor = executor_type(settings)
    except HPCConfigurationError:
        # A missing secret, host key or native Slurm installation is an
        # operational condition, not a scientific result. Keep queued/ready
        # stages durable and let the next worker tick retry after the
        # deployment is repaired instead of crashing the worker or fabricating
        # a stage failure.
        log_worker_event(
            "remote_executor_unavailable",
            status="retryable",
            error_code="hpc_configuration_unavailable",
        )
        return False
    inflight_count = _remote_inflight_count(session)
    processed = False
    for _ in range(settings.hpc_max_inflight_stages):
        claimed = claim_remote_stage(session, settings)
        if claimed is None:
            break
        active_stage, claim_token = claimed
        processed = True
        try:
            with _LeaseHeartbeat(active_stage.id, settings, claim_token):
                if active_stage.run.status == RunStatus.CANCEL_REQUESTED:
                    executor.cancel_stage(session, active_stage)
                else:
                    executor.poll_stage(session, active_stage)
        finally:
            log_worker_event(
                "remote_stage_reconciled",
                run_id=active_stage.run_id,
                stage_id=active_stage.stage_id,
                job_id=active_stage.slurm_job_id,
                status=str(active_stage.status),
            )
            release_remote_stage_claim(session, active_stage.id, claim_token)
        refresh_ready_states(session, {active_stage.run_id})
        _finalize_runs(session, {active_stage.run_id})

    # Submit new work while the configured remote capacity is not exhausted.
    while inflight_count < settings.hpc_max_inflight_stages:
        stage = claim_ready_stage(session, settings)
        if stage is None:
            break
        processed = True
        try:
            prepare_run_inputs(session, stage.run, settings)
            _prepare_stage_for_execution(session, stage, settings, executor)
            if plan_stage_cache(session, stage, settings):
                refresh_ready_states(session, {stage.run_id})
                _finalize_runs(session, {stage.run_id})
                continue
            reserved = reserve_remote_submission(session, stage.id)
            if reserved is None:
                refresh_ready_states(session, {stage.run_id})
                _finalize_runs(session, {stage.run_id})
                continue
            executor.submit_stage(session, reserved)
            inflight_count += 1
        except PreflightFailure as exc:
            failed = session.get(RunStage, stage.id)
            if failed is not None:
                _handle_preflight_failure(session, failed, settings, exc)
                refresh_ready_states(session, {failed.run_id})
                _finalize_runs(session, {failed.run_id})
        except HPCSubmissionAmbiguousError as exc:
            failed = session.get(RunStage, stage.id)
            if failed is not None and failed.status in {
                RunStageStatus.QUEUED,
                RunStageStatus.RUNNING,
            }:
                # The remote scheduler accepted the job, but the receipt
                # write was not confirmed. Persist the recovered job id
                # immediately so polling/cancellation can own it without a
                # second submit.
                # The scheduler accepted the job, but its runtime state is
                # still unknown. Keep the stage queued until polling observes
                # actual execution.
                failed.slurm_job_id = exc.job_id
                failed.preflight_status = "passed"
                failed.preflight_retry_at = None
                failed.error_code = None
                failed.error_message = None
                failed.lease_expires_at = _lease_deadline(settings, _utcnow())
                session.commit()
                inflight_count += 1
                refresh_ready_states(session, {failed.run_id})
                _finalize_runs(session, {failed.run_id})
            break
        except HPCTransportError:
            # The remote submit adapter writes a deterministic receipt before
            # returning. Keep this stage retryable so the next invocation of
            # the same request reads that receipt instead of issuing a second
            # sbatch call after an ambiguous network failure.
            failed = session.get(RunStage, stage.id)
            if failed is not None and failed.status in {
                RunStageStatus.QUEUED,
                RunStageStatus.RUNNING,
            }:
                transition_stage(session, failed, RunStageStatus.READY)
                failed.preflight_status = "passed"
                failed.preflight_retry_at = None
                failed.error_code = None
                failed.error_message = None
                failed.lease_expires_at = None
                active_elsewhere = session.scalar(
                    select(RunStage.id)
                    .where(RunStage.run_id == failed.run_id)
                    .where(RunStage.id != failed.id)
                    .where(RunStage.status.in_([RunStageStatus.QUEUED, RunStageStatus.RUNNING]))
                )
                if active_elsewhere is None:
                    failed.run.status = RunStatus.PENDING
                session.commit()
                refresh_ready_states(session, {failed.run_id})
                _finalize_runs(session, {failed.run_id})
            # Do not reclaim the same READY row in this worker tick. The
            # next invocation is the retry boundary and can reconcile the
            # deterministic submission receipt first.
            break
        except HPCConfigurationError:
            failed = session.get(RunStage, stage.id)
            if failed is not None:
                _handle_preflight_failure(
                    session,
                    failed,
                    settings,
                    PreflightFailure(
                        "hpc_configuration_unavailable",
                        "the HPC execution profile is not configured",
                        retryable=True,
                    ),
                )
                refresh_ready_states(session, {failed.run_id})
                _finalize_runs(session, {failed.run_id})
        except InputTransferError as exc:
            failed = session.get(RunStage, stage.id)
            if failed is not None:
                _fail_stage(
                    session,
                    failed,
                    "input_transfer_failed",
                    str(exc),
                    remote_root=settings.hpc_remote_root,
                )
                refresh_ready_states(session, {failed.run_id})
                _finalize_runs(session, {failed.run_id})
        except Exception as exc:
            failed = session.get(RunStage, stage.id)
            if failed is not None:
                _fail_stage(
                    session,
                    failed,
                    "remote_submit_failed",
                    str(exc),
                    remote_root=settings.hpc_remote_root,
                )
                refresh_ready_states(session, {failed.run_id})
                _finalize_runs(session, {failed.run_id})

    if not processed:
        refresh_ready_states(session)
        _finalize_active_runs(session)
        return False
    return True


def process_one(session: Session, executor: ScientificStageExecutor | None = None) -> bool:
    settings = get_settings()
    recovered = recover_stale_stages(session, settings)
    if recovered:
        refresh_ready_states(session, recovered)
        _finalize_runs(session, recovered)
    if executor is None and settings.hpc_execution_mode in {"ssh", "native"}:
        return _process_remote(session, settings)
    stage = claim_ready_stage(session, settings)
    if stage is None:
        refresh_ready_states(session)
        _finalize_active_runs(session)
        return False
    executor = executor or ScientificStageExecutor()
    try:
        prepare_run_inputs(session, stage.run, settings)
        _prepare_stage_for_execution(session, stage, settings, executor)
        if plan_stage_cache(session, stage, settings):
            refresh_ready_states(session, {stage.run_id})
            _finalize_runs(session, {stage.run_id})
            return True
        transition_stage(session, stage, RunStageStatus.RUNNING)
        mark_run_running(session, stage)
        stage.lease_expires_at = _lease_deadline(settings, _utcnow())
        session.commit()
        log_worker_event(
            "stage_started",
            run_id=stage.run_id,
            stage_id=stage.stage_id,
            status=str(stage.status),
        )
        with _LeaseHeartbeat(stage.id, settings):
            executor.execute(stage.stage_id, stage.run_id)
    except PreflightFailure as exc:
        failed = session.get(RunStage, stage.id)
        if failed is None:
            return True
        _handle_preflight_failure(session, failed, settings, exc)
        refresh_ready_states(session, {failed.run_id})
        _finalize_runs(session, {failed.run_id})
    except InputTransferError as exc:
        failed = session.get(RunStage, stage.id)
        if failed is None:
            return True
        _fail_stage(session, failed, "input_transfer_failed", str(exc))
        refresh_ready_states(session, {failed.run_id})
        _finalize_runs(session, {failed.run_id})
    except Exception as exc:
        failed = session.get(RunStage, stage.id)
        if failed is None:
            return True
        _fail_stage(
            session,
            failed,
            "stage_execution_unavailable",
            str(exc),
            remote_root=settings.hpc_remote_root,
        )
        refresh_ready_states(session, {failed.run_id})
        _finalize_runs(session, {failed.run_id})
    return True
