"""Inventory and idempotent import for the verified MN5 variant campaign."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
from collections import defaultdict
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from types import SimpleNamespace

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.features.auth.models import User
from app.features.auth.service import normalize_email, record_audit
from app.features.proteins.models import Protein, ProteinIdentifier, ProteinProjectAccess
from app.features.proteins.service import normalize_sequence
from app.features.runs.manifest import (
    ManifestError,
    normalize_remote_manifest_paths,
    validate_remote_manifest,
)
from app.features.runs.mn5_tracking import (
    _external_run_status,
    _is_reference_sequence_context,
    _json_depth_within_limit,
    _manifest_artifact_path,
    _manifest_path_for,
    _remote_run_status,
    _remote_stage_ids,
    _remote_stage_statuses,
    _verify_ddg_variant_export,
)
from app.features.runs.models import (
    ExternalRunTracking,
    Run,
    RunConfiguration,
    RunStage,
)
from app.features.runs.schemas import VariantRequest
from app.features.runs.state import RunStageStatus, RunStatus
from app.features.stages.registry import STAGE_BY_ID, STAGE_DEFINITIONS
from app.infrastructure.hpc.readonly import (
    InspectionError,
    ReadOnlyMN5Inspector,
    build_read_only_inspector,
    validate_relative_path,
)

CAMPAIGN_SINCE = "20261025"
CAMPAIGN_SOURCE = "mn5"
CAMPAIGN_SPECS: dict[str, tuple[str, int]] = {
    "Q8NBP7": ("PCSK9", 41),
    "Q9Y6L6": ("SLCO1B1", 31),
    "Q9UNQ0": ("ABCG2", 22),
    "P08684": ("CYP3A4", 21),
    "P04035": ("HMGCR", 10),
    "Q8WTV0": ("SCARB1", 10),
    "P11712": ("CYP2C9", 1),
    "P22309": ("UGT1A1", 0),
}
EXPECTED_TYPE_COUNTS = {"ddg": 136, "mutant": 136, "base": 1}
BASE_LINEAGE_SPECS: dict[str, tuple[str, str]] = {
    "P02649_eddd8b84fbb0": ("P02649", "APOE"),
    "P11712_3f891626b668": ("P11712", "CYP2C9"),
    "P01130_36a68c551082": ("P01130", "LDLR"),
    "P04035_53ca26e9a4ee": ("P04035", "HMGCR"),
    "P08183_e104bd094247": ("P08183", "ABCB1"),
    "P08684_d98b2269ed52": ("P08684", "CYP3A4"),
    "P22309_b358b3e91c29": ("P22309", "UGT1A1"),
    "Q8NBP7_7d9bc2cd32c4": ("Q8NBP7", "PCSK9"),
    "Q8NBP7_dbe397769c53": ("Q8NBP7", "PCSK9"),
    "Q8WTV0_208605b98a84": ("Q8WTV0", "SCARB1"),
    "Q9UNQ0_30326c2220d9": ("Q9UNQ0", "ABCG2"),
    "Q9Y6L6_63cd6e3ebdd9": ("Q9Y6L6", "SLCO1B1"),
}
_RUN_TIMESTAMP = re.compile(r"_(?P<date>\d{8})T(?P<time>\d{12})Z$")
_VARIANT = re.compile(
    r"^(?P<ref>[ACDEFGHIKLMNPQRSTVWY])(?P<pos>[1-9]\d*)(?P<alt>[ACDEFGHIKLMNPQRSTVWY])$"
)


class CampaignImportError(ValueError):
    """The source inventory or destination persistence boundary is invalid."""


@dataclass(frozen=True, slots=True)
class Candidate:
    accession: str
    run_type: str
    variant: str | None
    remote_run_id: str
    remote_path: str
    sequence: str
    base_sequence: str
    context: dict[str, object]
    stage_ids: tuple[str, ...]
    score: tuple[int, int, int, str]


@dataclass(frozen=True, slots=True)
class CampaignInventory:
    report: dict[str, object]
    selected: tuple[Candidate, ...]

    @property
    def ready(self) -> bool:
        return bool(self.report.get("ready_to_apply"))


def _date_in_run_id(run_id: str) -> str | None:
    match = _RUN_TIMESTAMP.search(run_id)
    return match.group("date") if match else None


def _sequence(data: dict[str, object], keys: tuple[str, ...], settings: Settings) -> str | None:
    for key in keys:
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            try:
                return normalize_sequence(value, max_length=settings.max_sequence_length).sequence
            except ValueError:
                return None
    return None


def _nested_gene_symbol(value: object) -> set[str]:
    symbols: set[str] = set()
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).lower() in {"gene_symbol", "gene"} and isinstance(item, str):
                cleaned = item.strip().upper()
                if cleaned:
                    symbols.add(cleaned)
            else:
                symbols.update(_nested_gene_symbol(item))
    elif isinstance(value, list):
        for item in value:
            symbols.update(_nested_gene_symbol(item))
    return symbols


def _variants_from_context(context: dict[str, object]) -> tuple[str | None, str | None]:
    reference = context.get("reference_sequence")
    query = context.get("query_sequence") or context.get("sequence")
    if not isinstance(reference, str) or not isinstance(query, str):
        return None, None
    differences = [
        (position, ref, alt)
        for position, (ref, alt) in enumerate(zip(reference, query, strict=False), start=1)
        if ref != alt
    ]
    if len(reference) != len(query) or len(differences) != 1:
        return None, None
    position, ref, alt = differences[0]
    return f"{ref}{position}{alt}", reference


def _variant_from_explicit_fields(context: dict[str, object]) -> str | None:
    ref = context.get("variant_ref")
    position = context.get("variant_position")
    alt = context.get("variant_alt")
    if not isinstance(ref, str) or not isinstance(alt, str):
        return None
    try:
        parsed = VariantRequest(aa_ref=ref, aa_position=int(position), aa_alt=alt)
    except (TypeError, ValueError):
        return None
    return f"{parsed.aa_ref}{parsed.aa_position}{parsed.aa_alt}"


def _subsequence_covers_position(query: str, target: str, position: int) -> bool:
    """Check an exact chain subsequence while requiring the DDG site to map."""

    if not query or len(query) > len(target) or position < 1 or position > len(target):
        return False
    prefix_length = 0
    for residue in target[: position - 1]:
        if prefix_length < len(query) and query[prefix_length] == residue:
            prefix_length += 1
    suffix_start = len(query)
    for residue in reversed(target[position:]):
        if suffix_start and query[suffix_start - 1] == residue:
            suffix_start -= 1
    site_residue = target[position - 1]
    return any(
        residue == site_residue and query_index <= prefix_length and query_index + 1 >= suffix_start
        for query_index, residue in enumerate(query)
    )


def _ddg_query_sequence_relation(query: str, reference: str, variant: str) -> str | None:
    """Classify full-length DDG inputs while allowing structure-derived queries.

    Some verified MN5 contexts use an exact shorter structure chain as
    query_sequence while retaining the full canonical sequence in
    reference_sequence. Accept that only when it maps as an exact subsequence
    and includes the declared DDG site. For full-length queries, accept only
    the base or its exact substitution.
    """

    if query == reference:
        return "base"
    match = _VARIANT.fullmatch(variant)
    if match is None:
        return None
    position = int(match.group("pos"))
    if position > len(reference) or reference[position - 1] != match.group("ref"):
        return None
    expected_variant = reference[: position - 1] + match.group("alt") + reference[position:]
    if query == expected_variant:
        return "declared_variant"
    if _subsequence_covers_position(query, reference, position):
        return "structure_derived_base"
    if _subsequence_covers_position(query, expected_variant, position):
        return "structure_derived_variant"
    return None


def _job_ids(value: object) -> set[str]:
    result: set[str] = set()
    if isinstance(value, dict):
        for key, child in value.items():
            normalized_key = str(key).lower()
            if normalized_key in {"job_id", "slurm_job_id", "scheduler_job_id", "remote_job_id"}:
                candidate = str(child).strip() if child is not None else ""
                if candidate.isdigit():
                    result.add(candidate)
            elif normalized_key in {"job_ids", "remote_job_ids"} and isinstance(child, list):
                result.update(str(item).strip() for item in child if str(item).strip().isdigit())
            else:
                result.update(_job_ids(child))
    elif isinstance(value, list):
        for child in value:
            result.update(_job_ids(child))
    return result


def _publication_paths(value: object, remote_root: str) -> set[str]:
    paths: set[str] = set()
    if isinstance(value, dict):
        for child in value.values():
            paths.update(_publication_paths(child, remote_root))
    elif isinstance(value, list):
        for child in value:
            paths.update(_publication_paths(child, remote_root))
    elif isinstance(value, str):
        root = remote_root.rstrip("/") + "/"
        if value.startswith(root):
            relative = value[len(root) :]
            try:
                paths.add(str(validate_relative_path(relative)))
            except InspectionError:
                pass
    return paths


def _published_result_paths(context: dict[str, object], remote_root: str) -> set[str]:
    """Return stage result paths, excluding input and preparation references."""

    stage_results = context.get("stage_results")
    if not isinstance(stage_results, dict):
        return set()
    return _publication_paths(stage_results, remote_root)


def _stage_snapshot_evidence(context: dict[str, object], remote_root: str) -> dict[str, object]:
    input_state = context.get("input_state")
    input_state = input_state if isinstance(input_state, dict) else {}
    input_statuses = input_state.get("stage_status")
    input_statuses = input_statuses if isinstance(input_statuses, dict) else {}
    top_level_statuses = context.get("stage_status")
    top_level_statuses = top_level_statuses if isinstance(top_level_statuses, dict) else {}
    stage_results = context.get("stage_results")
    stage_results = stage_results if isinstance(stage_results, dict) else {}
    run_status = input_state.get("run_status")
    run_status_text = str(run_status).strip() if run_status is not None else ""
    job_ids = sorted(_job_ids(context))
    stage_ids = list(_stage_ids(context))
    stage_result_ids = sorted(str(stage_id) for stage_id in stage_results)
    stage_results_present = bool(context.get("stage_results"))
    stage_status_ids = sorted(
        {str(stage_id) for stage_id in input_statuses}
        | {str(stage_id) for stage_id in top_level_statuses}
    )
    stage_status_present = bool(input_state.get("stage_status")) or bool(
        context.get("stage_status")
    )
    declared_stage_ids: set[str] = set()
    for raw_ids in (context.get("stage_ids"), input_state.get("stage_ids")):
        if isinstance(raw_ids, dict):
            declared_stage_ids.update(str(stage_id) for stage_id in raw_ids)
        elif isinstance(raw_ids, (list, tuple, set)):
            declared_stage_ids.update(str(stage_id) for stage_id in raw_ids)
    published_paths = sorted(_published_result_paths(context, remote_root))
    job_reference_present = _has_job_reference(context)
    return {
        "remote_job_ids": job_ids,
        "job_reference_present": job_reference_present,
        "stage_ids": stage_ids,
        "declared_stage_ids": sorted(declared_stage_ids),
        "stage_result_ids": stage_result_ids,
        "stage_results_present": stage_results_present,
        "stage_status_ids": stage_status_ids,
        "stage_status_present": stage_status_present,
        "run_status": run_status_text or None,
        "published_paths": published_paths,
        "has_execution_evidence": bool(
            job_ids
            or job_reference_present
            or stage_ids
            or declared_stage_ids
            or stage_result_ids
            or stage_results_present
            or stage_status_ids
            or stage_status_present
            or run_status_text
            or published_paths
        ),
    }


def _has_job_reference(value: object) -> bool:
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).lower() in {
                "job_id",
                "slurm_job_id",
                "scheduler_job_id",
                "remote_job_id",
                "job_ids",
                "remote_job_ids",
            }:
                if child is not None and str(child).strip():
                    return True
            if _has_job_reference(child):
                return True
    elif isinstance(value, list):
        return any(_has_job_reference(child) for child in value)
    return False


_SCAFFOLD_DIRECTORIES = {"logs", "stages", "orchestration", "generated"}
_SCAFFOLD_EMPTY_DIRECTORIES = {"logs", "stages", "generated"}
_SCAFFOLD_REQUIRED_FILES = {"coordinate_mapping.tsv", "scaffold.tsv"}
_SCAFFOLD_OPTIONAL_FILES = {
    "pharmacogenomics_resource_lock.json",
    "unmapped_pdb_residues.tsv",
}


def _classify_contextless_scaffold(
    inspector: ReadOnlyMN5Inspector, remote_path: str
) -> dict[str, object] | None:
    """Recognize only the two observed pre-execution directory scaffolds."""

    context_path = f"{remote_path}/run_context.json"
    if inspector.inspect_kind(context_path) != "missing":
        return None
    entries = inspector.list(remote_path)
    top_level = {PurePosixPath(item.path).name: item for item in entries}
    if set(top_level) != _SCAFFOLD_DIRECTORIES or any(
        not item.is_directory for item in top_level.values()
    ):
        return None

    empty_entries: dict[str, list[str]] = {}
    for directory in sorted(_SCAFFOLD_EMPTY_DIRECTORIES):
        children = inspector.list(f"{remote_path}/{directory}")
        if children:
            return None
        empty_entries[directory] = []

    orchestration = inspector.list(f"{remote_path}/orchestration")
    orchestration_files = {PurePosixPath(item.path).name: item for item in orchestration}
    allowed_files = _SCAFFOLD_REQUIRED_FILES | _SCAFFOLD_OPTIONAL_FILES
    names = set(orchestration_files)
    if not _SCAFFOLD_REQUIRED_FILES.issubset(names) or names - allowed_files:
        return None
    if any(
        item.is_directory or inspector.inspect_kind(item.path) != "file"
        for item in orchestration_files.values()
    ):
        return None

    return {
        "classification": "preexecution_scaffold",
        "evidence": {
            "run_context": "missing",
            "top_level_directories": sorted(top_level),
            "empty_directories": empty_entries,
            "orchestration_files": sorted(names),
        },
    }


def _stage_ids(context: dict[str, object]) -> tuple[str, ...]:
    return _remote_stage_ids(context)


def _status_rank(context: dict[str, object], run_type: str) -> int:
    input_state = context.get("input_state")
    input_state = input_state if isinstance(input_state, dict) else {}
    run_status = str(input_state.get("run_status") or "").lower()
    if run_status == "success":
        rank = 4
    elif run_status in {"running", "partial_running"}:
        rank = 3
    elif run_status in {"pending", "queued"}:
        rank = 2
    elif run_status in {"failed", "partial_failed"}:
        rank = 1
    else:
        rank = 0
    if run_type == "ddg":
        statuses = input_state.get("stage_status")
        ddg_status = (
            str(statuses.get("variant_ddg", "")).lower() if isinstance(statuses, dict) else ""
        )
        if ddg_status == "success":
            rank += 4
        elif ddg_status in {"running", "queued"}:
            rank += 3
        elif ddg_status == "failed":
            rank += 1
    return rank


def _read_group(
    settings: Settings,
    inspector_factory: Callable[[Settings], ReadOnlyMN5Inspector],
    paths: list[str],
) -> dict[str, bytes | None]:
    try:
        inspector = inspector_factory(settings)
        read_many = getattr(inspector, "read_many_previews", None)
        if callable(read_many):
            return read_many(paths, settings.mn5_max_preview_bytes)
        result: dict[str, bytes | None] = {}
        for path in paths:
            try:
                result[path] = inspector.read_preview(path, settings.mn5_max_preview_bytes)
            except (InspectionError, OSError):
                result[path] = None
        return result
    except (InspectionError, OSError, ValueError):
        return {path: None for path in paths}


def _verify_ddg_candidate_results(
    candidates: list[Candidate],
    settings: Settings,
    inspector_factory: Callable[[Settings], ReadOnlyMN5Inspector],
) -> tuple[dict[str, str], list[dict[str, object]]]:
    """Verify successful P07 publications against each run's declared variant."""

    statuses: dict[str, str] = {}
    issues: list[dict[str, object]] = []
    jobs: list[dict[str, object]] = []
    for candidate in candidates:
        if candidate.run_type != "ddg":
            continue
        stage_status = _remote_stage_statuses(candidate.context).get("variant_ddg")
        if stage_status not in {RunStageStatus.SUCCESS, RunStageStatus.REUSED}:
            statuses[candidate.remote_run_id] = "pending"
            continue
        stage_results = candidate.context.get("stage_results")
        result = stage_results.get("variant_ddg") if isinstance(stage_results, dict) else None
        cache_key = result.get("cache_key") if isinstance(result, dict) else None
        if not isinstance(cache_key, str) or not re.fullmatch(r"[0-9a-f]{64}", cache_key):
            statuses[candidate.remote_run_id] = "unavailable"
            issues.append(
                {
                    "code": "ddg_result_manifest_unavailable",
                    "accession": candidate.accession,
                    "variant": candidate.variant,
                    "remote_run_id": candidate.remote_run_id,
                }
            )
            continue
        try:
            result_dir, manifest_path = _manifest_path_for(
                candidate.context, "variant_ddg", cache_key, settings
            )
        except (InspectionError, ValueError):
            statuses[candidate.remote_run_id] = "unavailable"
            issues.append(
                {
                    "code": "ddg_result_manifest_unavailable",
                    "accession": candidate.accession,
                    "variant": candidate.variant,
                    "remote_run_id": candidate.remote_run_id,
                }
            )
            continue
        jobs.append(
            {
                "candidate": candidate,
                "cache_key": cache_key,
                "result_dir": result_dir,
                "manifest_path": manifest_path,
            }
        )

    manifest_paths = [str(job["manifest_path"]) for job in jobs]
    group_size = 48
    groups = [
        manifest_paths[index : index + group_size]
        for index in range(0, len(manifest_paths), group_size)
    ]
    manifests: dict[str, bytes | None] = {}
    with ThreadPoolExecutor(
        max_workers=min(settings.mn5_external_sync_parallelism, max(1, len(groups)))
    ) as pool:
        for result in pool.map(
            lambda paths: _read_group(settings, inspector_factory, paths), groups
        ):
            manifests.update(result)

    artifact_jobs: list[dict[str, object]] = []
    for job in jobs:
        candidate = job["candidate"]
        manifest_path = str(job["manifest_path"])
        try:
            payload = manifests.get(manifest_path)
            manifest = json.loads(payload) if payload is not None else None
            if not isinstance(manifest, dict):
                raise ManifestError("result manifest is unavailable")
            if not _json_depth_within_limit(manifest):
                raise ManifestError("result manifest nesting is too deep")
            normalized = normalize_remote_manifest_paths(manifest, settings.mn5_root)
            validate_remote_manifest(
                normalized,
                "variant_ddg",
                annotations_required=bool(STAGE_BY_ID["variant_ddg"].produced_annotations),
            )
            if normalized.get("cache_key") != job["cache_key"]:
                raise ManifestError("result manifest cache key changed")
            artifacts = normalized.get("artifacts")
            entry = artifacts.get("variant_annotations") if isinstance(artifacts, dict) else None
            if not isinstance(entry, dict):
                raise ManifestError("variant annotations are absent")
            size = entry.get("size")
            sha256 = entry.get("sha256")
            artifact_path = entry.get("path")
            if (
                not isinstance(size, int)
                or isinstance(size, bool)
                or size > settings.mn5_max_preview_bytes
                or not isinstance(sha256, str)
                or not isinstance(artifact_path, str)
            ):
                raise ManifestError("variant annotation integrity is unavailable")
            remote_path = _manifest_artifact_path(
                artifact_path,
                external=entry.get("external") is True,
                stage_id="variant_ddg",
                cache_key=str(job["cache_key"]),
                result_dir=str(job["result_dir"]),
                remote_run_id=candidate.remote_run_id,
                artifact_type="variant_annotations",
            )
            artifact_jobs.append(
                {**job, "artifact_path": remote_path, "size": size, "sha256": sha256}
            )
        except (
            UnicodeDecodeError,
            json.JSONDecodeError,
            RecursionError,
            ManifestError,
            InspectionError,
            ValueError,
        ):
            statuses[candidate.remote_run_id] = "unavailable"
            issues.append(
                {
                    "code": "ddg_result_manifest_invalid",
                    "accession": candidate.accession,
                    "variant": candidate.variant,
                    "remote_run_id": candidate.remote_run_id,
                }
            )

    artifact_paths = [str(job["artifact_path"]) for job in artifact_jobs]
    groups = [
        artifact_paths[index : index + group_size]
        for index in range(0, len(artifact_paths), group_size)
    ]
    artifacts: dict[str, bytes | None] = {}
    with ThreadPoolExecutor(
        max_workers=min(settings.mn5_external_sync_parallelism, max(1, len(groups)))
    ) as pool:
        for result in pool.map(
            lambda paths: _read_group(settings, inspector_factory, paths), groups
        ):
            artifacts.update(result)

    for job in artifact_jobs:
        candidate = job["candidate"]
        payload = artifacts.get(str(job["artifact_path"]))
        valid = (
            payload is not None
            and len(payload) == job["size"]
            and hashlib.sha256(payload).hexdigest() == job["sha256"]
            and _verify_ddg_variant_export(
                SimpleNamespace(
                    run_type="ddg",
                    accession=candidate.accession,
                    variant=candidate.variant,
                ),
                payload,
            )
        )
        statuses[candidate.remote_run_id] = "verified" if valid else "mismatch"
        if not valid:
            issues.append(
                {
                    "code": "ddg_result_variant_mismatch",
                    "accession": candidate.accession,
                    "variant": candidate.variant,
                    "remote_run_id": candidate.remote_run_id,
                }
            )
    return statuses, issues


def scan_campaign_inventory(
    settings: Settings | None = None,
    *,
    since: str = CAMPAIGN_SINCE,
    inspector_factory: Callable[[Settings], ReadOnlyMN5Inspector] | None = None,
) -> CampaignInventory:
    """Build the bounded, read-only inventory and reconcile expected variant counts."""

    settings = settings or get_settings()
    factory = inspector_factory or build_read_only_inspector
    if not re.fullmatch(r"\d{8}", since):
        raise CampaignImportError("since must use YYYYMMDD")
    try:
        inspector = factory(settings)
        entries = inspector.list("runs")
    except (InspectionError, OSError, ValueError) as exc:
        raise CampaignImportError("MN5 run inventory is unavailable") from exc

    remote_dirs = [
        item.path
        for item in entries
        if item.is_directory
        and any(item.path.startswith(f"runs/{accession}_") for accession in CAMPAIGN_SPECS)
        and (_date_in_run_id(PurePosixPath(item.path).name) or "00000000") >= since
    ]
    context_paths = [f"{remote_path}/run_context.json" for remote_path in remote_dirs]
    parallelism = min(settings.mn5_external_sync_parallelism, max(1, len(context_paths)))
    group_size = 48
    groups = [
        context_paths[index : index + group_size]
        for index in range(0, len(context_paths), group_size)
    ]
    loaded: dict[str, bytes | None] = {}
    with ThreadPoolExecutor(max_workers=parallelism) as pool:
        for result in pool.map(lambda paths: _read_group(settings, factory, paths), groups):
            loaded.update(result)

    issues: list[dict[str, object]] = []
    candidates: dict[tuple[str, str, str | None], list[Candidate]] = defaultdict(list)
    base_sequences: dict[str, set[str]] = defaultdict(set)
    context_count_by_accession: dict[str, int] = defaultdict(int)
    unreadable_by_accession: dict[str, int] = defaultdict(int)
    stage_snapshot_contexts: list[dict[str, object]] = []
    preexecution_scaffolds: list[dict[str, object]] = []
    ddg_query_relations: dict[str, str] = {}

    for remote_path in remote_dirs:
        remote_run_id = PurePosixPath(remote_path).name
        accession = remote_run_id.split("_", 1)[0]
        context_path = f"{remote_path}/run_context.json"
        payload = loaded.get(context_path)
        context_count_by_accession[accession] += 1
        if payload is None:
            unreadable_by_accession[accession] += 1
            scaffold = None
            try:
                scaffold = _classify_contextless_scaffold(inspector, remote_path)
            except (InspectionError, OSError, ValueError):
                # Failure to prove the exact scaffold leaves this record unresolved.
                pass
            issue: dict[str, object] = {
                "code": "remote_context_unreadable",
                "accession": accession,
                "remote_run_id": remote_run_id,
            }
            if scaffold:
                issue.update(scaffold)
                preexecution_scaffolds.append(
                    {
                        "accession": accession,
                        "remote_run_id": remote_run_id,
                        **scaffold,
                    }
                )
            issues.append(issue)
            continue
        try:
            context = json.loads(payload)
        except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
            issues.append(
                {
                    "code": "remote_context_invalid",
                    "accession": accession,
                    "remote_run_id": remote_run_id,
                }
            )
            continue
        if (
            not isinstance(context, dict)
            or not _json_depth_within_limit(context)
            or context.get("run_id") != remote_run_id
        ):
            issues.append(
                {
                    "code": "remote_run_identity_mismatch",
                    "accession": accession,
                    "remote_run_id": remote_run_id,
                }
            )
            continue
        declared_accession = str(context.get("uniprot_accession") or accession).strip()
        if declared_accession != accession:
            issues.append(
                {
                    "code": "accession_mismatch",
                    "accession": accession,
                    "declared_accession": declared_accession,
                    "remote_run_id": remote_run_id,
                }
            )
            continue
        reference = _sequence(context, ("reference_sequence", "sequence"), settings)
        query = _sequence(context, ("query_sequence", "sequence"), settings)
        if not reference or not query:
            issues.append(
                {
                    "code": "sequence_unavailable",
                    "accession": accession,
                    "remote_run_id": remote_run_id,
                }
            )
            continue
        context_ref_sha = context.get("reference_sequence_sha256")
        context_query_sha = context.get("query_sequence_sha256") or context.get("sequence_sha256")
        ref_sha = hashlib.sha256(reference.encode("ascii")).hexdigest()
        query_sha = hashlib.sha256(query.encode("ascii")).hexdigest()
        if context_ref_sha and context_ref_sha != ref_sha:
            issues.append(
                {
                    "code": "reference_sequence_hash_mismatch",
                    "accession": accession,
                    "remote_run_id": remote_run_id,
                }
            )
            continue
        if context_query_sha and context_query_sha != query_sha:
            issues.append(
                {
                    "code": "query_sequence_hash_mismatch",
                    "accession": accession,
                    "remote_run_id": remote_run_id,
                }
            )
            continue
        base_sequences[accession].add(reference)
        genes = _nested_gene_symbol(context.get("identity_resources"))
        genes.update(_nested_gene_symbol(context.get("identity")))
        expected_gene = CAMPAIGN_SPECS[accession][0]
        if genes and genes != {expected_gene}:
            issues.append(
                {
                    "code": "gene_identity_mismatch",
                    "accession": accession,
                    "genes": sorted(genes),
                    "remote_run_id": remote_run_id,
                }
            )
            continue

        explicit_variant = _variant_from_explicit_fields(context)
        sequence_variant, sequence_reference = _variants_from_context(context)
        stage_ids = _stage_ids(context)
        has_ddg_publication = "variant_ddg" in stage_ids

        run_type: str | None = None
        variant: str | None = None
        sequence = query
        candidate_base = reference
        if has_ddg_publication:
            if explicit_variant is None:
                issues.append(
                    {
                        "code": "ddg_identity_mismatch",
                        "accession": accession,
                        "remote_run_id": remote_run_id,
                    }
                )
                continue
            variant = explicit_variant
            run_type = "ddg"
            sequence = reference
            query_relation = _ddg_query_sequence_relation(query, reference, variant)
            if query_relation is None:
                issues.append(
                    {
                        "code": "ddg_query_variant_mismatch",
                        "accession": accession,
                        "variant": variant,
                        "remote_run_id": remote_run_id,
                    }
                )
                continue
            ddg_query_relations[remote_run_id] = query_relation
        elif sequence_variant:
            if explicit_variant and explicit_variant != sequence_variant:
                issues.append(
                    {
                        "code": "mutant_variant_mismatch",
                        "accession": accession,
                        "remote_run_id": remote_run_id,
                    }
                )
                continue
            variant = sequence_variant
            run_type = "mutant"
            candidate_base = sequence_reference or reference
            sequence = query
        elif accession == "P22309" and explicit_variant is None and stage_ids:
            run_type = "base"
            variant = None
            # Preserve the actual query sequence for a real no-variant run.
            # The accession's reference remains a separate grouping identity.
            sequence = query
            if query != reference:
                issues.append(
                    {
                        "code": "base_query_sequence_differs",
                        "accession": accession,
                        "remote_run_id": remote_run_id,
                        "reference_sequence_sha256": ref_sha,
                        "query_sequence_sha256": query_sha,
                    }
                )
        if run_type is None:
            continue
        if len(candidate_base) != len(reference) or candidate_base != reference:
            issues.append(
                {
                    "code": "base_sequence_mismatch",
                    "accession": accession,
                    "remote_run_id": remote_run_id,
                }
            )
            continue
        for mutation in [variant] if variant else []:
            match = _VARIANT.fullmatch(mutation)
            if not match or int(match.group("pos")) > len(reference):
                issues.append(
                    {
                        "code": "variant_out_of_range",
                        "accession": accession,
                        "variant": mutation,
                        "remote_run_id": remote_run_id,
                    }
                )
                variant = None
                run_type = None
                break
            if reference[int(match.group("pos")) - 1] != match.group("ref"):
                issues.append(
                    {
                        "code": "variant_reference_mismatch",
                        "accession": accession,
                        "variant": mutation,
                        "remote_run_id": remote_run_id,
                    }
                )
                variant = None
                run_type = None
                break
            if run_type == "mutant":
                expected_sequence = (
                    reference[: int(match.group("pos")) - 1]
                    + match.group("alt")
                    + reference[int(match.group("pos")) :]
                )
                if query != expected_sequence:
                    issues.append(
                        {
                            "code": "mutant_sequence_mismatch",
                            "accession": accession,
                            "variant": mutation,
                            "remote_run_id": remote_run_id,
                        }
                    )
                    variant = None
                    run_type = None
                    break
        if run_type is None:
            continue
        stage_statuses = _remote_stage_statuses(context)
        if not stage_ids:
            evidence = _stage_snapshot_evidence(context, settings.mn5_root)
            snapshot_context = {
                "accession": accession,
                "run_type": run_type,
                "variant": variant,
                "remote_run_id": remote_run_id,
                "sequence_sha256": hashlib.sha256(sequence.encode("ascii")).hexdigest(),
                "base_sequence_sha256": hashlib.sha256(candidate_base.encode("ascii")).hexdigest(),
                "context": context,
                "evidence": evidence,
            }
            stage_snapshot_contexts.append(snapshot_context)
            issues.append(
                {
                    "code": "stage_snapshot_unavailable",
                    "accession": accession,
                    "run_type": run_type,
                    "variant": variant,
                    "remote_run_id": remote_run_id,
                    **{
                        key: value
                        for key, value in evidence.items()
                        if key != "has_execution_evidence"
                    },
                }
            )
            continue
        for stage_id in stage_ids:
            stage_statuses.setdefault(stage_id, RunStageStatus.PENDING)
        timestamp = _date_in_run_id(remote_run_id) or "00000000"
        time_match = _RUN_TIMESTAMP.search(remote_run_id)
        timestamp_key = f"{timestamp}{time_match.group('time') if time_match else ''}"
        score = (
            1
            if run_type == "ddg" and stage_statuses.get("variant_ddg") == RunStageStatus.SUCCESS
            else 0,
            len(stage_ids),
            _status_rank(context, run_type),
            timestamp_key,
        )
        candidates[(accession, run_type, variant)].append(
            Candidate(
                accession=accession,
                run_type=run_type,
                variant=variant,
                remote_run_id=remote_run_id,
                remote_path=remote_path,
                sequence=sequence,
                base_sequence=candidate_base,
                context=context,
                stage_ids=stage_ids,
                score=score,
            )
        )

    selected: list[Candidate] = []
    inventory_runs: list[dict[str, object]] = []
    duplicate_counts: dict[str, dict[str, int]] = {
        accession: {"ddg": 0, "mutant": 0, "base": 0} for accession in CAMPAIGN_SPECS
    }
    for key, records in sorted(candidates.items()):
        accession, run_type, variant = key
        records.sort(key=lambda item: item.score, reverse=True)
        chosen = records[0]
        selected.append(chosen)
        duplicate_counts[accession][run_type] += max(0, len(records) - 1)
        context = chosen.context
        input_state = (
            context.get("input_state") if isinstance(context.get("input_state"), dict) else {}
        )
        raw_stage_statuses = (
            input_state.get("stage_status")
            if isinstance(input_state.get("stage_status"), dict)
            else {}
        )
        published = _published_result_paths(context, settings.mn5_root)
        remote_query = _sequence(context, ("query_sequence", "sequence"), settings)
        inventory_runs.append(
            {
                "accession": accession,
                "gene_symbol": CAMPAIGN_SPECS[accession][0],
                "base_sequence": chosen.base_sequence,
                "base_sequence_sha256": hashlib.sha256(
                    chosen.base_sequence.encode("ascii")
                ).hexdigest(),
                "sequence": chosen.sequence,
                "sequence_sha256": hashlib.sha256(chosen.sequence.encode("ascii")).hexdigest(),
                "remote_query_sequence_sha256": (
                    hashlib.sha256(remote_query.encode("ascii")).hexdigest()
                    if remote_query
                    else None
                ),
                "remote_query_matches_base": (
                    remote_query == chosen.base_sequence if remote_query else None
                ),
                "remote_query_sequence_relation": ddg_query_relations.get(chosen.remote_run_id),
                "variant": variant,
                "run_type": run_type,
                "display_name": _display_name(accession, run_type, variant),
                "remote_run_id": chosen.remote_run_id,
                "remote_path": chosen.remote_path,
                "remote_job_ids": sorted(_job_ids(context)),
                "stage_ids": list(chosen.stage_ids),
                "stage_status": {
                    stage_id: str(status)
                    for stage_id, status in _remote_stage_statuses(context).items()
                },
                "published_paths": sorted(published),
                "duplicate_remote_run_ids": [item.remote_run_id for item in records[1:]],
                "duplicate_attempts": [
                    {
                        "remote_run_id": item.remote_run_id,
                        "remote_path": item.remote_path,
                        "sequence_sha256": hashlib.sha256(
                            item.sequence.encode("ascii")
                        ).hexdigest(),
                        "base_sequence_sha256": hashlib.sha256(
                            item.base_sequence.encode("ascii")
                        ).hexdigest(),
                        "remote_job_ids": sorted(_job_ids(item.context)),
                        "stage_ids": list(item.stage_ids),
                        "stage_status": {
                            stage_id: str(status)
                            for stage_id, status in _remote_stage_statuses(item.context).items()
                        },
                        "published_paths": sorted(
                            _published_result_paths(item.context, settings.mn5_root)
                        ),
                    }
                    for item in records[1:]
                ],
                "snapshot_status": str(input_state.get("run_status") or "unknown"),
                "raw_stage_status_ids": sorted(str(key) for key in raw_stage_statuses),
            }
        )

    unexecuted_contexts: list[dict[str, object]] = []
    for snapshot in stage_snapshot_contexts:
        selected_match = next(
            (
                candidate
                for candidate in selected
                if candidate.accession == snapshot["accession"]
                and candidate.run_type == snapshot["run_type"]
                and candidate.variant == snapshot["variant"]
                and hashlib.sha256(candidate.sequence.encode("ascii")).hexdigest()
                == snapshot["sequence_sha256"]
                and hashlib.sha256(candidate.base_sequence.encode("ascii")).hexdigest()
                == snapshot["base_sequence_sha256"]
            ),
            None,
        )
        evidence = snapshot["evidence"]
        if selected_match is not None and not evidence["has_execution_evidence"]:
            classification = {
                "classification": "same_variant_context_without_execution_snapshot",
                "duplicate_of_remote_run_id": selected_match.remote_run_id,
                "evidence": {
                    "accession": snapshot["accession"],
                    "run_type": snapshot["run_type"],
                    "variant": snapshot["variant"],
                    "sequence_sha256": snapshot["sequence_sha256"],
                    "base_sequence_sha256": snapshot["base_sequence_sha256"],
                    "execution_snapshot": evidence,
                },
            }
            unexecuted_contexts.append(
                {
                    "accession": snapshot["accession"],
                    "run_type": snapshot["run_type"],
                    "variant": snapshot["variant"],
                    "remote_run_id": snapshot["remote_run_id"],
                    **classification,
                }
            )
            for issue in issues:
                if (
                    issue["code"] == "stage_snapshot_unavailable"
                    and issue["remote_run_id"] == snapshot["remote_run_id"]
                ):
                    issue.update(classification)
                    break

    ddg_result_statuses, ddg_result_issues = _verify_ddg_candidate_results(
        selected,
        settings,
        factory,
    )
    issues.extend(ddg_result_issues)
    for item in inventory_runs:
        if item["run_type"] == "ddg":
            result_status = ddg_result_statuses.get(str(item["remote_run_id"]), "pending")
            item["ddg_result_status"] = result_status
            item["ddg_result_verified"] = result_status == "verified"

    issues.extend(
        {
            "code": "base_sequence_disagreement",
            "accession": accession,
            "sequence_hashes": sorted(
                hashlib.sha256(value.encode("ascii")).hexdigest() for value in sequences
            ),
        }
        for accession, sequences in base_sequences.items()
        if len(sequences) > 1
    )
    actual_counts = {
        accession: {
            kind: sum(
                1 for item in selected if item.accession == accession and item.run_type == kind
            )
            for kind in ("ddg", "mutant", "base")
        }
        for accession in CAMPAIGN_SPECS
    }
    variant_sets = {
        accession: {
            kind: {
                item.variant
                for item in selected
                if item.accession == accession and item.run_type == kind and item.variant
            }
            for kind in ("ddg", "mutant")
        }
        for accession in CAMPAIGN_SPECS
    }
    variant_mismatches: list[dict[str, object]] = []
    for accession, sets in variant_sets.items():
        ddg_variants = sets["ddg"]
        mutant_variants = sets["mutant"]
        if ddg_variants != mutant_variants:
            mismatch = {
                "accession": accession,
                "ddg_without_mutant": sorted(ddg_variants - mutant_variants),
                "mutant_without_ddg": sorted(mutant_variants - ddg_variants),
            }
            variant_mismatches.append(mismatch)
            issues.append({"code": "ddg_mutant_variant_set_mismatch", **mismatch})
    blocking_issues = [
        issue
        for issue in issues
        if not (
            issue["code"] == "base_query_sequence_differs"
            or (
                issue["code"] == "remote_context_unreadable"
                and issue.get("classification") == "preexecution_scaffold"
            )
            or (
                issue["code"] == "stage_snapshot_unavailable"
                and issue.get("classification") == "same_variant_context_without_execution_snapshot"
            )
        )
    ]
    expected_counts = {
        accession: {"ddg": count, "mutant": count, "base": 1 if accession == "P22309" else 0}
        for accession, (_, count) in CAMPAIGN_SPECS.items()
    }
    count_mismatches = [
        {
            "accession": accession,
            "expected": expected_counts[accession],
            "actual": actual_counts[accession],
        }
        for accession in CAMPAIGN_SPECS
        if actual_counts[accession] != expected_counts[accession]
    ]
    ready = (
        not count_mismatches and not blocking_issues and len(base_sequences) == len(CAMPAIGN_SPECS)
    )
    report: dict[str, object] = {
        "schema": "mn5-campaign-inventory-v1",
        "source": CAMPAIGN_SOURCE,
        "since": since,
        "created_at": datetime.now(UTC).isoformat(),
        "expected_type_counts": EXPECTED_TYPE_COUNTS,
        "actual_type_counts": {
            kind: sum(values[kind] for values in actual_counts.values())
            for kind in ("ddg", "mutant", "base")
        },
        "expected_by_accession": expected_counts,
        "actual_by_accession": actual_counts,
        "remote_context_count_by_accession": dict(context_count_by_accession),
        "unreadable_context_count_by_accession": dict(unreadable_by_accession),
        "preexecution_scaffold_count": len(preexecution_scaffolds),
        "preexecution_scaffolds": preexecution_scaffolds,
        "unexecuted_context_count": len(unexecuted_contexts),
        "unexecuted_contexts": unexecuted_contexts,
        "deduplicated_attempt_count_by_accession": duplicate_counts,
        "count_mismatches": count_mismatches,
        "variant_set_mismatches": variant_mismatches,
        "issues": issues,
        "ready_to_apply": ready,
        "runs": inventory_runs,
    }
    return CampaignInventory(report=report, selected=tuple(selected))


def scan_base_lineage_inventory(
    settings: Settings | None = None,
    *,
    since: str = CAMPAIGN_SINCE,
    remote_run_ids: list[str] | None = None,
    inspector_factory: Callable[[Settings], ReadOnlyMN5Inspector] | None = None,
) -> CampaignInventory:
    """Inventory only verified reference-sequence runs in the named lineages."""

    settings = settings or get_settings()
    factory = inspector_factory or build_read_only_inspector
    if not re.fullmatch(r"\d{8}", since):
        raise CampaignImportError("since must use YYYYMMDD")
    requested_run_ids = set(remote_run_ids or [])
    if len(requested_run_ids) != len(remote_run_ids or []):
        raise CampaignImportError("remote run IDs must be unique")
    for remote_run_id in requested_run_ids:
        if "/" in remote_run_id or not any(
            remote_run_id.startswith(f"{lineage}_") for lineage in BASE_LINEAGE_SPECS
        ):
            raise CampaignImportError("remote run ID is outside the configured lineages")
    try:
        inspector = factory(settings)
        entries = inspector.list("runs")
    except (InspectionError, OSError, ValueError) as exc:
        raise CampaignImportError("MN5 base-lineage inventory is unavailable") from exc

    remote_dirs_by_lineage: dict[str, list[str]] = {
        lineage: [] for lineage in BASE_LINEAGE_SPECS
    }
    for entry in entries:
        if not entry.is_directory:
            continue
        run_id = PurePosixPath(entry.path).name
        if (_date_in_run_id(run_id) or "00000000") < since:
            continue
        for lineage in BASE_LINEAGE_SPECS:
            if run_id.startswith(f"{lineage}_") and (
                not requested_run_ids or run_id in requested_run_ids
            ):
                remote_dirs_by_lineage[lineage].append(entry.path)
                break

    found_remote_run_ids = {
        PurePosixPath(remote_dir).name
        for remote_dirs in remote_dirs_by_lineage.values()
        for remote_dir in remote_dirs
    }

    context_paths = [
        f"{remote_dir}/run_context.json"
        for remote_dirs in remote_dirs_by_lineage.values()
        for remote_dir in remote_dirs
    ]
    group_size = 24
    groups = [
        context_paths[index : index + group_size]
        for index in range(0, len(context_paths), group_size)
    ]
    loaded: dict[str, bytes | None] = {}
    if groups:
        parallelism = min(settings.mn5_external_sync_parallelism, len(groups))
        with ThreadPoolExecutor(max_workers=parallelism) as pool:
            for result in pool.map(
                lambda paths: _read_base_context_group(settings, factory, paths), groups
            ):
                loaded.update(result)

    candidates_by_lineage: dict[str, list[Candidate]] = defaultdict(list)
    issues: list[dict[str, object]] = []
    unreadable_by_lineage: dict[str, int] = defaultdict(int)
    for lineage, remote_dirs in remote_dirs_by_lineage.items():
        accession, expected_gene = BASE_LINEAGE_SPECS[lineage]
        for remote_dir in remote_dirs:
            remote_run_id = PurePosixPath(remote_dir).name
            context_path = f"{remote_dir}/run_context.json"
            payload = loaded.get(context_path)
            if payload is None:
                unreadable_by_lineage[lineage] += 1
                issues.append(
                    {
                        "code": "remote_context_unreadable",
                        "lineage": lineage,
                        "accession": accession,
                        "remote_run_id": remote_run_id,
                    }
                )
                continue
            try:
                context = json.loads(payload)
            except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
                issues.append(
                    {
                        "code": "remote_context_invalid",
                        "lineage": lineage,
                        "accession": accession,
                        "remote_run_id": remote_run_id,
                    }
                )
                continue
            if (
                not isinstance(context, dict)
                or not _json_depth_within_limit(context)
                or context.get("run_id") != remote_run_id
            ):
                issues.append(
                    {
                        "code": "remote_run_identity_mismatch",
                        "lineage": lineage,
                        "accession": accession,
                        "remote_run_id": remote_run_id,
                    }
                )
                continue
            declared_accession = str(context.get("uniprot_accession") or accession).strip()
            if declared_accession != accession:
                issues.append(
                    {
                        "code": "accession_mismatch",
                        "lineage": lineage,
                        "accession": accession,
                        "declared_accession": declared_accession,
                        "remote_run_id": remote_run_id,
                    }
                )
                continue
            genes = _nested_gene_symbol(context.get("identity_resources"))
            genes.update(_nested_gene_symbol(context.get("identity")))
            if genes and genes != {expected_gene}:
                issues.append(
                    {
                        "code": "gene_identity_mismatch",
                        "lineage": lineage,
                        "accession": accession,
                        "genes": sorted(genes),
                        "expected_gene": expected_gene,
                        "remote_run_id": remote_run_id,
                    }
                )
                continue

            reference = _sequence(context, ("reference_sequence", "sequence"), settings)
            query = _sequence(context, ("query_sequence", "sequence"), settings)
            if not reference or not query:
                issues.append(
                    {
                        "code": "sequence_unavailable",
                        "lineage": lineage,
                        "accession": accession,
                        "remote_run_id": remote_run_id,
                    }
                )
                continue
            reference_hash = hashlib.sha256(reference.encode("ascii")).hexdigest()
            query_hash = hashlib.sha256(query.encode("ascii")).hexdigest()
            context_reference_hash = context.get("reference_sequence_sha256")
            context_query_hash = context.get("query_sequence_sha256") or context.get(
                "sequence_sha256"
            )
            if context_reference_hash and context_reference_hash != reference_hash:
                issues.append(
                    {
                        "code": "reference_sequence_hash_mismatch",
                        "lineage": lineage,
                        "accession": accession,
                        "remote_run_id": remote_run_id,
                    }
                )
                continue
            if context_query_hash and context_query_hash != query_hash:
                issues.append(
                    {
                        "code": "query_sequence_hash_mismatch",
                        "lineage": lineage,
                        "accession": accession,
                        "remote_run_id": remote_run_id,
                    }
                )
                continue

            explicit_variant = _variant_from_explicit_fields(context)
            stage_ids = _stage_ids(context)
            if explicit_variant or "variant_ddg" in stage_ids:
                continue
            is_reference_run = _is_reference_sequence_context(context, query, reference)
            if not is_reference_run or not stage_ids:
                continue

            statuses = _remote_stage_statuses(context)
            success_count = sum(
                1
                for stage_id in stage_ids
                if statuses.get(stage_id) in {RunStageStatus.SUCCESS, RunStageStatus.REUSED}
            )
            timestamp_match = _RUN_TIMESTAMP.search(remote_run_id)
            timestamp_key = (
                f"{timestamp_match.group('date')}{timestamp_match.group('time')}"
                if timestamp_match
                else "00000000"
            )
            candidates_by_lineage[lineage].append(
                Candidate(
                    accession=accession,
                    run_type="base",
                    variant=None,
                    remote_run_id=remote_run_id,
                    remote_path=remote_dir,
                    sequence=query,
                    base_sequence=reference,
                    context=context,
                    stage_ids=stage_ids,
                    score=(
                        success_count,
                        len(stage_ids),
                        _status_rank(context, "base"),
                        timestamp_key,
                    ),
                )
            )

    selected: list[Candidate] = []
    runs: list[dict[str, object]] = []
    missing_lineages: list[str] = []
    base_sequences_by_accession: dict[str, set[str]] = defaultdict(set)
    for lineage, (accession, gene_symbol) in BASE_LINEAGE_SPECS.items():
        records = candidates_by_lineage[lineage]
        records.sort(key=lambda candidate: candidate.score, reverse=True)
        if not records:
            missing_lineages.append(lineage)
            continue
        candidate = records[0]
        selected.append(candidate)
        base_sequences_by_accession[accession].add(candidate.base_sequence)
        stage_statuses = _remote_stage_statuses(candidate.context)
        runs.append(
            {
                "lineage": lineage,
                "accession": accession,
                "gene_symbol": gene_symbol,
                "run_type": "base",
                "display_name": accession,
                "remote_run_id": candidate.remote_run_id,
                "remote_path": candidate.remote_path,
                "sequence_sha256": hashlib.sha256(
                    candidate.sequence.encode("ascii")
                ).hexdigest(),
                "base_sequence_sha256": hashlib.sha256(
                    candidate.base_sequence.encode("ascii")
                ).hexdigest(),
                "query_matches_reference": candidate.sequence == candidate.base_sequence,
                "remote_run_status": _remote_run_status(candidate.context),
                "stage_ids": list(candidate.stage_ids),
                "stage_status": {
                    stage_id: str(status) for stage_id, status in stage_statuses.items()
                },
                "successful_stage_count": sum(
                    1
                    for stage_id in candidate.stage_ids
                    if stage_statuses.get(stage_id)
                    in {RunStageStatus.SUCCESS, RunStageStatus.REUSED}
                ),
                "published_paths": sorted(
                    _published_result_paths(candidate.context, settings.mn5_root)
                ),
                "duplicate_remote_run_ids": [item.remote_run_id for item in records[1:]],
                "candidate_count": len(records),
            }
        )

    accepted_base_run_ids = {
        candidate.remote_run_id
        for candidates in candidates_by_lineage.values()
        for candidate in candidates
    }
    for remote_run_id in sorted(requested_run_ids - found_remote_run_ids):
        issues.append(
            {"code": "requested_remote_run_missing", "remote_run_id": remote_run_id}
        )
    for remote_run_id in sorted(found_remote_run_ids - accepted_base_run_ids):
        if remote_run_id in requested_run_ids:
            issues.append(
                {"code": "requested_remote_run_not_a_base", "remote_run_id": remote_run_id}
            )

    issues.extend(
        {
            "code": "base_sequence_disagreement",
            "accession": accession,
            "sequence_hashes": sorted(
                hashlib.sha256(sequence.encode("ascii")).hexdigest() for sequence in sequences
            ),
        }
        for accession, sequences in base_sequences_by_accession.items()
        if len(sequences) > 1
    )
    blocking_codes = {
        "remote_context_invalid",
        "remote_run_identity_mismatch",
        "accession_mismatch",
        "gene_identity_mismatch",
        "sequence_unavailable",
        "reference_sequence_hash_mismatch",
        "query_sequence_hash_mismatch",
        "base_sequence_disagreement",
        "requested_remote_run_missing",
        "requested_remote_run_not_a_base",
    }
    blocking_issues = [issue for issue in issues if issue["code"] in blocking_codes]
    report: dict[str, object] = {
        "schema": "mn5-base-lineage-inventory-v1",
        "source": CAMPAIGN_SOURCE,
        "since": since,
        "requested_remote_run_ids": sorted(requested_run_ids),
        "created_at": datetime.now(UTC).isoformat(),
        "expected_lineage_count": len(BASE_LINEAGE_SPECS),
        "selected_lineage_count": len(selected),
        "missing_lineages": missing_lineages,
        "remote_context_count_by_lineage": {
            lineage: len(remote_dirs_by_lineage[lineage]) for lineage in BASE_LINEAGE_SPECS
        },
        "unreadable_context_count_by_lineage": dict(unreadable_by_lineage),
        "issues": issues,
        "blocking_issues": blocking_issues,
        "ready_to_apply": bool(selected) and not blocking_issues,
        "runs": runs,
    }
    return CampaignInventory(report=report, selected=tuple(selected))


def _read_base_context_group(
    settings: Settings,
    inspector_factory: Callable[[Settings], ReadOnlyMN5Inspector],
    paths: list[str],
) -> dict[str, bytes | None]:
    try:
        inspector = inspector_factory(settings)
        read_many = getattr(inspector, "read_many_previews", None)
        if callable(read_many):
            limit = min(
                1024 * 1024,
                max(settings.mn5_max_preview_bytes, settings.mn5_max_artifact_bytes),
            )
            return read_many(paths, limit)
        return {
            path: inspector.read_preview(path, settings.mn5_max_preview_bytes)
            for path in paths
        }
    except (InspectionError, OSError, ValueError):
        return {path: None for path in paths}


def _display_name(accession: str, run_type: str, variant: str | None) -> str:
    if run_type == "mutant" and variant:
        return f"{accession}-{variant}"
    if run_type == "ddg" and variant:
        return f"DDG · {accession} · {variant}"
    return accession


def write_inventory(report: dict[str, object], destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8")
    descriptor, temp_name = tempfile.mkstemp(prefix=".mn5-inventory-", dir=destination.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, destination)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise
    return destination


def _base_protein_for(
    session: Session,
    sequence: str,
    accession: str,
    gene_symbol: str,
    *,
    user_id: str,
    project_id: str,
    settings: Settings,
) -> Protein:
    normalized = normalize_sequence(sequence, max_length=settings.max_sequence_length)
    protein = session.scalar(
        select(Protein).where(Protein.sequence_sha256 == normalized.sequence_sha256)
    )
    if protein is None:
        protein = Protein(
            sequence_sha256=normalized.sequence_sha256,
            sequence=normalized.sequence,
            length=len(normalized.sequence),
            owner_id=user_id,
            project_id=project_id,
        )
        session.add(protein)
        session.flush()
    access = session.get(ProteinProjectAccess, (protein.id, project_id))
    if access is None:
        session.add(ProteinProjectAccess(protein_id=protein.id, project_id=project_id))
    for source, identifier in (("uniprot", accession), ("gene", gene_symbol)):
        existing = session.scalar(
            select(ProteinIdentifier).where(
                ProteinIdentifier.source == source,
                ProteinIdentifier.identifier == identifier,
            )
        )
        if existing is not None and existing.protein_id != protein.id:
            if source == "uniprot" and any(
                item.source == "fasta_header"
                and re.search(
                    rf"(?:^|[>\s])(?:sp|tr)\|{re.escape(identifier)}\|",
                    item.identifier,
                    flags=re.IGNORECASE,
                )
                for item in protein.identifiers
            ):
                continue
            raise CampaignImportError(
                f"identity conflict for {accession}: {source} alias points to another sequence"
            )
        if existing is None:
            session.add(
                ProteinIdentifier(protein_id=protein.id, source=source, identifier=identifier)
            )
    return protein


def _mutation_protein_for(
    session: Session,
    sequence: str,
    display_name: str | None,
    *,
    user_id: str,
    project_id: str,
    settings: Settings,
) -> Protein:
    normalized = normalize_sequence(sequence, max_length=settings.max_sequence_length)
    protein = session.scalar(
        select(Protein).where(Protein.sequence_sha256 == normalized.sequence_sha256)
    )
    if protein is None:
        protein = Protein(
            sequence_sha256=normalized.sequence_sha256,
            sequence=normalized.sequence,
            length=len(normalized.sequence),
            owner_id=user_id,
            project_id=project_id,
        )
        session.add(protein)
        session.flush()
    if session.get(ProteinProjectAccess, (protein.id, project_id)) is None:
        session.add(ProteinProjectAccess(protein_id=protein.id, project_id=project_id))
    if display_name is not None:
        existing = session.scalar(
            select(ProteinIdentifier).where(
                ProteinIdentifier.source == "external_variant",
                ProteinIdentifier.identifier == display_name,
            )
        )
        if existing is not None and existing.protein_id != protein.id:
            raise CampaignImportError(f"mutant label conflict: {display_name}")
        if existing is None:
            session.add(
                ProteinIdentifier(
                    protein_id=protein.id, source="external_variant", identifier=display_name
                )
            )
    return protein


def _overall_status(
    stage_statuses: dict[str, RunStageStatus],
    selected: list[str],
    remote_status: str | None = None,
) -> str:
    return _external_run_status(stage_statuses, selected, remote_status)


def _persist_candidate(
    session: Session,
    candidate: Candidate,
    base_protein: Protein,
    user: User,
    *,
    settings: Settings,
    now: datetime,
) -> tuple[Run, bool]:
    tracking = session.scalar(
        select(ExternalRunTracking).where(
            ExternalRunTracking.source == CAMPAIGN_SOURCE,
            ExternalRunTracking.remote_run_id == candidate.remote_run_id,
        )
    )
    display_name = _display_name(candidate.accession, candidate.run_type, candidate.variant)
    run_protein = base_protein
    if candidate.run_type == "mutant" or (
        candidate.run_type == "base" and candidate.sequence != candidate.base_sequence
    ):
        run_protein = _mutation_protein_for(
            session,
            candidate.sequence,
            display_name if candidate.run_type == "mutant" else None,
            user_id=user.id,
            project_id=user.project_id,
            settings=settings,
        )
    if tracking is not None:
        run = tracking.run
        if run.owner_id != user.id or run.project_id != user.project_id:
            raise CampaignImportError("remote execution is already associated with another account")
        if run.protein_id != run_protein.id:
            raise CampaignImportError("remote execution changed its sequence identity")
        created = False
    else:
        run = Run(
            protein_id=run_protein.id,
            owner_id=user.id,
            project_id=user.project_id,
            remote_job_id=None,
            is_external_import=True,
            requested_variants=(
                [
                    {
                        "aa_ref": candidate.variant[0],
                        "aa_position": int(candidate.variant[1:-1]),
                        "aa_alt": candidate.variant[-1],
                    }
                ]
                if candidate.variant
                else []
            ),
        )
        session.add(run)
        session.flush()
        created = True

    stage_statuses = _remote_stage_statuses(candidate.context)
    stage_ids = [stage.id for stage in STAGE_DEFINITIONS if stage.id in candidate.stage_ids]
    if not stage_ids:
        raise CampaignImportError(f"stage inventory is incomplete for {candidate.remote_run_id}")
    for stage_id in stage_ids:
        stage_statuses.setdefault(stage_id, RunStageStatus.PENDING)
    for stage_id in stage_ids:
        remote_stage_result = (candidate.context.get("stage_results") or {}).get(stage_id)
        cache_key = (
            remote_stage_result.get("cache_key") if isinstance(remote_stage_result, dict) else None
        )
        stage = next((item for item in run.stages if item.stage_id == stage_id), None)
        if stage is None:
            stage = RunStage(
                stage_id=stage_id,
                status=stage_statuses[stage_id],
                cache_key=cache_key if isinstance(cache_key, str) else None,
                error_code="external_stage_failed"
                if stage_statuses[stage_id] == RunStageStatus.FAILED
                else None,
            )
            run.stages.append(stage)
        else:
            stage.status = stage_statuses[stage_id]
            stage.cache_key = cache_key if isinstance(cache_key, str) else stage.cache_key
        # This importer has no verified MN5 stage timestamps. Do not persist
        # the local import time as if it were the remote execution time.
        stage.started_at = None
        stage.finished_at = None
    run.is_external_import = True
    run.remote_job_id = None
    run.status = _overall_status(stage_statuses, stage_ids, _remote_run_status(candidate.context))
    run.error_code = "external_stage_failed" if run.status == RunStatus.FAILED else None
    run.error_message = None
    run.started_at = None
    run.finished_at = None
    has_unpublished_results = any(
        stage_statuses[stage_id] in {RunStageStatus.SUCCESS, RunStageStatus.REUSED}
        for stage_id in stage_ids
    )
    next_sync_at = (
        now
        if run.status in {RunStatus.PENDING, RunStatus.RUNNING} or has_unpublished_results
        else None
    )

    config = run.configuration
    run_sequence_sha = normalize_sequence(
        candidate.sequence, max_length=settings.max_sequence_length
    ).sequence_sha256
    variant_value = (
        [
            {
                "aa_ref": candidate.variant[0],
                "aa_position": int(candidate.variant[1:-1]),
                "aa_alt": candidate.variant[-1],
            }
        ]
        if candidate.variant
        else []
    )
    selected_sequence_stages = list(stage_ids)
    if config is None:
        config = RunConfiguration(
            run_id=run.id,
            protein_id=run_protein.id,
            sequence_sha256=run_sequence_sha,
            scientific_accession=candidate.accession,
            structure_source="alphafold3",
            structure_chain="A",
            structure_mapping={},
            normalized_variants=variant_value,
            selected_stage_ids=selected_sequence_stages,
            omitted_stages=[],
            scientific_parameters={
                "import_source": "mn5_campaign",
                "external_run_type": candidate.run_type,
                "external_run_id": candidate.remote_run_id,
                "protein_base_accession": candidate.accession,
                "variant": candidate.variant,
            },
            prerequisites={},
            versions={"source": "MN5", "tracking": "read_only_sftp"},
            input_references={},
            owner_id=user.id,
            project_id=user.project_id,
        )
        run.configuration = config
    else:
        if config.sequence_sha256 != run_sequence_sha:
            raise CampaignImportError(
                "external run configuration sequence does not match inventory"
            )
        config.selected_stage_ids = selected_sequence_stages
        config.normalized_variants = variant_value

    if tracking is None:
        tracking = ExternalRunTracking(
            run_id=run.id,
            source=CAMPAIGN_SOURCE,
            remote_run_id=candidate.remote_run_id,
            remote_path=candidate.remote_path,
            run_type=candidate.run_type,
            base_protein_id=base_protein.id,
            accession=candidate.accession,
            variant=candidate.variant,
            display_name=display_name,
            published_cache_keys={},
            last_synced_at=now,
            last_attempt_at=now,
            connection_status="connected",
            next_sync_at=next_sync_at,
        )
        run.external_tracking = tracking
    else:
        tracking.remote_path = candidate.remote_path
        tracking.run_type = candidate.run_type
        tracking.base_protein_id = base_protein.id
        tracking.accession = candidate.accession
        tracking.variant = candidate.variant
        tracking.display_name = display_name
        tracking.last_synced_at = now
        tracking.last_attempt_at = now
        tracking.connection_status = "connected"
        tracking.sync_error_code = None
        tracking.next_sync_at = next_sync_at
    return run, created


def apply_campaign_inventory(
    session: Session,
    inventory: CampaignInventory,
    email: str,
    *,
    settings: Settings | None = None,
) -> dict[str, int]:
    """Attach a reconciled campaign to exactly one account and project."""

    settings = settings or get_settings()
    if not inventory.ready:
        raise CampaignImportError(
            "campaign inventory does not reconcile; no database changes were made"
        )
    normalized_email = normalize_email(email)
    user = session.scalar(select(User).where(User.email == normalized_email))
    if user is None or not user.is_active or not user.project_id:
        raise CampaignImportError("target account or its project is unavailable")

    bases: dict[str, Protein] = {}
    for accession, (gene_symbol, _) in CAMPAIGN_SPECS.items():
        candidate = next((item for item in inventory.selected if item.accession == accession), None)
        if candidate is None:
            raise CampaignImportError(f"base sequence is unavailable for {accession}")
        hashes = {item.base_sequence for item in inventory.selected if item.accession == accession}
        if len(hashes) != 1:
            raise CampaignImportError(f"base sequence is inconsistent for {accession}")
        bases[accession] = _base_protein_for(
            session,
            candidate.base_sequence,
            accession,
            gene_symbol,
            user_id=user.id,
            project_id=user.project_id,
            settings=settings,
        )

    now = datetime.now(UTC)
    counts = {"created": 0, "updated": 0}
    for candidate in inventory.selected:
        _, created = _persist_candidate(
            session,
            candidate,
            bases[candidate.accession],
            user,
            settings=settings,
            now=now,
        )
        counts["created" if created else "updated"] += 1
    record_audit(
        session,
        action="mn5_campaign_import",
        actor_user_id=user.id,
        client_ip=None,
        resource_type="mn5_campaign",
        resource_id="variant-campaign-20261025",
        details={
            "source": CAMPAIGN_SOURCE,
            "project_id": user.project_id,
            "remote_run_count": len(inventory.selected),
            "created": counts["created"],
            "updated": counts["updated"],
        },
    )
    session.flush()
    return counts


def apply_base_lineage_inventory(
    session: Session,
    inventory: CampaignInventory,
    email: str,
    *,
    settings: Settings | None = None,
) -> dict[str, int]:
    """Attach verified reference-sequence executions without importing variants."""

    settings = settings or get_settings()
    if not inventory.ready:
        raise CampaignImportError(
            "base-lineage inventory contains identity or sequence conflicts; no changes were made"
        )
    normalized_email = normalize_email(email)
    user = session.scalar(select(User).where(User.email == normalized_email))
    if user is None or not user.is_active or not user.project_id:
        raise CampaignImportError("target account or its project is unavailable")

    bases: dict[str, Protein] = {}
    sequences: dict[str, str] = {}
    for candidate in inventory.selected:
        lineage = next(
            (
                name
                for name in BASE_LINEAGE_SPECS
                if candidate.remote_run_id.startswith(f"{name}_")
            ),
            None,
        )
        if lineage is None:
            raise CampaignImportError("selected remote run is outside the configured lineages")
        accession, gene_symbol = BASE_LINEAGE_SPECS[lineage]
        existing_sequence = sequences.get(accession)
        if existing_sequence is not None and existing_sequence != candidate.base_sequence:
            raise CampaignImportError(f"base sequence is inconsistent for {accession}")
        sequences[accession] = candidate.base_sequence
        if accession not in bases:
            bases[accession] = _base_protein_for(
                session,
                candidate.base_sequence,
                accession,
                gene_symbol,
                user_id=user.id,
                project_id=user.project_id,
                settings=settings,
            )

    now = datetime.now(UTC)
    counts = {"created": 0, "updated": 0}
    for candidate in inventory.selected:
        base_protein = bases.get(candidate.accession)
        if base_protein is None:
            raise CampaignImportError(f"base sequence is unavailable for {candidate.accession}")
        _, created = _persist_candidate(
            session,
            candidate,
            base_protein,
            user,
            settings=settings,
            now=now,
        )
        counts["created" if created else "updated"] += 1
    record_audit(
        session,
        action="mn5_base_lineage_import",
        actor_user_id=user.id,
        client_ip=None,
        resource_type="mn5_base_lineages",
        resource_id="protein-base-lineages-20261025",
        details={
            "source": CAMPAIGN_SOURCE,
            "project_id": user.project_id,
            "remote_run_count": len(inventory.selected),
            "created": counts["created"],
            "updated": counts["updated"],
            "missing_lineages": inventory.report.get("missing_lineages", []),
        },
    )
    session.flush()
    return counts


def base_lineage_inventory_summary(report: dict[str, object]) -> str:
    runs = report.get("runs") or []
    issues = report.get("issues") or []
    missing = report.get("missing_lineages") or []
    lines = [
        "MN5 protein base inventory "
        f"({report.get('since')}): ready_to_apply={report.get('ready_to_apply')}",
        f"selected={report.get('selected_lineage_count', 0)}/"
        f"{report.get('expected_lineage_count', len(BASE_LINEAGE_SPECS))} "
        f"blocking_issues={len(report.get('blocking_issues') or [])} "
        f"issues={len(issues)}",
    ]
    for item in runs:
        stage_ids = item.get("stage_ids") or []
        stage_statuses = item.get("stage_status") or {}
        successful = item.get("successful_stage_count", 0)
        lines.append(
            f"{item.get('lineage')}: {item.get('remote_run_id')} "
            f"{successful}/{len(stage_ids)} selected stages; "
            f"P17={stage_statuses.get('conformational_ensemble', 'absent')} "
            f"EF={stage_statuses.get('ensemble_frustration', 'absent')}"
        )
    if missing:
        lines.append("missing_lineages=" + ",".join(str(item) for item in missing))
    return "\n".join(lines)


def campaign_inventory_summary(report: dict[str, object]) -> str:
    actual = report.get("actual_type_counts") or {}
    mismatches = report.get("count_mismatches") or []
    issues = report.get("issues") or []
    lines = [
        f"MN5 campaign inventory ({report.get('since')}): "
        f"ready_to_apply={report.get('ready_to_apply')}",
        f"DDG={actual.get('ddg', 0)} mutant={actual.get('mutant', 0)} base={actual.get('base', 0)}",
        f"count_mismatches={len(mismatches)} identity_or_stage_issues={len(issues)}",
    ]
    by_accession = report.get("actual_by_accession") or {}
    for accession, counts in by_accession.items():
        expected = (report.get("expected_by_accession") or {}).get(accession, {})
        lines.append(
            f"{accession}: DDG {counts.get('ddg', 0)}/{expected.get('ddg', 0)}, "
            f"mutantes {counts.get('mutant', 0)}/{expected.get('mutant', 0)}, "
            f"base {counts.get('base', 0)}/{expected.get('base', 0)}"
        )
    return "\n".join(lines)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Import the verified MN5 variant campaign")
    parser.add_argument("--email", required=True, help="target account email")
    parser.add_argument("--since", default=CAMPAIGN_SINCE, help="earliest run date (YYYYMMDD)")
    parser.add_argument("--apply", action="store_true", help="persist after a reconciled preview")
    parser.add_argument(
        "--base-lineages-only",
        action="store_true",
        help="inventory and import only reference-sequence runs in the configured lineages",
    )
    parser.add_argument(
        "--remote-run-id",
        action="append",
        default=[],
        help="restrict a base-lineage preview to this exact MN5 run ID (repeatable)",
    )
    parser.add_argument(
        "--inventory-file",
        type=Path,
        default=None,
        help=(
            "private JSON inventory output path "
            "(default: artifact_root/mn5-campaign/inventory.json)"
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    from app.core.db import SessionLocal

    args = _parser().parse_args(argv)
    settings = get_settings()
    try:
        if args.base_lineages_only:
            inventory = scan_base_lineage_inventory(
                settings,
                since=args.since,
                remote_run_ids=args.remote_run_id,
            )
            summary = base_lineage_inventory_summary(inventory.report)
        else:
            inventory = scan_campaign_inventory(settings, since=args.since)
            summary = campaign_inventory_summary(inventory.report)
        destination = (
            args.inventory_file
            or settings.artifact_root
            / ("mn5-base-lineages" if args.base_lineages_only else "mn5-campaign")
            / "inventory.json"
        )
        write_inventory(inventory.report, destination)
        print(summary)
        print(f"inventory_file={destination}")
        if not args.apply:
            return 0 if inventory.ready else 2
        if not inventory.ready:
            print("Import refused: the inventory must reconcile before applying.")
            return 2
        with SessionLocal() as session:
            try:
                if args.base_lineages_only:
                    counts = apply_base_lineage_inventory(
                        session, inventory, args.email, settings=settings
                    )
                else:
                    counts = apply_campaign_inventory(
                        session, inventory, args.email, settings=settings
                    )
                session.commit()
            except Exception:
                session.rollback()
                raise
        label = "protein base-lineage import" if args.base_lineages_only else "campaign import"
        print(f"{label} applied: created={counts['created']} updated={counts['updated']}")
        return 0
    except (CampaignImportError, InspectionError, OSError, ValueError) as exc:
        print(f"MN5 campaign import failed: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
