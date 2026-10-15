from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.features.runs.models import RunStage, StageResult
from app.features.runs.preflight import is_prefetch_requirement
from app.features.runs.selection import cache_factors_for_stage
from app.features.stages.registry import STAGE_BY_ID

if TYPE_CHECKING:
    from app.features.artifacts.storage import ArtifactStore
    from app.features.runs.models import RunConfiguration


def expected_artifact_types_for_stage(stage_id: str) -> set[str]:
    """Return the complete local artifact contract for one registry stage."""

    definition = STAGE_BY_ID[stage_id]
    expected = {str(artifact_type) for artifact_type in definition.produced_artifacts}
    if definition.produced_annotations:
        expected.add("annotations")
    return expected


def canonical_cache_key(
    *,
    protein_sha256: str,
    stage_id: str,
    stage_version: str,
    parameters: dict[str, Any],
    resources: dict[str, Any],
    code_sha256: str,
    dependency_cache_keys: dict[str, str] | None = None,
    query_sequence_sha256: str | None = None,
    reference_sequence_sha256: str | None = None,
    contract_version: str | None = None,
    stage_code_sha256: str | None = None,
    resource_identity: dict[str, Any] | None = None,
    scientific_parameters: dict[str, Any] | None = None,
) -> str:
    """Build the versioned scientific cache identity.

    The first six arguments are the original local API. The optional fields
    project it onto the remote ``stage-cache-v2`` contract without forcing
    callers that only have one canonical sequence hash to invent query or
    dependency data. Logging-only knobs are deliberately excluded because
    they do not change scientific outputs.
    """

    ignored_parameters = {"log_level", "log_format", "verbosity"}
    source_parameters = scientific_parameters if scientific_parameters is not None else parameters
    scientific = {
        key: value for key, value in source_parameters.items() if key not in ignored_parameters
    }
    payload = {
        "schema": "stage-cache-v2",
        "contract_version": contract_version or stage_version,
        "stage_code_sha256": stage_code_sha256 or code_sha256,
        "sequence_sha256": protein_sha256,
        "query_sequence_sha256": query_sequence_sha256,
        "reference_sequence_sha256": reference_sequence_sha256,
        "dependency_cache_keys": dependency_cache_keys or {},
        "resource_identity": resource_identity or resources,
        "scientific_parameters": scientific,
        "protein_sha256": protein_sha256,
        "stage_id": stage_id,
    }
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def planned_stage_cache_identity(
    stage: RunStage,
    configuration: RunConfiguration,
    dependency_cache_keys: dict[str, str],
) -> tuple[str, dict[str, object]]:
    """Build the cache identity from the confirmed run configuration.

    This is intentionally callable before a remote submission.  Dependency
    keys are empty only for a root stage; downstream stages are planned after
    their upstream results are linked, so an upstream result key is never
    approximated by protein identity alone.
    """

    definition = STAGE_BY_ID[stage.stage_id]
    versions = _versions_with_verified_preparation(stage, configuration.versions or {})
    factors = cache_factors_for_stage(
        definition,
        sequence_sha256=configuration.sequence_sha256,
        structure_source=configuration.structure_source,
        structure_sha256=configuration.structure_sha256,
        structure_chain=configuration.structure_chain,
        structure_mapping=configuration.structure_mapping or {},
        normalized_variants=configuration.normalized_variants or [],
        scientific_accession=configuration.scientific_accession,
        scientific_parameters=configuration.scientific_parameters or {},
        prerequisites=configuration.prerequisites or {},
        versions=versions,
        dependency_cache_keys=dependency_cache_keys,
    )
    resource_identity = factors["resource_identity"]
    assert isinstance(resource_identity, dict)
    scientific_parameters = factors["scientific_parameters"]
    assert isinstance(scientific_parameters, dict)
    # The complete factor set is nested into the scientific parameters so
    # mapping, source, and variant changes cannot accidentally collide.
    key = canonical_cache_key(
        protein_sha256=configuration.sequence_sha256,
        stage_id=stage.stage_id,
        stage_version=definition.stage_version,
        parameters={"configuration_factors": factors},
        resources=resource_identity,
        code_sha256=str(resource_identity.get("stage_code_sha256", definition.stage_version)),
        dependency_cache_keys=dependency_cache_keys,
        query_sequence_sha256=configuration.sequence_sha256,
        reference_sequence_sha256=(
            configuration.structure_sha256
            if configuration.structure_source == "provided_pdb"
            else None
        ),
        contract_version=str(
            configuration.versions.get("contract_version", "run-configuration-v1")
        ),
        stage_code_sha256=str(resource_identity.get("stage_code_sha256", definition.stage_version)),
        resource_identity=resource_identity,
        scientific_parameters=scientific_parameters | {"configuration_factors": factors},
    )
    return key, factors


def _versions_with_verified_preparation(
    stage: RunStage,
    configured_versions: dict[str, object],
) -> dict[str, object]:
    """Bind verified external snapshots to the immutable cache identity.

    Configuration input may declare the shape of external resources, but it
    cannot prove that this run actually prepared the exact snapshot. The
    durable preparation receipt is therefore folded into ``versions`` only
    after every prefetch requirement has been acknowledged with a snapshot.
    Runs that have not completed preparation retain the pending/unverified
    configuration version and cannot become a cache hit for external stages.
    """

    requirements = tuple(
        sorted(
            requirement
            for requirement in STAGE_BY_ID[stage.stage_id].technical_requirements
            if is_prefetch_requirement(requirement)
        )
    )
    versions = dict(configured_versions)
    if not requirements:
        return versions
    preparation = stage.run.preparation
    if preparation is None:
        return versions
    satisfied = set(preparation.satisfied_requirements or [])
    snapshots = preparation.snapshots if isinstance(preparation.snapshots, dict) else {}
    missing_snapshots = (
        requirement
        for requirement in requirements
        if requirement not in satisfied or requirement not in snapshots
    )
    if any(missing_snapshots):
        return versions
    versions["external_snapshots"] = {
        requirement: snapshots[requirement] for requirement in requirements
    }
    versions["reproducibility_status"] = "external_snapshots_verified"
    return versions


def find_verified_cache_hit(
    session: Session,
    stage: RunStage,
    cache_key: str,
    store: ArtifactStore,
    *,
    require_provenance: bool = False,
    expected_artifact_types: set[str] | None = None,
) -> StageResult | None:
    """Find a same-scope, successful result whose artifacts are intact.

    Pre-submit planning and remote ingestion pass ``require_provenance=True``
    so a result cannot become a scientific hit merely because its database key
    happens to match. The factors and declared artifact set must be complete
    and equal to the stage plan; a missing or approximate manifest is therefore
    a miss and remains eligible for normal execution/publication.
    """

    candidates = session.scalars(
        select(StageResult)
        .options(selectinload(StageResult.artifacts))
        .where(StageResult.protein_id == stage.run.protein_id)
        .where(StageResult.stage_id == stage.stage_id)
        .where(StageResult.status == "success")
        .where(
            (StageResult.owner_id == stage.run.owner_id)
            | (StageResult.project_id == stage.run.project_id)
        )
    )
    for result in candidates:
        if not result.artifacts:
            continue
        provenance = result.provenance if isinstance(result.provenance, dict) else {}
        # The remote pipeline has its own code/resource cache identity. A
        # result may therefore be indexed by the remote key while retaining
        # the locally planned key as an alias for pre-submit reuse. Legacy
        # and offline results continue to match through ``result.cache_key``.
        if result.cache_key != cache_key and provenance.get("platform_cache_key") != cache_key:
            continue
        if require_provenance:
            provenance_cache_key = provenance.get("cache_key")
            if provenance_cache_key != cache_key and provenance_cache_key != result.cache_key:
                continue
            if (
                provenance.get("source") == "mn5-slurm"
                and provenance.get("remote_provenance_verified") is not True
            ):
                continue
            expected_factors = stage.cache_factors if isinstance(stage.cache_factors, dict) else {}
            actual_factors = provenance.get("cache_factors")
            if not expected_factors or not isinstance(actual_factors, dict):
                continue
            if actual_factors != expected_factors:
                continue
            definition = STAGE_BY_ID.get(stage.stage_id)
            if definition is not None and any(
                requirement.startswith(("external_", "homology_", "mavedb_", "msa_cache"))
                for requirement in definition.technical_requirements
            ):
                versions = actual_factors.get("versions")
                if (
                    not isinstance(versions, dict)
                    or not versions.get("external_snapshots")
                    or versions.get("reproducibility_status") != "external_snapshots_verified"
                ):
                    continue
        required_artifacts = provenance.get("required_artifacts")
        available_types = {artifact.artifact_type for artifact in result.artifacts}
        if require_provenance:
            if not isinstance(required_artifacts, list) or not required_artifacts:
                continue
            declared_types = {str(artifact_type) for artifact_type in required_artifacts}
            if declared_types != available_types:
                continue
            if expected_artifact_types is not None and available_types != expected_artifact_types:
                continue
        elif isinstance(required_artifacts, list):
            if not set(map(str, required_artifacts)).issubset(available_types):
                continue
        try:
            if all(
                store.metadata(artifact.storage_key) == (artifact.size, artifact.sha256)
                for artifact in result.artifacts
            ):
                return result
        except (OSError, ValueError):
            continue
    return None
