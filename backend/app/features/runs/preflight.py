from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import TYPE_CHECKING

from app.core.config import Settings
from app.features.artifacts.storage import ArtifactPathError, ArtifactStore
from app.features.runs.models import RunPreparation, RunStage
from app.features.runs.selection import has_dependency_override
from app.features.runs.state import RunStageStatus
from app.features.stages.registry import STAGE_BY_ID

if TYPE_CHECKING:
    from app.features.runs.models import Run


PREFETCH_REQUIREMENTS = frozenset(
    {
        "external_cache",
        "homology_access_or_cache",
        "mavedb_access_or_cache",
    }
)


class PreflightFailure(RuntimeError):
    """A preparation gate that must be persisted before a stage can submit."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool,
        details: dict[str, object] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.details = details or {}


@dataclass(frozen=True, slots=True)
class StagePreflight:
    stage_id: str
    required_requirements: tuple[str, ...]
    prefetch_requirements: tuple[str, ...]
    missing_prefetch_requirements: tuple[str, ...]
    preparation_key: str


def is_prefetch_requirement(requirement: str) -> bool:
    return requirement in PREFETCH_REQUIREMENTS or requirement.startswith("msa_cache:")


def prefetch_requirements_for_stage(stage_id: str) -> tuple[str, ...]:
    return tuple(
        sorted(
            requirement
            for requirement in STAGE_BY_ID[stage_id].technical_requirements
            if is_prefetch_requirement(requirement)
        )
    )


def preparation_key(run: Run, requirements: tuple[str, ...]) -> str:
    configuration = run.configuration
    if configuration is None:
        raise PreflightFailure(
            "configuration_missing",
            "run has no confirmed scientific configuration",
            retryable=False,
        )
    payload = {
        "schema": "run-preparation-v1",
        "sequence_sha256": configuration.sequence_sha256,
        "scientific_accession": configuration.scientific_accession,
        "requirements": list(requirements),
        "versions": configuration.versions or {},
    }
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _operator_requirements(settings: Settings) -> set[str]:
    available = settings.hpc_available_technical_requirement_set
    if settings.hpc_execution_mode in {"ssh", "native"}:
        available.update({"slurm:SLURM_JOB_ID", "command:srun"})
    return available


def execution_uploads(run: Run):
    """Return only uploads that the confirmed execution may consume.

    A structure attached for provenance must not become an implicit input when
    the confirmed source is AlphaFold 3. The upload remains attached to the
    run, but it is intentionally not transferred or used for an AF3 stage.
    """

    configuration = run.configuration
    if configuration is None:
        return tuple(run.uploads)
    return tuple(
        upload
        for upload in run.uploads
        if upload.input_type != "structure"
        or (
            configuration.structure_source == "provided_pdb"
            and upload.id == configuration.structure_upload_id
        )
    )


def _validate_input_integrity(stage: RunStage, settings: Settings) -> None:
    store = ArtifactStore(settings)
    for upload in execution_uploads(stage.run):
        try:
            size, digest = store.metadata(upload.storage_key)
        except (ArtifactPathError, FileNotFoundError, OSError) as exc:
            raise PreflightFailure(
                "input_unavailable",
                f"stored {upload.input_type} input is unavailable",
                retryable=False,
            ) from exc
        if size != upload.size or digest != upload.sha256:
            raise PreflightFailure(
                "input_integrity_failed",
                f"stored {upload.input_type} input integrity check failed",
                retryable=False,
            )


def inspect_stage_preflight(
    stage: RunStage,
    settings: Settings,
    *,
    check_dependencies: bool = True,
) -> StagePreflight:
    """Validate local intent and return the external requirements still needed.

    This function does not contact HPC and does not mutate the database. It is
    intentionally safe to call before any input transfer or ``sbatch``.
    """

    definition = STAGE_BY_ID.get(stage.stage_id)
    if definition is None:
        raise PreflightFailure(
            "unknown_stage",
            f"stage {stage.stage_id!r} is not in the approved registry",
            retryable=False,
        )
    run = stage.run
    configuration = run.configuration
    if configuration is None:
        raise PreflightFailure(
            "configuration_missing",
            "run has no confirmed scientific configuration",
            retryable=False,
        )
    if stage.stage_id not in set(configuration.selected_stage_ids or []):
        raise PreflightFailure(
            "stage_not_selected",
            f"stage {stage.stage_id} is not selected by the confirmed configuration",
            retryable=False,
        )
    if run.protein_id != configuration.protein_id or run.protein_id != run.protein.id:
        raise PreflightFailure(
            "identity_mismatch",
            "run identity does not match the confirmed protein configuration",
            retryable=False,
        )
    if run.protein.sequence_sha256 != configuration.sequence_sha256:
        raise PreflightFailure(
            "sequence_identity_mismatch",
            "protein sequence hash does not match the confirmed configuration",
            retryable=False,
        )
    if settings.hpc_execution_mode in {"ssh", "native"} and not configuration.scientific_accession:
        raise PreflightFailure(
            "accession_missing",
            "a UniProt accession is required before remote execution",
            retryable=False,
        )
    if configuration.structure_source == "provided_pdb":
        if not configuration.structure_upload_id or not configuration.structure_sha256:
            raise PreflightFailure(
                "structure_input_missing",
                "provided structure configuration is incomplete",
                retryable=False,
            )
        if not (configuration.structure_mapping or {}).get("canonical_to_structure"):
            raise PreflightFailure(
                "structure_mapping_missing",
                "provided structure has no validated canonical mapping",
                retryable=False,
            )
    if definition.requires_variant and not configuration.normalized_variants:
        raise PreflightFailure(
            "variants_missing",
            f"stage {stage.stage_id} requires confirmed variants",
            retryable=False,
        )
    if (definition.cpu or 1) > settings.hpc_pipeline_cpu_budget:
        raise PreflightFailure(
            "cpu_budget_insufficient",
            f"configured CPU budget is below the {stage.stage_id} contract",
            retryable=False,
            details={"required_cpu": definition.cpu or 1},
        )
    if (definition.gpu or 0) > settings.hpc_pipeline_gpu_budget:
        raise PreflightFailure(
            "gpu_budget_insufficient",
            f"configured GPU budget is below the {stage.stage_id} contract",
            retryable=False,
            details={"required_gpu": definition.gpu or 0},
        )
    if check_dependencies:
        dependency_statuses = {item.stage_id: str(item.status) for item in run.stages}
        for dependency_id in definition.dependencies:
            dependency_status = dependency_statuses.get(dependency_id)
            provided_structure_override = (
                configuration.structure_source == "provided_pdb"
                and dependency_id == "structure_modeling"
                and dependency_status == str(RunStageStatus.SKIPPED)
                and has_dependency_override(configuration.prerequisites, dependency_id)
            )
            if (
                dependency_status
                not in {
                    str(RunStageStatus.SUCCESS),
                    str(RunStageStatus.REUSED),
                }
                and not provided_structure_override
            ):
                raise PreflightFailure(
                    "dependency_unavailable",
                    f"stage dependency {dependency_id} has no usable published result",
                    retryable=True,
                    details={"dependency_id": dependency_id, "status": dependency_status},
                )

    _validate_input_integrity(stage, settings)
    requirements = tuple(sorted(definition.technical_requirements))
    operator_requirements = _operator_requirements(settings)
    missing_runtime = tuple(
        sorted(
            requirement
            for requirement in requirements
            if not is_prefetch_requirement(requirement) and requirement not in operator_requirements
        )
    )
    if missing_runtime:
        raise PreflightFailure(
            "technical_prerequisite_missing",
            "an approved runtime prerequisite is not available",
            retryable=True,
            details={"missing_requirements": list(missing_runtime)},
        )

    prefetch_requirements = tuple(
        requirement for requirement in requirements if is_prefetch_requirement(requirement)
    )
    preparation = stage.run.preparation
    satisfied = set(preparation.satisfied_requirements if preparation is not None else [])
    snapshots = preparation.snapshots if preparation is not None else {}
    if not isinstance(snapshots, dict):
        snapshots = {}
    missing_prefetch = tuple(
        requirement
        for requirement in prefetch_requirements
        if requirement not in satisfied or requirement not in snapshots
    )
    key = preparation_key(run, prefetch_requirements)
    return StagePreflight(
        stage_id=stage.stage_id,
        required_requirements=requirements,
        prefetch_requirements=prefetch_requirements,
        missing_prefetch_requirements=missing_prefetch,
        preparation_key=key,
    )


def ensure_preparation_record(
    stage: RunStage,
    requirements: tuple[str, ...],
) -> RunPreparation:
    preparation = stage.run.preparation
    if preparation is None:
        preparation = RunPreparation(run_id=stage.run_id)
        stage.run.preparation = preparation
    current = set(preparation.required_requirements or [])
    current.update(requirements)
    preparation.required_requirements = sorted(current)
    return preparation
