from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.auth import Principal
from app.core.config import Settings, get_settings
from app.core.security import sanitize_error_message
from app.features.auth.service import record_audit
from app.features.proteins.models import Protein
from app.features.proteins.service import normalize_sequence
from app.features.runs.configuration import (
    ConfigurationValidationError,
    empty_structure_mapping,
    inspect_structure,
    read_verified_upload,
    resolve_accession,
)
from app.features.runs.models import (
    ActiveRunSlot,
    Run,
    RunConfiguration,
    RunIdempotencyKey,
    RunStage,
    StageResult,
    Upload,
)
from app.features.runs.schemas import (
    ArtifactRead,
    RunConfigurationRead,
    RunCreate,
    RunRead,
    StageRead,
    UploadRead,
)
from app.features.runs.selection import omission_by_stage, resolve_stage_selection
from app.features.runs.state import RunStageStatus, RunStatus, can_transition
from app.features.stages.registry import STAGE_BY_ID, STAGE_DEFINITIONS


def now_utc() -> datetime:
    return datetime.now(UTC)


def _configuration_versions(scientific_parameters: dict[str, object]) -> dict[str, object]:
    """Snapshot the local registry contract used to plan this run.

    Spec 1 does not execute scientific stages, so this is deliberately a
    local contract snapshot rather than a claim that external tools or model
    weights were executed.  Empty external snapshots make cache reuse fail
    closed for stages that require them until an executor supplies them.
    """

    registry_snapshot = [definition.to_dict() for definition in STAGE_DEFINITIONS]
    encoded_registry = json.dumps(
        registry_snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    resource_snapshot = {
        definition.id: {
            "cpu": definition.cpu or 1,
            "gpu": definition.gpu or 0,
            "network": definition.network,
            "memory_gb": definition.memory_gb,
        }
        for definition in STAGE_DEFINITIONS
    }
    encoded_resources = json.dumps(
        resource_snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    registry_path = Path(__file__).resolve().parents[1] / "stages" / "registry.py"
    try:
        stage_code_sha256 = hashlib.sha256(registry_path.read_bytes()).hexdigest()
    except OSError:
        stage_code_sha256 = hashlib.sha256(encoded_registry).hexdigest()
    declared_external_snapshots = scientific_parameters.get("external_snapshots", {})
    external_snapshots = (
        declared_external_snapshots if isinstance(declared_external_snapshots, dict) else {}
    )
    return {
        "contract_version": "run-configuration-v1",
        "cache_schema": "stage-cache-v2",
        "registry_version": hashlib.sha256(encoded_registry).hexdigest(),
        "stage_versions": {
            definition.id: definition.stage_version for definition in STAGE_DEFINITIONS
        },
        "stage_code_sha256": stage_code_sha256,
        "resource_version": hashlib.sha256(encoded_resources).hexdigest(),
        "model_versions": {},
        "external_snapshots": external_snapshots,
        "reproducibility_status": (
            "local_contract_verified_external_snapshots_unverified"
            if external_snapshots
            else "local_contract_verified_external_snapshots_pending"
        ),
    }


def _available_technical_requirements(
    settings: Settings,
    scientific_parameters: dict[str, object],
) -> set[str]:
    """Resolve only explicitly declared capabilities for stage selection.

    A local/default run has no Slurm, external cache, MSA, or mapping claim.
    User payloads cannot self-authorize a technical capability: declared
    prerequisite names and external snapshot references are persisted as
    intent, but only the configured execution profile grants capabilities.
    """

    available: set[str] = set()
    if settings.hpc_execution_mode in {"ssh", "native"}:
        available.update({"slurm:SLURM_JOB_ID", "command:srun"})
    return available


def _active_run_conflict(run: Run | None) -> HTTPException:
    if run is None:
        detail: dict[str, str] = {
            "message": "User already has an active protein run",
            "code": "active_run_slot",
            "policy": "single_active_run_per_user",
        }
    else:
        detail = {
            "message": "User already has an active protein run",
            "code": "active_run_slot",
            "policy": "single_active_run_per_user",
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
        cache_key=stage.cache_key,
        cache_factors=stage.cache_factors or {},
        reuse_reason=stage.reuse_reason,
        omission_reason=stage.omission_reason,
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
    configuration = (
        RunConfigurationRead(
            id=run.configuration.id,
            run_id=run.configuration.run_id,
            protein_id=run.configuration.protein_id,
            sequence_sha256=run.configuration.sequence_sha256,
            scientific_accession=run.configuration.scientific_accession,
            fasta_upload_id=run.configuration.fasta_upload_id,
            fasta_sha256=run.configuration.fasta_sha256,
            structure_upload_id=run.configuration.structure_upload_id,
            structure_source=run.configuration.structure_source,
            structure_sha256=run.configuration.structure_sha256,
            structure_chain=run.configuration.structure_chain,
            structure_mapping=run.configuration.structure_mapping or {},
            normalized_variants=run.configuration.normalized_variants or [],
            selected_stage_ids=run.configuration.selected_stage_ids or [],
            omitted_stages=run.configuration.omitted_stages or [],
            scientific_parameters=run.configuration.scientific_parameters or {},
            prerequisites=run.configuration.prerequisites or {},
            versions=run.configuration.versions or {},
            input_references=run.configuration.input_references or {},
            owner_id=run.configuration.owner_id,
            project_id=run.configuration.project_id,
            confirmation_audit_id=run.configuration.confirmation_audit_id,
            confirmed_at=run.configuration.confirmed_at,
        )
        if run.configuration is not None
        else None
    )
    return RunRead(
        id=run.id,
        protein_id=run.protein_id,
        status=run.status,
        requested_variants=run.requested_variants or [],
        configuration=configuration,
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
            selectinload(Run.configuration),
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
    idempotency_key: str | None = None,
    settings: Settings | None = None,
) -> Run:
    """Confirm and persist one independent run configuration.

    The active-run slot is deliberately checked independently from the
    idempotency table: a new explicit request is a concurrency-policy conflict
    while a technical retry resolves the already-created run.
    """

    settings = settings or get_settings()
    policy_settings = get_settings()
    normalized_idempotency_key = idempotency_key.strip() if idempotency_key else None
    if normalized_idempotency_key and len(normalized_idempotency_key) > 255:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Idempotency-Key is too long",
        )
    request_hash = _run_request_hash(payload)

    def resolve_existing_idempotency() -> Run | None:
        if not normalized_idempotency_key:
            return None
        existing_key = session.scalar(
            select(RunIdempotencyKey)
            .where(RunIdempotencyKey.owner_id == principal.user_id)
            .where(RunIdempotencyKey.project_id == principal.project_id)
            .where(RunIdempotencyKey.idempotency_key == normalized_idempotency_key)
        )
        if existing_key is None:
            return None
        if existing_key.request_hash != request_hash:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "message": "Idempotency-Key was already used for another run request",
                    "code": "idempotency_key_conflict",
                },
            )
        existing_run = session.get(Run, existing_key.run_id)
        if existing_run is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Idempotency-Key points to an unavailable run",
            )
        return get_owned_run(session, existing_run.id, principal)

    existing = resolve_existing_idempotency()
    if existing is not None:
        return existing

    max_cpu = max((stage.cpu or 1 for stage in STAGE_DEFINITIONS), default=1)
    max_gpu = max((stage.gpu or 0 for stage in STAGE_DEFINITIONS), default=0)
    if (
        max_cpu > policy_settings.hpc_pipeline_cpu_budget
        or max_gpu > policy_settings.hpc_pipeline_gpu_budget
    ):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="configured HPC budget cannot execute the registered pipeline",
        )
    active_slot = session.scalar(
        select(ActiveRunSlot).where(ActiveRunSlot.owner_id == principal.user_id).with_for_update()
    )
    # A concurrent first request may have committed while this transaction
    # waited for the slot row. Resolve the retry before applying the policy.
    existing = resolve_existing_idempotency()
    if existing is not None:
        return existing
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
        by_id = {upload.id: upload for upload in uploads}
        if len(by_id) != len(payload.upload_ids):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found")
        uploads = [by_id[upload_id] for upload_id in payload.upload_ids]
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
    fasta_upload = next((upload for upload in uploads if upload.input_type == "fasta"), None)
    structure_upload = next(
        (upload for upload in uploads if upload.input_type == "structure"),
        None,
    )
    structure_source = payload.structure_source or (
        "provided_pdb" if structure_upload is not None else "alphafold3"
    )

    try:
        fasta_sha256: str | None = None
        if fasta_upload is not None:
            fasta_content = read_verified_upload(settings, fasta_upload)
            normalized_fasta = normalize_sequence(
                fasta_content.decode("utf-8"),
                max_length=settings.max_sequence_length,
            )
            if normalized_fasta.sequence != protein.sequence:
                raise ConfigurationValidationError(
                    "FASTA upload does not match the selected canonical protein sequence"
                )
            fasta_sha256 = fasta_upload.sha256

        if structure_source == "provided_pdb" and structure_upload is None:
            raise ConfigurationValidationError(
                "provided_pdb requires an attached PDB or structure upload"
            )

        structure_mapping = empty_structure_mapping(protein.length)
        structure_chain: str | None = None
        structure_sha256: str | None = None
        if structure_upload is not None:
            structure_content = read_verified_upload(settings, structure_upload)
            inspection = inspect_structure(
                structure_content,
                protein.sequence,
                filename=structure_upload.original_filename,
                requested_chain=payload.structure_chain,
            )
            structure_mapping = inspection.mapping
            structure_chain = inspection.chain or None
            structure_sha256 = structure_upload.sha256

        scientific_accession = resolve_accession(protein, payload.scientific_accession)
        if settings.hpc_execution_mode in {"ssh", "native"} and scientific_accession is None:
            raise ConfigurationValidationError(
                "a UniProt accession is required before remote execution can be confirmed"
            )
        try:
            scientific_parameters = json.loads(
                json.dumps(payload.scientific_parameters, ensure_ascii=False, sort_keys=True)
            )
        except (TypeError, ValueError) as exc:
            raise ConfigurationValidationError(
                "scientific_parameters must be JSON-serializable"
            ) from exc
        if not isinstance(scientific_parameters, dict):
            raise ConfigurationValidationError("scientific_parameters must be an object")
        available_requirements = _available_technical_requirements(settings, scientific_parameters)
        selection = resolve_stage_selection(
            structure_source=structure_source,
            has_structure=structure_upload is not None,
            variants=requested_variants,
            scientific_accession=scientific_accession,
            scientific_parameters=scientific_parameters,
            available_technical_requirements=available_requirements,
        )
    except (ConfigurationValidationError, UnicodeDecodeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc

    omitted_stages = list(selection.omitted_stages)
    omitted_reasons = omission_by_stage(omitted_stages)
    versions = _configuration_versions(scientific_parameters)
    input_references = {
        "protein": {
            "protein_id": protein.id,
            "sequence_sha256": protein.sequence_sha256,
            "length": protein.length,
        },
        "fasta": (
            {
                "upload_id": fasta_upload.id,
                "filename": fasta_upload.original_filename,
                "sha256": fasta_upload.sha256,
                "size": fasta_upload.size,
            }
            if fasta_upload is not None
            else None
        ),
        "structure": (
            {
                "upload_id": structure_upload.id,
                "filename": structure_upload.original_filename,
                "sha256": structure_upload.sha256,
                "size": structure_upload.size,
                "chain": structure_chain,
            }
            if structure_upload is not None
            else None
        ),
    }
    run = Run(
        protein_id=protein.id,
        owner_id=principal.user_id,
        project_id=principal.project_id,
        status=RunStatus.PENDING,
        requested_variants=requested_variants,
    )
    for definition in STAGE_DEFINITIONS:
        omitted_reason = omitted_reasons.get(definition.id)
        initial_status = RunStageStatus.SKIPPED if omitted_reason else RunStageStatus.PENDING
        if not definition.dependencies and initial_status == RunStageStatus.PENDING:
            initial_status = RunStageStatus.READY
        run.stages.append(
            RunStage(
                stage_id=definition.id,
                status=initial_status,
                omission_reason=omitted_reason,
            )
        )
    run.configuration = RunConfiguration(
        protein_id=protein.id,
        sequence_sha256=protein.sequence_sha256,
        scientific_accession=scientific_accession,
        fasta_upload_id=fasta_upload.id if fasta_upload is not None else None,
        fasta_sha256=fasta_sha256,
        structure_upload_id=structure_upload.id if structure_upload is not None else None,
        structure_source=structure_source,
        structure_sha256=structure_sha256,
        structure_chain=structure_chain,
        structure_mapping=structure_mapping,
        normalized_variants=requested_variants,
        selected_stage_ids=list(selection.selected_stage_ids),
        omitted_stages=omitted_stages,
        scientific_parameters=scientific_parameters,
        prerequisites=selection.prerequisites,
        versions=versions,
        input_references=input_references,
        owner_id=principal.user_id,
        project_id=principal.project_id,
    )
    session.add(run)
    try:
        session.flush()
        for upload in uploads:
            upload.run_id = run.id
        session.add(ActiveRunSlot(owner_id=principal.user_id, run_id=run.id))
        audit_event = record_audit(
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
                "structure_source": structure_source,
                "selected_stage_count": len(selection.selected_stage_ids),
                "omitted_stage_count": len(omitted_stages),
            },
        )
        session.flush()
        run.configuration.confirmation_audit_id = audit_event.id
        if normalized_idempotency_key:
            session.add(
                RunIdempotencyKey(
                    owner_id=principal.user_id,
                    project_id=principal.project_id,
                    idempotency_key=normalized_idempotency_key,
                    request_hash=request_hash,
                    run_id=run.id,
                )
            )
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        existing = resolve_existing_idempotency()
        if existing is not None:
            return existing
        slot = session.scalar(
            select(ActiveRunSlot).where(ActiveRunSlot.owner_id == principal.user_id)
        )
        existing_run = session.get(Run, slot.run_id) if slot is not None else None
        raise _active_run_conflict(existing_run) from exc
    session.refresh(run)
    return get_owned_run(session, run.id, principal)


def _run_request_hash(payload: RunCreate) -> str:
    """Hash only normalized request intent, never upload bytes or secrets."""

    encoded = json.dumps(
        payload.model_dump(mode="json"),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


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
