from __future__ import annotations

from datetime import UTC, datetime

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.auth import Principal
from app.core.config import get_settings
from app.core.security import sanitize_error_message
from app.features.auth.service import record_audit
from app.features.proteins.models import Protein
from app.features.runs.models import ActiveRunSlot, Run, RunStage, StageResult, Upload
from app.features.runs.schemas import ArtifactRead, RunCreate, RunRead, StageRead, UploadRead
from app.features.runs.state import RunStageStatus, RunStatus, can_transition
from app.features.stages.registry import STAGE_BY_ID, STAGE_DEFINITIONS


def now_utc() -> datetime:
    return datetime.now(UTC)


def _active_run_conflict(run: Run | None) -> HTTPException:
    if run is None:
        detail: str | dict[str, str] = "User already has an active protein run"
    else:
        detail = {
            "message": "User already has an active protein run",
            "run_id": run.id,
            "protein_id": run.protein_id,
        }
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


def _stage_read(stage: RunStage) -> StageRead:
    definition = STAGE_BY_ID[stage.stage_id]
    artifacts = [
        ArtifactRead(
            id=artifact.id,
            artifact_type=artifact.artifact_type,
            media_type=artifact.media_type,
            size=artifact.size,
            sha256=artifact.sha256,
            download_url=f"/api/v1/artifacts/{artifact.id}/content",
        )
        for artifact in (stage.stage_result.artifacts if stage.stage_result else [])
    ]
    return StageRead(
        id=definition.id,
        legacy_id=definition.legacy_id,
        title=definition.title,
        dependencies=list(definition.dependencies),
        optional=definition.optional,
        status=stage.status,
        stage_result_id=stage.stage_result_id,
        slurm_job_id=stage.slurm_job_id,
        error_code=stage.error_code,
        error_message=(
            sanitize_error_message(
                stage.error_message,
                roots=(get_settings().hpc_remote_root,),
            )
            if stage.error_message is not None
            else None
        ),
        started_at=stage.started_at,
        finished_at=stage.finished_at,
        artifacts=artifacts,
    )


def serialize_run(run: Run) -> RunRead:
    return RunRead(
        id=run.id,
        protein_id=run.protein_id,
        status=run.status,
        requested_variants=run.requested_variants or [],
        created_at=run.created_at,
        started_at=run.started_at,
        finished_at=run.finished_at,
        stages=[_stage_read(stage) for stage in run.stages],
        uploads=[
            UploadRead(
                id=upload.id,
                input_type=upload.input_type,
                original_filename=upload.original_filename,
                sha256=upload.sha256,
                size=upload.size,
                media_type=upload.media_type,
                transfer_status=upload.transfer_status,
            )
            for upload in run.uploads
        ],
    )


def get_owned_run(session: Session, run_id: str, principal: Principal) -> Run:
    run = session.scalar(
        select(Run)
        .options(
            selectinload(Run.protein),
            selectinload(Run.stages)
            .selectinload(RunStage.stage_result)
            .selectinload(StageResult.artifacts),
            selectinload(Run.uploads),
        )
        .where(Run.id == run_id)
    )
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found")
    if not principal.can_access(run.owner_id, run.project_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Run access denied")
    return run


def get_active_run(session: Session, principal: Principal) -> Run:
    slot = session.scalar(select(ActiveRunSlot).where(ActiveRunSlot.owner_id == principal.user_id))
    if slot is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No active run")
    run = get_owned_run(session, slot.run_id, principal)
    if run.status in {RunStatus.SUCCESS, RunStatus.FAILED, RunStatus.CANCELLED}:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No active run")
    return run


def create_run(
    session: Session,
    payload: RunCreate,
    principal: Principal,
    *,
    client_ip: str | None = None,
) -> Run:
    settings = get_settings()
    max_cpu = max((stage.cpu or 1 for stage in STAGE_DEFINITIONS), default=1)
    max_gpu = max((stage.gpu or 0 for stage in STAGE_DEFINITIONS), default=0)
    if max_cpu > settings.hpc_pipeline_cpu_budget or max_gpu > settings.hpc_pipeline_gpu_budget:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="configured HPC budget cannot execute the registered pipeline",
        )
    active_slot = session.scalar(
        select(ActiveRunSlot).where(ActiveRunSlot.owner_id == principal.user_id).with_for_update()
    )
    if active_slot is not None:
        active_run = session.get(Run, active_slot.run_id)
        if active_run is not None and active_run.status not in {
            RunStatus.SUCCESS,
            RunStatus.FAILED,
            RunStatus.CANCELLED,
        }:
            raise _active_run_conflict(active_run)
        session.delete(active_slot)
        session.flush()

    protein = session.scalar(select(Protein).where(Protein.id == payload.protein_id))
    if protein is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Protein not found")
    if not principal.can_access(protein.owner_id, protein.project_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Protein access denied")
    for variant in payload.variants:
        if variant.aa_position > protein.length:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Variant position out of range",
            )
        if protein.sequence[variant.aa_position - 1] != variant.aa_ref.upper():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"aa_ref does not match position {variant.aa_position}",
            )

    uploads: list[Upload] = []
    if payload.upload_ids:
        uploads = list(
            session.scalars(
                select(Upload).where(Upload.id.in_(payload.upload_ids)).with_for_update()
            ).all()
        )
        if len(uploads) != len(payload.upload_ids):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found")
        input_types = set()
        for upload in uploads:
            if not principal.is_admin and (
                upload.owner_id != principal.user_id or upload.project_id != principal.project_id
            ):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN, detail="Upload access denied"
                )
            if upload.run_id is not None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT, detail="Upload already attached"
                )
            if upload.input_type in input_types:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Only one upload per input type is allowed",
                )
            input_types.add(upload.input_type)

    requested_variants = [variant.model_dump() for variant in payload.variants]
    run = Run(
        protein_id=protein.id,
        owner_id=principal.user_id,
        project_id=principal.project_id,
        status=RunStatus.PENDING,
        requested_variants=requested_variants,
    )
    for definition in STAGE_DEFINITIONS:
        initial_status = (
            RunStageStatus.SKIPPED
            if (definition.optional or definition.requires_variant) and not requested_variants
            else RunStageStatus.PENDING
        )
        if not definition.dependencies and initial_status == RunStageStatus.PENDING:
            initial_status = RunStageStatus.READY
        run.stages.append(RunStage(stage_id=definition.id, status=initial_status))
    session.add(run)
    try:
        session.flush()
        for upload in uploads:
            upload.run_id = run.id
        session.add(ActiveRunSlot(owner_id=principal.user_id, run_id=run.id))
        record_audit(
            session,
            action="create_run",
            actor_user_id=principal.user_id,
            resource_type="run",
            resource_id=run.id,
            client_ip=client_ip,
            details={
                "protein_id": protein.id,
                "requested_variant_count": len(requested_variants),
                "upload_count": len(uploads),
            },
        )
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        slot = session.scalar(
            select(ActiveRunSlot).where(ActiveRunSlot.owner_id == principal.user_id)
        )
        existing = session.get(Run, slot.run_id) if slot is not None else None
        raise _active_run_conflict(existing) from exc
    session.refresh(run)
    return get_owned_run(session, run.id, principal)


def transition_stage(session: Session, stage: RunStage, target: RunStageStatus) -> None:
    current = RunStageStatus(stage.status)
    if stage.id is not None:
        # Re-read the persisted status under a row lock so a stale in-memory
        # object cannot overwrite a concurrent cancel/terminal transition.
        persisted = session.scalar(
            select(RunStage.status).where(RunStage.id == stage.id).with_for_update()
        )
        if persisted is not None:
            current = RunStageStatus(persisted)
    if not can_transition(current, target):
        raise ValueError(f"invalid stage transition: {current} -> {target}")
    stage.status = target
    if target == RunStageStatus.RUNNING:
        stage.started_at = now_utc()
    if target in {
        RunStageStatus.SUCCESS,
        RunStageStatus.REUSED,
        RunStageStatus.FAILED,
        RunStageStatus.SKIPPED,
        RunStageStatus.CANCELLED,
    }:
        stage.finished_at = now_utc()
        stage.lease_expires_at = None
    session.flush()


def request_cancel(
    session: Session,
    run: Run,
    *,
    actor_user_id: str | None = None,
    client_ip: str | None = None,
) -> Run:
    run_id = run.id
    # Lock stages before the run (same order as the worker claim) so a worker
    # holding a stage lock can never deadlock against cancellation.
    stages = list(
        session.scalars(
            select(RunStage)
            .where(RunStage.run_id == run_id)
            .order_by(RunStage.id)
            .with_for_update()
        )
    )
    locked_run = session.scalar(select(Run).where(Run.id == run_id).with_for_update())
    if locked_run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found")
    run = locked_run
    if run.status in {RunStatus.SUCCESS, RunStatus.FAILED, RunStatus.CANCELLED}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Run is already terminal")
    run.status = RunStatus.CANCEL_REQUESTED
    for stage in stages:
        if stage.status in {
            RunStageStatus.PENDING,
            RunStageStatus.READY,
            RunStageStatus.QUEUED,
        }:
            transition_stage(session, stage, RunStageStatus.CANCELLED)
    if not any(stage.status == RunStageStatus.RUNNING for stage in stages):
        run.status = RunStatus.CANCELLED
        run.finished_at = now_utc()
        slot = session.scalar(select(ActiveRunSlot).where(ActiveRunSlot.run_id == run.id))
        if slot is not None:
            session.delete(slot)
    record_audit(
        session,
        action="cancel_run",
        actor_user_id=actor_user_id or run.owner_id,
        resource_type="run",
        resource_id=run.id,
        client_ip=client_ip,
        details={"resulting_status": str(run.status)},
    )
    session.commit()
    return get_owned_run(session, run.id, Principal(run.owner_id, run.project_id))
