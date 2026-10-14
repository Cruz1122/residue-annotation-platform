from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.features.stages.registry import STAGE_DEFINITIONS, StageDefinition


@dataclass(frozen=True, slots=True)
class StageSelection:
    selected_stage_ids: tuple[str, ...]
    omitted_stages: tuple[dict[str, object], ...]
    prerequisites: dict[str, object]


_NON_SCIENTIFIC_PARAMETERS = frozenset({"log_level", "log_format", "verbosity"})


def resolve_stage_selection(
    *,
    structure_source: str,
    has_structure: bool,
    variants: list[dict[str, object]],
    scientific_accession: str | None,
    scientific_parameters: dict[str, Any],
    available_technical_requirements: set[str] | None = None,
) -> StageSelection:
    """Resolve applicability from the product registry and confirmed inputs.

    The registry remains the dependency graph.  A provided PDB is recorded as
    an explicit input substitution for the AF3-producing node so structural
    descendants remain visible/applicable without inventing a second UI DAG.
    """

    omitted: list[dict[str, object]] = []
    selected: list[str] = []
    dependency_overrides: dict[str, str] = {}
    available_requirements = set(available_technical_requirements or ())
    if structure_source == "provided_pdb":
        dependency_overrides["structure_modeling"] = "provided_pdb_upload"

    for definition in STAGE_DEFINITIONS:
        if definition.id == "structure_modeling" and structure_source == "provided_pdb":
            omitted.append(
                {
                    "stage_id": definition.id,
                    "reason": "provided_pdb_selected",
                    "message": "AlphaFold 3 is omitted because the provided structure is selected",
                    "prerequisites": ["provided_pdb_upload", "structure_mapping"],
                }
            )
            continue
        if (
            definition.id == "conformational_ensemble"
            and structure_source == "provided_pdb"
            and "msa_cache:af3-msa-v1" in definition.technical_requirements
        ):
            omitted.append(
                {
                    "stage_id": definition.id,
                    "reason": "technical_prerequisite_not_provided",
                    "message": (
                        "The provided PDB does not provide the AF3 MSA cache required by this stage"
                    ),
                    "prerequisites": list(definition.technical_requirements),
                }
            )
            continue
        if (definition.requires_variant or definition.id == "variant_ddg") and not variants:
            omitted.append(
                {
                    "stage_id": definition.id,
                    "reason": "variants_not_provided",
                    "message": "No valid variants were confirmed for this run",
                    "prerequisites": ["normalized_variants"],
                }
            )
            continue
        missing_requirements = [
            requirement
            for requirement in definition.technical_requirements
            if requirement not in available_requirements
        ]
        if missing_requirements:
            omitted.append(
                {
                    "stage_id": definition.id,
                    "reason": "technical_prerequisite_not_provided",
                    "message": "A declared technical prerequisite is not available for this run",
                    "prerequisites": missing_requirements,
                }
            )
            continue
        selected.append(definition.id)

    # If a future registry entry depends on an omitted stage without a
    # declared substitution, fail closed and explain the omission rather than
    # leaving a stage that can only fail later in the worker.
    selected_set = set(selected)
    changed = True
    while changed:
        changed = False
        for definition in STAGE_DEFINITIONS:
            if definition.id not in selected_set:
                continue
            missing = [
                dependency
                for dependency in definition.dependencies
                if dependency not in selected_set
            ]
            unresolved = [
                dependency for dependency in missing if dependency not in dependency_overrides
            ]
            if unresolved:
                selected.remove(definition.id)
                omitted.append(
                    {
                        "stage_id": definition.id,
                        "reason": "dependency_not_applicable",
                        "message": "A declared dependency is not applicable for this configuration",
                        "prerequisites": unresolved,
                    }
                )
                selected_set.remove(definition.id)
                changed = True

    return StageSelection(
        selected_stage_ids=tuple(selected),
        omitted_stages=tuple(omitted),
        prerequisites={
            "registry_stage_count": len(STAGE_DEFINITIONS),
            "available_inputs": {
                "protein_sequence": True,
                "provided_structure": has_structure,
                "normalized_variants": bool(variants),
                "scientific_accession": scientific_accession is not None,
            },
            "structure_source": structure_source,
            "dependency_overrides": dependency_overrides,
            "available_technical_requirements": sorted(available_requirements),
            "stage_technical_requirements": {
                definition.id: list(definition.technical_requirements)
                for definition in STAGE_DEFINITIONS
                if definition.technical_requirements
            },
            "scientific_parameters": scientific_parameters,
        },
    )


def omission_by_stage(omitted_stages: list[dict[str, object]]) -> dict[str, str]:
    return {
        str(item["stage_id"]): str(item.get("reason", "not_applicable"))
        for item in omitted_stages
        if item.get("stage_id")
    }


def dependency_is_satisfied(
    *,
    structure_source: str,
    dependency_id: str,
    status: str,
) -> bool:
    if status in {"success", "reused"}:
        return True
    return (
        structure_source == "provided_pdb"
        and dependency_id == "structure_modeling"
        and status == "skipped"
    )


def cache_factors_for_stage(
    stage: StageDefinition,
    *,
    sequence_sha256: str,
    structure_source: str,
    structure_sha256: str | None,
    structure_chain: str | None,
    structure_mapping: dict[str, object],
    normalized_variants: list[dict[str, object]],
    scientific_accession: str | None,
    scientific_parameters: dict[str, Any],
    prerequisites: dict[str, object],
    versions: dict[str, object],
    dependency_cache_keys: dict[str, str],
) -> dict[str, object]:
    """Return the scientific factors that must be visible in a cache plan."""

    factors: dict[str, object] = {
        "schema": "run-configuration-v1",
        "stage_id": stage.id,
        "stage_version": stage.stage_version,
        "sequence_sha256": sequence_sha256,
        "scientific_identity": {"accession": scientific_accession},
        "dependency_cache_keys": dict(sorted(dependency_cache_keys.items())),
        "versions": dict(versions),
        # ``available_inputs`` describes UI-level presence, including an
        # unused PDB attached to an AF3 run. Exclude that transient inventory
        # while retaining declared scientific/external prerequisites.
        "prerequisites": {
            key: value
            for key, value in prerequisites.items()
            if key not in {"available_inputs", "scientific_parameters"}
        },
        "resource_identity": {
            "cpu": stage.cpu or 1,
            "gpu": stage.gpu or 0,
            "network": stage.network,
            "memory_gb": stage.memory_gb,
            "stage_code_sha256": versions.get("stage_code_sha256", stage.stage_version),
            "resource_version": versions.get("resource_version", "registry-default"),
        },
        "scientific_parameters": {
            key: value
            for key, value in scientific_parameters.items()
            if key not in _NON_SCIENTIFIC_PARAMETERS
        },
    }
    if stage.id in {"structure_modeling", "conformational_ensemble", "ensemble_frustration"} or any(
        producer == "structure_modeling" for producer, _ in stage.consumed_artifacts
    ):
        factors["structure"] = {
            "source": structure_source,
            # An attached PDB is provenance for the run even when AF3 was
            # selected, but it is not an input to the AF3 result and must not
            # invalidate that cache identity.
            "sha256": structure_sha256 if structure_source == "provided_pdb" else None,
            "chain": structure_chain if structure_source == "provided_pdb" else None,
            "mapping": structure_mapping if structure_source == "provided_pdb" else {},
        }
    if stage.id == "variant_ddg" or stage.requires_variant:
        factors["normalized_variants"] = normalized_variants
    return factors
