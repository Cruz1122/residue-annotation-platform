from __future__ import annotations

import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session, selectinload

from app.core.config import Settings, get_settings
from app.core.observability import log_worker_event
from app.features.artifacts.storage import ArtifactStore
from app.features.runs.models import ActiveRunSlot, Run, RunStage
from app.features.runs.service import transition_stage
from app.features.runs.state import RunStageStatus, RunStatus
from app.features.stages.registry import STAGE_BY_ID
from app.infrastructure.hpc.transfer import InputTransferError, SCPInputTransfer, remote_input_path


class StageExecutionUnavailable(RuntimeError):
    pass


class ScientificStageExecutor:
    """Boundary for real stage adapters.

    Until a stage has a reviewed executable adapter and baseline, failing here
    is safer than publishing a fabricated success or synthetic annotations.
    """

    def execute(self, stage_id: str, run_id: str) -> None:
        raise StageExecutionUnavailable(f"no reviewed executable adapter for stage {stage_id}")


def prepare_run_inputs(session: Session, run: Run, settings: Settings) -> None:
    """Transfer attached small inputs only for an explicitly enabled SSH profile."""

    if not run.uploads or not settings.hpc_input_transfer_enabled:
        return
    if settings.hpc_execution_mode != "ssh":
        raise InputTransferError("SCP input transfer requires the SSH HPC execution profile")

    store = ArtifactStore(settings)
    with SCPInputTransfer(settings) as transfer:
        for upload in run.uploads:
            if upload.transfer_status == "uploaded":
                continue
            local_path = store.resolve(upload.storage_key)
            suffix = Path(upload.original_filename).suffix.lower()
            remote_path = remote_input_path(
                settings, run.id, upload.id, suffix, input_type=upload.input_type
            )
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
    session.commit()
    return affected


def refresh_ready_states(session: Session, run_ids: set[str] | None = None) -> None:
    if run_ids is not None and not run_ids:
        return
    query = (
        select(RunStage)
        .options(selectinload(RunStage.run))
        .where(RunStage.status == RunStageStatus.PENDING)
    )
    if run_ids is not None:
        query = query.where(RunStage.run_id.in_(run_ids))
    pending_stages = session.scalars(query)
    for stage in pending_stages:
        definition = STAGE_BY_ID[stage.stage_id]
        sibling_states = {item.stage_id: item.status for item in stage.run.stages}
        dependency_states = [
            sibling_states.get(dependency) for dependency in definition.dependencies
        ]
        if any(
            dependency
            in {
                RunStageStatus.FAILED,
                RunStageStatus.CANCELLED,
                RunStageStatus.SKIPPED,
            }
            for dependency in dependency_states
        ):
            transition_stage(session, stage, RunStageStatus.SKIPPED)
            stage.error_code = "dependency_unavailable"
            stage.error_message = "a dependency did not publish a usable result"
        elif all(
            sibling_states.get(dependency) in {RunStageStatus.SUCCESS, RunStageStatus.REUSED}
            for dependency in definition.dependencies
        ):
            transition_stage(session, stage, RunStageStatus.READY)
    session.commit()


def _claim_statement():
    return (
        select(RunStage)
        .join(Run, Run.id == RunStage.run_id)
        .options(selectinload(RunStage.run))
        .where(RunStage.status == RunStageStatus.READY)
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
    stage.lease_expires_at = _lease_deadline(settings, _utcnow())
    transition_stage(session, stage, RunStageStatus.QUEUED)
    stage.run.status = RunStatus.RUNNING
    stage.run.started_at = stage.run.started_at or _utcnow()
    session.commit()
    log_worker_event(
        "stage_claimed",
        run_id=stage.run_id,
        stage_id=stage.stage_id,
        status=str(stage.status),
    )
    return stage


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


def _fail_stage(session: Session, stage: RunStage, error_code: str, message: str) -> None:
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
    stage.error_message = message[:1000]
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
    from app.features.runs.remote_executor import SSHStageExecutor

    executor = SSHStageExecutor(settings)
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
            executor.submit_stage(session, stage)
            inflight_count += 1
        except InputTransferError as exc:
            failed = session.get(RunStage, stage.id)
            if failed is not None:
                _fail_stage(session, failed, "input_transfer_failed", str(exc))
                refresh_ready_states(session, {failed.run_id})
                _finalize_runs(session, {failed.run_id})
        except Exception as exc:
            failed = session.get(RunStage, stage.id)
            if failed is not None:
                _fail_stage(session, failed, "remote_submit_failed", str(exc))
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
    if executor is None and settings.hpc_execution_mode == "ssh":
        return _process_remote(session, settings)
    stage = claim_ready_stage(session, settings)
    if stage is None:
        refresh_ready_states(session)
        _finalize_active_runs(session)
        return False
    executor = executor or ScientificStageExecutor()
    try:
        prepare_run_inputs(session, stage.run, settings)
        transition_stage(session, stage, RunStageStatus.RUNNING)
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
        _fail_stage(session, failed, "stage_execution_unavailable", str(exc))
        refresh_ready_states(session, {failed.run_id})
        _finalize_runs(session, {failed.run_id})
    return True
