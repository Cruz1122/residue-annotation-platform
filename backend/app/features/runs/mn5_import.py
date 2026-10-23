"""Import a bounded, verified MN5 result publication into the platform.

This module is intentionally a historical-import adapter, not a second
scientific executor. It validates the contracts that the remote pipeline
published, maps them to the durable run/stage/cache model, and preserves the
published bytes as immutable artifacts. The adapter is idempotent at the
remote-job level and fails closed on sequence, coordinate, cache-key, or
artifact-integrity mismatches.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import mimetypes
import os
import re
import shutil
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import func, insert, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.db import SessionLocal
from app.features.annotations.models import ANNOTATION_TABLES
from app.features.annotations.service import insert_annotation_rows
from app.features.artifacts.storage import ArtifactStore
from app.features.auth.models import User
from app.features.auth.service import normalize_email, record_audit
from app.features.proteins.models import Protein, ProteinIdentifier, ProteinProjectAccess
from app.features.proteins.service import normalize_sequence
from app.features.runs.models import (
    Artifact,
    Run,
    RunConfiguration,
    RunPreparation,
    RunStage,
    StageResult,
)
from app.features.runs.state import RunStageStatus, RunStatus
from app.features.stages.registry import STAGE_BY_ID, STAGE_DEFINITIONS


class Mn5ImportError(ValueError):
    """A source contract or local persistence invariant was not satisfied."""


SessionFactory = Callable[[], Session]

SEQUENCE_SHA256 = "eddd8b84fbb094df0b4067ca1d0b9b137ddaee4f8b3a548fcff5152e92a4dd4b"
SCIENTIFIC_PROTEIN_ID = "P02649"
SCIENTIFIC_GENE = "APOE"
MAX_IMPORTED_ARTIFACT_BYTES = 2_000_000
IMPORT_CONTRACT_VERSION = "mn5-historical-import-v1"

CORE_REMOTE_RUN_ID = "P02649_eddd8b84fbb0_20261018T210041779016Z"
CORE_REMOTE_JOB_ID = "47442432"
CORE_STAGE_KEYS = {
    "protein_identity": "7fcd4e5be83738fd9317f934b976375df47de126d16059022323bc66c705dfbb",
    "clinvar": "b4396939b59cbd6f105187b07a4e52375a6d02f2c531919bad499560a9b72efa",
    "variant_predictors": "d31fd24b73bacdce365cd8416d698132a425c3444b29258c330f92dd4fad6424",
    "pharmacogenomics": "f6bc0898b2006dce07e6e27c6d799f1134129c4f88eb4c6dee721def4f097759",
    "sequence_frustration": "d92b31dea15ff83a4244f940ac0aff905bf4d82124313d7fb2fa72431638253e",
    "uniprot_features": "7bfe5a529ded67041824b563182f02f426bd25d7338d0c5ed00c365a1cb25e1f",
    "evolutionary_conservation": "2e910e2d646d09fde2a32fdc5716ef29aba5a5eb3250abf7a03a722a5c630cf9",
    "functional_region_evidence": (
        "5115660483a04ccc745acfd0fc20854d2fd89fc2001cb467caeb4d1d027240ac"
    ),
    "experimental_variant_evidence": (
        "f5c68c674b7ed5398d1e977ee06a8485a569104130e4bf66564fc8f7cb7c80a6"
    ),
    "membrane_topology": "b9633e6b2920999f53c2ed28ff86a4034d6941e2a145098df6213aacce8c5001",
    "structure_modeling": "ce107ba2d406f4df94252b2e7aeb1cab2150373848516efafc625aa58f464453",
    "conformational_ensemble": "ce79d9cffa823befe17cc40608ac809d6b4032f83422197a45264108f5a6bcaf",
    "structural_regime": "170974a82abf5bb97bc4ba935c695eafbbd7606dff0742635342b61b34ecf4d1",
    "ensemble_frustration": "bbd6526bc9d3434c57ff736f69608e71264ef025476ee8eeb393a46a53da00f7",
    "protein_relaxation_energy": "1836d4902f042aa170f86acf51a9cf2bbba13a186009a39077abd006d965784b",
    "physicochemical_context": "7890fb928c5f31fdb435df150ab3b521b0b0dd64aca4874b9023c41dc9196493",
    "structural_frustration": "f631ecf2c893d8c42e302c7d65d16893397c867c0fbfb232380bdebe05f657bf",
    "structural_contacts": "3cd78dda7f8c3883441ac24359f2232a088808bfe3dc54a2c457824ab609fdcf",
}

DDG_RUNS = (
    {
        "remote_run_id": "P02649_eddd8b84fbb0_20261018T234300711349Z",
        "remote_job_id": "47512680",
        "variant": "R43C",
        "cache_key": "b2c48d3b907ecbfdf51de04599f4e2fc0e40546f5199212edfc022ad42c79b47",
    },
    {
        "remote_run_id": "P02649_eddd8b84fbb0_20261018T235626909555Z",
        "remote_job_id": "47512681",
        "variant": "R154S",
        "cache_key": "6a554c02896e991d987a6384b6b46d4e8986930339ae47cc74f0e293fc18fad3",
    },
    {
        "remote_run_id": "P02649_eddd8b84fbb0_20261018T235627979465Z",
        "remote_job_id": "47512682",
        "variant": "E21K",
        "cache_key": "f0d18906d260b7fed18df3301bc5738ca978dc64399838c56d16891148c3979a",
    },
)

EXPECTED_DDG_STAGE_IDS = {
    "protein_identity",
    "uniprot_features",
    "membrane_topology",
    "structure_modeling",
    "structural_regime",
    "protein_relaxation_energy",
    "variant_ddg",
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _portable(value: object, remote_root: str) -> object:
    """Keep remote provenance useful without persisting an absolute GPFS path."""

    if isinstance(value, dict):
        return {str(key): _portable(item, remote_root) for key, item in value.items()}
    if isinstance(value, list):
        return [_portable(item, remote_root) for item in value]
    if isinstance(value, str):
        root = remote_root.rstrip("/")
        if value == root:
            return "mn5://root"
        if value.startswith(f"{root}/"):
            return f"mn5://{value[len(root) + 1 :]}"
    return value


def _parse_datetime(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise Mn5ImportError(f"fecha remota inválida: {value!r}") from exc
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)


def _run_id_datetime(remote_run_id: str) -> datetime:
    match = re.search(r"_(\d{8}T\d{12}Z)$", remote_run_id)
    if not match:
        raise Mn5ImportError(f"run_id remoto no tiene timestamp reconocible: {remote_run_id}")
    try:
        return datetime.strptime(match.group(1), "%Y%m%dT%H%M%S%fZ").replace(tzinfo=UTC)
    except ValueError as exc:
        raise Mn5ImportError(f"run_id remoto no tiene timestamp válido: {remote_run_id}") from exc


def _load_json(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise Mn5ImportError(f"no se pudo leer JSON: {path.name}") from exc
    if not isinstance(value, dict):
        raise Mn5ImportError(f"el JSON debe ser un objeto: {path.name}")
    return value


def _media_type(path: Path) -> str:
    suffix = path.suffix.lower()
    explicit = {
        ".cif": "chemical/x-cif",
        ".mmcif": "chemical/x-cif",
        ".pdb": "chemical/x-pdb",
        ".tsv": "text/tab-separated-values",
        ".gz": "application/gzip",
        ".npy": "application/octet-stream",
        ".pred": "text/plain",
        ".span": "text/plain",
        ".fasta": "text/plain",
        ".faa": "text/plain",
        ".log": "text/plain",
    }
    return explicit.get(suffix) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def _safe_filename(path: str, fallback: str) -> str:
    candidate = re.sub(r"[^A-Za-z0-9_.-]", "_", Path(path).name or fallback)
    return candidate[:160] or fallback


def _relative_remote_path(path: str, remote_root: str) -> str:
    root = remote_root.rstrip("/")
    if path == root:
        return ""
    if path.startswith(f"{root}/"):
        return path[len(root) + 1 :]
    return path.lstrip("/")


def _stage_directory(source_root: Path, stage_id: str, cache_key: str) -> Path:
    path = (source_root / "results" / stage_id / cache_key).resolve()
    root = source_root.resolve()
    if not path.is_relative_to(root):
        raise Mn5ImportError("la ruta local de un stage escapa del snapshot")
    if not path.is_dir():
        raise Mn5ImportError(f"no existe el directorio local del stage {stage_id}/{cache_key}")
    return path


def _verify_declared_file(path: Path, expected_size: object, expected_sha256: object) -> None:
    if not path.is_file():
        raise Mn5ImportError(f"falta archivo publicado: {path}")
    actual_size = path.stat().st_size
    actual_sha256 = _sha256(path)
    if actual_size != expected_size or actual_sha256 != expected_sha256:
        raise Mn5ImportError(
            f"integridad inválida para {path.name}: "
            f"obtenido {actual_size}/{actual_sha256}, "
            f"esperado {expected_size}/{expected_sha256}"
        )


def _stage_payload(
    source_root: Path,
    stage_id: str,
    cache_key: str,
    remote_root: str,
    *,
    expected_job_id: str,
) -> dict[str, object]:
    stage_dir = _stage_directory(source_root, stage_id, cache_key)
    manifest_path = stage_dir / "result_manifest.json"
    provenance_path = stage_dir / "provenance.json"
    manifest = _load_json(manifest_path)
    provenance = _load_json(provenance_path)
    if manifest.get("schema") != "stage-result-v1":
        raise Mn5ImportError(f"schema de manifiesto no soportado en {stage_id}")
    if manifest.get("stage_id") != stage_id or manifest.get("cache_key") != cache_key:
        raise Mn5ImportError(f"cache key o stage_id inconsistente en {stage_id}")
    if manifest.get("status") != "success":
        raise Mn5ImportError(f"el manifiesto remoto no terminó en success: {stage_id}")
    integrity = manifest.get("file_integrity")
    if not isinstance(integrity, dict):
        raise Mn5ImportError(f"el manifiesto no contiene file_integrity: {stage_id}")
    files = (
        ("annotations", stage_dir / "annotations.tsv"),
        ("provenance.json", provenance_path),
    )
    for name, path in files:
        record = integrity.get(name)
        if not isinstance(record, dict):
            raise Mn5ImportError(f"falta integridad declarada para {name}: {stage_id}")
        _verify_declared_file(path, record.get("size"), record.get("sha256"))
    operational = provenance.get("operational")
    if not isinstance(operational, dict):
        raise Mn5ImportError(f"provenance operacional ausente: {stage_id}")
    source_slurm_job_id = str(operational.get("slurm_job_id") or "").strip()
    if not source_slurm_job_id:
        raise Mn5ImportError(f"provenance sin slurm_job_id: {stage_id}")
    return {
        "stage_id": stage_id,
        "cache_key": cache_key,
        "stage_dir": stage_dir,
        "manifest": manifest,
        "provenance": provenance,
        "operational": operational,
        # ``expected_job_id`` identifies the parent orchestration submitted by
        # the user. A cache hit may legitimately carry the Slurm allocation
        # that originally produced the reusable result, so preserve both IDs.
        "remote_job_id": expected_job_id,
        "source_slurm_job_id": source_slurm_job_id,
        "remote_path": f"results/{stage_id}/{cache_key}",
        "remote_root": remote_root,
    }


def _annotation_rows(payload: dict[str, object], sequence: str) -> list[dict[str, object]]:
    definition = STAGE_BY_ID[str(payload["stage_id"])]
    path = Path(payload["stage_dir"]) / "annotations.tsv"
    accepted_ids = {SCIENTIFIC_PROTEIN_ID}
    rows: list[dict[str, object]] = []
    positions: set[int] = set()
    with path.open("r", encoding="utf-8", newline="") as stream:
        reader = csv.DictReader(stream, delimiter="\t")
        fieldnames = reader.fieldnames or []
        canonical_fields = {"protein_id", "aa_position", "aa_ref"}
        if not canonical_fields.issubset(fieldnames):
            raise Mn5ImportError(f"anotaciones incompletas en {payload['stage_id']}")
        # ``required_annotations`` describes columns consumed from upstream
        # stage results; the remote stage table is only required to publish
        # its own produced columns. Requiring both would reject valid outputs
        # such as functional_region_evidence, which consumes
        # ``uniprot_mapping_status`` but does not repeat it in its table.
        required_fields = set(definition.produced_annotations)
        missing = required_fields.difference(fieldnames)
        if missing:
            raise Mn5ImportError(
                f"faltan columnas declaradas en {payload['stage_id']}: {sorted(missing)}"
            )
        for source_row in reader:
            if not source_row or all(value in {None, ""} for value in source_row.values()):
                continue
            protein_id = str(source_row.get("protein_id", "")).strip()
            if protein_id not in accepted_ids:
                raise Mn5ImportError(f"protein_id remoto inesperado en {payload['stage_id']}")
            try:
                position = int(str(source_row.get("aa_position", "")))
            except ValueError as exc:
                raise Mn5ImportError(f"posición inválida en {payload['stage_id']}") from exc
            aa_ref = str(source_row.get("aa_ref", "")).strip().upper()
            if position < 1 or position > len(sequence) or len(aa_ref) != 1:
                raise Mn5ImportError(f"coordenada inválida en {payload['stage_id']}")
            if sequence[position - 1] != aa_ref:
                raise Mn5ImportError(f"aa_ref no coincide en {payload['stage_id']}:{position}")
            if position in positions:
                raise Mn5ImportError(f"posición duplicada en {payload['stage_id']}:{position}")
            positions.add(position)
            values = {
                key: str(value)
                for key, value in source_row.items()
                if key not in canonical_fields and value not in {None, ""}
            }
            rows.append(
                {
                    "aa_position": position,
                    "aa_ref": aa_ref,
                    "values": values,
                    "units": {},
                    "qc_status": "verified",
                    "source_row": "\t".join(str(source_row.get(field, "")) for field in fieldnames),
                }
            )
    expected_positions = set(range(1, len(sequence) + 1))
    if positions != expected_positions:
        missing = sorted(expected_positions.difference(positions))[:8]
        extra = sorted(positions.difference(expected_positions))[:8]
        raise Mn5ImportError(
            f"cobertura incompleta en {payload['stage_id']}: "
            f"{len(rows)} filas, faltantes={missing}, extra={extra}"
        )
    return rows


def _artifact_source(stage_dir: Path, relative_path: object) -> Path:
    if not isinstance(relative_path, str) or not relative_path.strip():
        raise Mn5ImportError("artefacto sin ruta relativa")
    candidate = Path(relative_path)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise Mn5ImportError("artefacto con ruta insegura")
    resolved = (stage_dir / candidate).resolve()
    if not resolved.is_relative_to(stage_dir.resolve()):
        raise Mn5ImportError("artefacto fuera del directorio del stage")
    return resolved


def _artifact_descriptor(
    payload: dict[str, object],
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    stage_dir = Path(payload["stage_dir"])
    manifest = payload["manifest"]
    assert isinstance(manifest, dict)
    integrity = manifest.get("file_integrity")
    assert isinstance(integrity, dict)
    descriptors: list[dict[str, object]] = []
    skipped: list[dict[str, object]] = []
    annotations_record = integrity.get("annotations")
    if not isinstance(annotations_record, dict):
        raise Mn5ImportError(f"integridad de anotaciones ausente: {payload['stage_id']}")
    descriptors.append(
        {
            "artifact_type": "annotations",
            "path": stage_dir / "annotations.tsv",
            "size": annotations_record.get("size"),
            "sha256": annotations_record.get("sha256"),
        }
    )
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, dict):
        raise Mn5ImportError(f"artifacts ausentes en manifiesto: {payload['stage_id']}")
    for artifact_type, entry in artifacts.items():
        if not isinstance(entry, dict):
            raise Mn5ImportError(f"descriptor de artefacto inválido: {artifact_type}")
        remote_path = entry.get("path")
        size = entry.get("size")
        if entry.get("external") is True:
            skipped.append(
                {"artifact_type": artifact_type, "reason": "external_cache", "path": "external"}
            )
            continue
        if size is None:
            skipped.append(
                {
                    "artifact_type": artifact_type,
                    "reason": "directory_artifact",
                    "path": remote_path,
                }
            )
            continue
        if not isinstance(size, int) or size < 0:
            raise Mn5ImportError(f"tamaño inválido para artefacto {artifact_type}")
        if size > MAX_IMPORTED_ARTIFACT_BYTES:
            skipped.append(
                {
                    "artifact_type": artifact_type,
                    "reason": "bounded_import_limit",
                    "path": remote_path,
                    "size": size,
                }
            )
            continue
        source = _artifact_source(stage_dir, remote_path)
        _verify_declared_file(source, size, entry.get("sha256"))
        descriptors.append(
            {
                "artifact_type": str(artifact_type),
                "path": source,
                "size": size,
                "sha256": entry.get("sha256"),
            }
        )
    return descriptors, skipped


def _artifact_storage_key(
    sequence_sha256: str,
    stage_id: str,
    cache_key: str,
    artifact_type: str,
    filename: str,
) -> str:
    return "/".join(
        (
            "historical",
            "mn5",
            sequence_sha256,
            stage_id,
            cache_key,
            re.sub(r"[^A-Za-z0-9_.-]", "_", artifact_type),
            _safe_filename(filename, "artifact.bin"),
        )
    )


def _copy_file_exclusive(source: Path, destination: Path) -> None:
    """Copy without overwriting a file another importer may already own."""

    file_descriptor: int | None = None
    try:
        file_descriptor = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o660,
        )
        with source.open("rb") as source_stream, os.fdopen(file_descriptor, "wb") as target:
            file_descriptor = None
            shutil.copyfileobj(source_stream, target)
    except FileExistsError as exc:
        raise exc
    except Exception:
        if file_descriptor is not None:
            os.close(file_descriptor)
        destination.unlink(missing_ok=True)
        raise


def _copy_stage_artifact(
    session: Session,
    store: ArtifactStore,
    *,
    stage_result: StageResult,
    descriptor: dict[str, object],
    sequence_sha256: str,
    created_storage_keys: list[str],
) -> Artifact:
    source = Path(descriptor["path"])
    artifact_type = str(descriptor["artifact_type"])
    storage_key = _artifact_storage_key(
        sequence_sha256,
        stage_result.stage_id,
        stage_result.cache_key,
        artifact_type,
        source.name,
    )
    existing = session.scalar(select(Artifact).where(Artifact.storage_key == storage_key))
    expected_size = int(descriptor["size"])
    expected_sha256 = str(descriptor["sha256"])
    if existing is not None:
        if (
            existing.stage_result_id != stage_result.id
            or existing.size != expected_size
            or existing.sha256 != expected_sha256
        ):
            raise Mn5ImportError(f"colisión de artefacto histórico: {storage_key}")
        return existing
    destination = store.resolve(storage_key)
    destination.parent.mkdir(parents=True, exist_ok=True)
    artifact = Artifact(
        stage_result_id=stage_result.id,
        artifact_type=artifact_type,
        storage_backend="filesystem",
        storage_key=storage_key,
        sha256=expected_sha256,
        size=expected_size,
        media_type=_media_type(source),
    )
    session.add(artifact)
    session.flush()
    try:
        _copy_file_exclusive(source, destination)
        created_storage_keys.append(storage_key)
    except FileExistsError:
        if destination.stat().st_size != expected_size or _sha256(destination) != expected_sha256:
            raise Mn5ImportError(
                f"el archivo existente no conserva la integridad de {source.name}"
            ) from None
    return artifact


def _ensure_stage_result(
    session: Session,
    store: ArtifactStore,
    payload: dict[str, object],
    *,
    sequence: str,
    sequence_sha256: str,
    owner_id: str,
    project_id: str,
    protein_id: str,
    remote_run_id: str,
    created_storage_keys: list[str],
) -> tuple[StageResult, dict[str, object]]:
    stage_id = str(payload["stage_id"])
    cache_key = str(payload["cache_key"])
    manifest = payload["manifest"]
    provenance = payload["provenance"]
    assert isinstance(manifest, dict)
    assert isinstance(provenance, dict)
    existing = session.scalar(
        select(StageResult).where(
            StageResult.protein_id == protein_id,
            StageResult.stage_id == stage_id,
            StageResult.cache_key == cache_key,
            StageResult.project_id == project_id,
        )
    )
    if existing is not None:
        source = (existing.provenance or {}).get("import_source")
        if source != "mn5":
            raise Mn5ImportError(
                f"ya existe un StageResult no histórico para {stage_id}/{cache_key}; "
                "se aborta para no mezclar fuentes"
            )
        stage_result = existing
    else:
        stage_result = StageResult(
            protein_id=protein_id,
            stage_id=stage_id,
            cache_key=cache_key,
            status="success",
            provenance={
                "import_source": "mn5",
                "import_contract_version": IMPORT_CONTRACT_VERSION,
                "remote_run_id": remote_run_id,
                "remote_stage_path": payload["remote_path"],
                "remote_job_id": payload["remote_job_id"],
                "source_slurm_job_id": payload["source_slurm_job_id"],
                "remote_provenance": _portable(provenance, str(payload["remote_root"])),
                "remote_manifest": _portable(manifest, str(payload["remote_root"])),
            },
            owner_id=owner_id,
            project_id=project_id,
            created_at=(
                _parse_datetime((payload["operational"] or {}).get("finished_at"))
                or datetime.now(UTC)
            ),
            published_at=(
                _parse_datetime((payload["operational"] or {}).get("finished_at"))
                or datetime.now(UTC)
            ),
        )
        session.add(stage_result)
        session.flush()
    rows = _annotation_rows(payload, sequence)
    table = ANNOTATION_TABLES[stage_id]
    row_count = (
        session.scalar(
            select(func.count())
            .select_from(table)
            .where(table.c.stage_result_id == stage_result.id)
        )
        or 0
    )
    if row_count == 0:
        insert_annotation_rows(session, stage_id, stage_result.id, rows)
    elif row_count != len(rows):
        raise Mn5ImportError(f"anotaciones parciales para {stage_id}/{cache_key}")
    descriptors, skipped = _artifact_descriptor(payload)
    for descriptor in descriptors:
        _copy_stage_artifact(
            session,
            store,
            stage_result=stage_result,
            descriptor=descriptor,
            sequence_sha256=sequence_sha256,
            created_storage_keys=created_storage_keys,
        )
    import_validation = {
        "source": "mn5",
        "artifact_count": len(descriptors),
        "annotation_rows": len(rows),
        "skipped_artifacts": skipped,
        "bounded_artifact_limit_bytes": MAX_IMPORTED_ARTIFACT_BYTES,
    }
    stage_provenance = dict(stage_result.provenance or {})
    stage_provenance["import_validation"] = import_validation
    stage_result.provenance = stage_provenance
    session.flush()
    return stage_result, import_validation


def _load_selected_variants(direct_root: Path, sequence: str) -> list[dict[str, object]]:
    path = direct_root / "campaigns" / "camilo_apoe_p02649_20261017" / "selected_variants.tsv"
    if not path.is_file():
        raise Mn5ImportError("no se encontró selected_variants.tsv")
    variants: list[dict[str, object]] = []
    with path.open("r", encoding="utf-8", newline="") as stream:
        reader = csv.DictReader(stream, delimiter="\t")
        expected = {"variant", "aa_position", "variation_id", "clnsig", "clnrevstat", "condition"}
        if not expected.issubset(reader.fieldnames or []):
            raise Mn5ImportError("selected_variants.tsv no cumple su contrato de columnas")
        for row in reader:
            variant = str(row.get("variant", "")).strip().upper()
            match = re.fullmatch(r"([A-Z])(\d+)([A-Z])", variant)
            if not match:
                raise Mn5ImportError(f"variante inválida en campaña: {variant}")
            aa_ref, raw_position, aa_alt = match.groups()
            position = int(raw_position)
            if position > len(sequence) or sequence[position - 1] != aa_ref:
                raise Mn5ImportError(f"variante no coincide con la secuencia: {variant}")
            variants.append(
                {
                    "variant": variant,
                    "aa_position": position,
                    "aa_ref": aa_ref,
                    "aa_alt": aa_alt,
                    "variation_id": str(row["variation_id"]),
                    "clnsig": str(row["clnsig"]),
                    "clnrevstat": str(row["clnrevstat"]),
                    "condition": str(row["condition"]),
                    "source": "camilo_apoe_p02649_20261017",
                }
            )
    if len(variants) != 3:
        raise Mn5ImportError(f"se esperaban 3 variantes seleccionadas, llegaron {len(variants)}")
    if {item["variant"] for item in variants} != {spec["variant"] for spec in DDG_RUNS}:
        raise Mn5ImportError("las variantes seleccionadas no coinciden con los tres jobs DDG")
    return variants


def _load_structure_mapping(source_root: Path, sequence: str) -> dict[str, object]:
    path = (
        source_root
        / "results"
        / "protein_relaxation_energy"
        / CORE_STAGE_KEYS["protein_relaxation_energy"]
        / "common"
        / "structure_mapping.tsv"
    )
    if not path.is_file():
        raise Mn5ImportError("falta structure_mapping.tsv publicado por MN5")
    pairs: list[dict[str, object]] = []
    with path.open("r", encoding="utf-8", newline="") as stream:
        reader = csv.DictReader(stream, delimiter="\t")
        expected = {"aa_position", "aa_ref", "chain", "resseq", "icode", "pdb_aa", "mapping_status"}
        if not expected.issubset(reader.fieldnames or []):
            raise Mn5ImportError("structure_mapping.tsv no cumple su contrato")
        for row in reader:
            position = int(str(row["aa_position"]))
            residue_number = int(str(row["resseq"]))
            aa = str(row["aa_ref"]).upper()
            if position < 1 or position > len(sequence) or sequence[position - 1] != aa:
                raise Mn5ImportError(f"mapeo estructural no coincide en posición {position}")
            pairs.append(
                {
                    "canonical_position": position,
                    "aa": aa,
                    "chain": str(row["chain"] or "A"),
                    "residue_number": residue_number,
                    "insertion_code": (
                        "" if str(row["icode"]).upper() in {"", "NA", "."} else str(row["icode"])
                    ),
                    "mapping_status": str(row["mapping_status"]),
                }
            )
    mapped_positions = {item["canonical_position"] for item in pairs}
    if len(pairs) != len(sequence) or mapped_positions != set(range(1, len(sequence) + 1)):
        raise Mn5ImportError("structure_mapping.tsv no cubre toda la secuencia canónica")
    return {
        "canonical_to_structure": pairs,
        "canonical_length": len(sequence),
        "mapped_positions": len(pairs),
        "chain": pairs[0]["chain"] if pairs else "A",
        "source": "protein_relaxation_energy/structure_mapping.tsv",
    }


def _remote_context(direct_root: Path, remote_run_id: str) -> dict[str, object]:
    path = direct_root / "runs" / remote_run_id / "run_context.json"
    context = _load_json(path)
    if context.get("run_id") != remote_run_id or context.get("sequence_sha256") != SEQUENCE_SHA256:
        raise Mn5ImportError(f"run_context inconsistente: {remote_run_id}")
    state = context.get("input_state")
    if not isinstance(state, dict) or state.get("run_status") != "success":
        raise Mn5ImportError(f"run_context no exitoso: {remote_run_id}")
    return context


def _expected_stage_payloads(
    source_root: Path,
    context: dict[str, object],
    expected_stage_ids: set[str],
    *,
    expected_job_id: str,
    remote_root: str,
) -> dict[str, dict[str, object]]:
    state = context.get("input_state")
    assert isinstance(state, dict)
    statuses = state.get("stage_status")
    stage_results = context.get("stage_results")
    if not isinstance(statuses, dict) or not isinstance(stage_results, dict):
        raise Mn5ImportError(
            f"run_context no contiene stage_status/stage_results: {context.get('run_id')}"
        )
    if set(statuses) != expected_stage_ids or set(stage_results) != expected_stage_ids:
        raise Mn5ImportError(
            f"conjunto de stages inesperado en {context.get('run_id')}: {sorted(set(statuses))}"
        )
    payloads: dict[str, dict[str, object]] = {}
    for stage_id in expected_stage_ids:
        if statuses.get(stage_id) != "success":
            raise Mn5ImportError(f"stage remoto no exitoso: {context.get('run_id')}/{stage_id}")
        stage_context = stage_results.get(stage_id)
        if not isinstance(stage_context, dict):
            raise Mn5ImportError(f"stage result inválido: {stage_id}")
        cache_key = str(stage_context.get("cache_key") or "")
        if not re.fullmatch(r"[0-9a-f]{64}", cache_key):
            raise Mn5ImportError(f"cache key inválido en {stage_id}")
        payload = _stage_payload(
            source_root,
            stage_id,
            cache_key,
            remote_root,
            expected_job_id=expected_job_id,
        )
        payload["protein_id"] = SCIENTIFIC_PROTEIN_ID
        payload["remote_run_id"] = str(context["run_id"])
        payloads[stage_id] = payload
    return payloads


def _ensure_access(session: Session, protein: Protein, project_id: str) -> None:
    dialect = session.get_bind().dialect.name
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as dialect_insert

        statement = dialect_insert(ProteinProjectAccess)
    elif dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert as dialect_insert

        statement = dialect_insert(ProteinProjectAccess)
    else:
        statement = insert(ProteinProjectAccess)
    statement = statement.values(protein_id=protein.id, project_id=project_id)
    if dialect in {"postgresql", "sqlite"}:
        session.execute(
            statement.on_conflict_do_nothing(index_elements=["protein_id", "project_id"])
        )
    elif session.get(ProteinProjectAccess, (protein.id, project_id)) is None:
        session.add(ProteinProjectAccess(protein_id=protein.id, project_id=project_id))


def _ensure_alias(session: Session, protein: Protein, source: str, identifier: str) -> None:
    existing = session.scalar(
        select(ProteinIdentifier).where(
            ProteinIdentifier.source == source,
            ProteinIdentifier.identifier == identifier,
        )
    )
    if existing is not None:
        if existing.protein_id != protein.id:
            has_matching_fasta_identity = any(
                item.source in {"fasta_header", "fasta"}
                and re.search(rf"(?:^|\|){re.escape(identifier)}(?:\||$)", item.identifier)
                for item in protein.identifiers
            )
            if source == "uniprot" and has_matching_fasta_identity:
                # The local database may already contain a legacy global
                # ``uniprot:P02649`` alias for a different sequence. Keep
                # that unrelated row intact and rely on the exact FASTA
                # header already attached to this sequence as its scientific
                # identity. The conflict is deliberately not repaired by an
                # historical import.
                return
            raise Mn5ImportError(f"el alias {source}:{identifier} pertenece a otra proteína")
        return
    session.add(ProteinIdentifier(protein_id=protein.id, source=source, identifier=identifier))


def _get_or_create_protein(session: Session, user: User, sequence: str) -> Protein:
    normalized = normalize_sequence(sequence, max_length=get_settings().max_sequence_length)
    if normalized.sequence_sha256 != SEQUENCE_SHA256:
        raise Mn5ImportError("la secuencia de MN5 no coincide con el SHA-256 esperado")
    protein = session.scalar(select(Protein).where(Protein.sequence_sha256 == SEQUENCE_SHA256))
    if protein is None:
        protein = Protein(
            sequence_sha256=SEQUENCE_SHA256,
            sequence=normalized.sequence,
            length=len(normalized.sequence),
            owner_id=user.id,
            project_id=user.project_id,
        )
        session.add(protein)
        session.flush()
    elif protein.sequence != normalized.sequence or protein.length != len(normalized.sequence):
        raise Mn5ImportError("la proteína existente tiene una secuencia distinta al snapshot MN5")
    _ensure_access(session, protein, user.project_id)
    _ensure_alias(session, protein, "uniprot", SCIENTIFIC_PROTEIN_ID)
    _ensure_alias(session, protein, "gene", SCIENTIFIC_GENE)
    session.flush()
    return protein


def _run_stage_metadata(payload: dict[str, object]) -> tuple[datetime | None, datetime | None]:
    operational = payload["operational"]
    assert isinstance(operational, dict)
    return (
        _parse_datetime(operational.get("started_at")),
        _parse_datetime(operational.get("finished_at")),
    )


def _copy_run_artifact(
    session: Session,
    store: ArtifactStore,
    *,
    run: Run,
    source: Path,
    artifact_type: str,
    sequence_sha256: str,
    remote_run_id: str,
    created_storage_keys: list[str],
) -> Artifact:
    if not source.is_file():
        raise Mn5ImportError(f"falta exportación de corrida: {source}")
    storage_key = "/".join(
        (
            "historical",
            "mn5",
            sequence_sha256,
            "runs",
            remote_run_id,
            re.sub(r"[^A-Za-z0-9_.-]", "_", artifact_type),
            _safe_filename(source.name, "export.tsv"),
        )
    )
    digest = _sha256(source)
    size = source.stat().st_size
    existing = session.scalar(select(Artifact).where(Artifact.storage_key == storage_key))
    if existing is not None:
        if existing.run_id != run.id or existing.size != size or existing.sha256 != digest:
            raise Mn5ImportError(f"colisión de exportación histórica: {storage_key}")
        return existing
    destination = store.resolve(storage_key)
    destination.parent.mkdir(parents=True, exist_ok=True)
    artifact = Artifact(
        run_id=run.id,
        stage_result_id=None,
        artifact_type=artifact_type,
        storage_backend="filesystem",
        storage_key=storage_key,
        sha256=digest,
        size=size,
        media_type=(
            "text/tab-separated-values" if source.suffix.lower() == ".tsv" else _media_type(source)
        ),
    )
    session.add(artifact)
    session.flush()
    try:
        _copy_file_exclusive(source, destination)
        created_storage_keys.append(storage_key)
    except FileExistsError:
        if destination.stat().st_size != size or _sha256(destination) != digest:
            raise Mn5ImportError(
                f"el archivo existente no conserva la integridad: {source.name}"
            ) from None
    return artifact


def _variant_for_run(variants: list[dict[str, object]], variant: str) -> dict[str, object]:
    try:
        return next(item for item in variants if item.get("variant") == variant)
    except StopIteration as exc:
        raise Mn5ImportError(f"variante no encontrada en la campaña: {variant}") from exc


def _create_historical_run(
    session: Session,
    store: ArtifactStore,
    *,
    protein: Protein,
    user: User,
    context: dict[str, object],
    remote_job_id: str,
    actual_payloads: dict[str, dict[str, object]],
    source_stage_results: dict[str, StageResult],
    variants: list[dict[str, object]],
    structure_mapping: dict[str, object],
    direct_root: Path,
    remote_root: str,
    created_storage_keys: list[str],
    reused_stage_ids: set[str],
    import_label: str,
) -> Run:
    remote_run_id = str(context["run_id"])
    state = context["input_state"]
    assert isinstance(state, dict)
    actual_ids = set(actual_payloads)
    selected_ids = [
        definition.id for definition in STAGE_DEFINITIONS if definition.id in actual_ids
    ]
    run_created = _run_id_datetime(remote_run_id)
    stage_times = [_run_stage_metadata(payload) for payload in actual_payloads.values()]
    started = min((value for value, _ in stage_times if value is not None), default=run_created)
    finished = max((value for _, value in stage_times if value is not None), default=run_created)
    requested_variants = variants
    if import_label != "cpu_baseline":
        variant_ref = context.get("variant_ref") or state.get("variant_ref")
        variant_position = context.get("variant_position") or state.get("variant_position")
        variant_alt = context.get("variant_alt") or state.get("variant_alt")
        if not isinstance(variant_ref, str) or not isinstance(variant_alt, str):
            raise Mn5ImportError(f"run_context sin variante explícita: {remote_run_id}")
        try:
            normalized_position = int(variant_position)
        except (TypeError, ValueError) as exc:
            raise Mn5ImportError(f"posición de variante inválida: {remote_run_id}") from exc
        variant = next(
            (
                item
                for item in variants
                if item["aa_ref"] == variant_ref
                and item["aa_position"] == normalized_position
                and item["aa_alt"] == variant_alt
            ),
            None,
        )
        if variant is None:
            raise Mn5ImportError(
                f"la variante del contexto no está en selected_variants.tsv: {variant_ref}"
                f"{normalized_position}{variant_alt}"
            )
        requested_variants = [variant]
    omitted_stages: list[dict[str, object]] = []
    for definition in STAGE_DEFINITIONS:
        if definition.id in actual_ids:
            continue
        reason = (
            "separate_variant_ddg_run"
            if import_label == "cpu_baseline" and definition.id == "variant_ddg"
            else "not_in_historical_variant_run"
        )
        message = (
            "El DDG se publicó en jobs variant_ddg separados"
            if reason == "separate_variant_ddg_run"
            else "La corrida histórica de esta variante solo publicó las siete etapas necesarias"
        )
        omitted_stages.append(
            {
                "stage_id": definition.id,
                "reason": reason,
                "message": message,
                "prerequisites": list(definition.dependencies),
            }
        )
    remote_final = direct_root / "runs" / remote_run_id / "final" / "annotations.tsv"
    source_input_state = {
        key: _portable(state.get(key), remote_root)
        for key in (
            "mode",
            "run_status",
            "sequence_source",
            "canonical_sequence_status",
            "fasta_path",
            "pdb_path",
            "final_export",
            "ddg_runs",
            "selected_pdb_chain",
        )
    }
    scientific_parameters = {
        "import_source": "MN5",
        "import_contract_version": IMPORT_CONTRACT_VERSION,
        "execution_scope": import_label,
        "remote_run_id": remote_run_id,
        "remote_job_id": remote_job_id,
        "sequence_source": state.get("sequence_source"),
        "mode": state.get("mode"),
        "ddg_runs": state.get("ddg_runs"),
        "gene": SCIENTIFIC_GENE,
        "organism": "Homo sapiens",
        "clinvar_assembly": "GRCh38",
        "ddg_unit": "REU",
        "ddg_boundary": (
            "Rosetta score difference in REU; not kcal/mol and not a pathogenicity claim."
        ),
    }
    prerequisites = {
        "historical_mn5_import": True,
        "source_status": "success",
        "remote_registry_stage_count": 19,
        "baseline_cpu_stage_count": 18,
        "actual_stage_count": len(actual_ids),
        "reused_stage_count": len(reused_stage_ids),
        "omitted_stage_count": len(omitted_stages),
        "source_input_state": source_input_state,
    }
    versions = {
        "contract_version": IMPORT_CONTRACT_VERSION,
        "remote_stage_versions": {
            stage_id: payload["manifest"]
            .get("cache_key_payload", {})
            .get("contract_version", "unknown")
            for stage_id, payload in actual_payloads.items()
        },
        "remote_stage_code_sha256": {
            stage_id: payload["manifest"].get("cache_key_payload", {}).get("stage_code_sha256")
            for stage_id, payload in actual_payloads.items()
        },
        "sequence_sha256": SEQUENCE_SHA256,
    }
    input_references = {
        "protein": {
            "scientific_id": SCIENTIFIC_PROTEIN_ID,
            "gene": SCIENTIFIC_GENE,
            "sequence_sha256": SEQUENCE_SHA256,
            "length": protein.length,
        },
        "fasta": _portable(state.get("fasta_path"), remote_root),
        "campaign": "campaigns/camilo_apoe_p02649_20261017/selected_variants.tsv",
        "remote_run_id": remote_run_id,
        "remote_final_export": _portable(state.get("final_export"), remote_root),
        "remote_stage_results": {
            stage_id: payload["remote_path"] for stage_id, payload in actual_payloads.items()
        },
    }
    run = Run(
        protein_id=protein.id,
        owner_id=user.id,
        project_id=user.project_id,
        status=RunStatus.SUCCESS,
        requested_variants=requested_variants,
        remote_job_id=remote_job_id,
        created_at=run_created,
        started_at=started,
        finished_at=finished,
    )
    run.configuration = RunConfiguration(
        protein_id=protein.id,
        sequence_sha256=SEQUENCE_SHA256,
        scientific_accession=SCIENTIFIC_PROTEIN_ID,
        structure_source="alphafold3",
        structure_sha256="7e07d63464b422546ac35dde2516e4ec63d208127230fe53b1532bcda6a9af2c",
        structure_chain=str(structure_mapping.get("chain") or "A"),
        structure_mapping=structure_mapping,
        normalized_variants=requested_variants,
        selected_stage_ids=selected_ids,
        omitted_stages=omitted_stages,
        scientific_parameters=scientific_parameters,
        prerequisites=prerequisites,
        versions=versions,
        input_references=input_references,
        owner_id=user.id,
        project_id=user.project_id,
    )
    requirements = sorted(
        {
            requirement
            for stage_id in actual_ids
            for requirement in STAGE_BY_ID[stage_id].technical_requirements
        }
    )
    run.preparation = RunPreparation(
        status="success",
        required_requirements=requirements,
        satisfied_requirements=requirements,
        snapshots={
            "source": "mn5",
            "remote_run_id": remote_run_id,
            "remote_job_id": remote_job_id,
            "stage_status": "success",
            "bounded_artifact_limit_bytes": MAX_IMPORTED_ARTIFACT_BYTES,
        },
        preparation_key=hashlib.sha256(remote_run_id.encode("utf-8")).hexdigest(),
        attempt_count=1,
        started_at=started,
        checked_at=finished,
        finished_at=finished,
    )
    for definition in STAGE_DEFINITIONS:
        payload = actual_payloads.get(definition.id)
        if payload is None:
            run.stages.append(
                RunStage(
                    stage_id=definition.id,
                    status=RunStageStatus.SKIPPED,
                    omission_reason=next(
                        item["reason"]
                        for item in omitted_stages
                        if item["stage_id"] == definition.id
                    ),
                    preflight_status="success",
                    preflight_details={"source": "mn5", "historical": True},
                    created_at=run_created,
                    finished_at=finished,
                )
            )
            continue
        stage_result = source_stage_results[definition.id]
        stage_started, stage_finished = _run_stage_metadata(payload)
        status = (
            RunStageStatus.REUSED if definition.id in reused_stage_ids else RunStageStatus.SUCCESS
        )
        run.stages.append(
            RunStage(
                stage_id=definition.id,
                stage_result_id=stage_result.id,
                status=status,
                slurm_job_id=remote_job_id,
                attempt_count=1,
                cache_key=stage_result.cache_key,
                cache_factors=payload["manifest"].get("cache_key_payload", {}),
                reuse_reason=(
                    {
                        "reason": "shared_historical_stage_result",
                        "source_remote_run_id": CORE_REMOTE_RUN_ID,
                        "source_remote_job_id": CORE_REMOTE_JOB_ID,
                        "cache_key": stage_result.cache_key,
                    }
                    if status == RunStageStatus.REUSED
                    else None
                ),
                preflight_status="success",
                preflight_details={"source": "mn5", "historical": True},
                created_at=stage_started or run_created,
                started_at=stage_started,
                finished_at=stage_finished,
            )
        )
    session.add(run)
    session.flush()
    audit = record_audit(
        session,
        action="import_mn5_results",
        actor_user_id=user.id,
        resource_type="run",
        resource_id=run.id,
        client_ip=None,
        details={
            "source": "mn5",
            "remote_run_id": remote_run_id,
            "remote_job_id": remote_job_id,
            "execution_scope": import_label,
            "stage_count": len(actual_ids),
        },
    )
    run.configuration.confirmation_audit_id = audit.id
    _copy_run_artifact(
        session,
        store,
        run=run,
        source=remote_final,
        artifact_type="final_annotations",
        sequence_sha256=SEQUENCE_SHA256,
        remote_run_id=remote_run_id,
        created_storage_keys=created_storage_keys,
    )
    if import_label == "cpu_baseline":
        campaign_path = (
            direct_root / "campaigns" / "camilo_apoe_p02649_20261017" / "selected_variants.tsv"
        )
        _copy_run_artifact(
            session,
            store,
            run=run,
            source=campaign_path,
            artifact_type="selected_variants",
            sequence_sha256=SEQUENCE_SHA256,
            remote_run_id=remote_run_id,
            created_storage_keys=created_storage_keys,
        )
    return run


def _historical_import_result(
    session: Session,
    user: User,
    remote_job_ids: Sequence[str],
) -> dict[str, object] | None:
    """Return the completed import identity or fail closed on a partial one."""

    existing_runs = list(
        session.scalars(
            select(Run).where(
                Run.owner_id == user.id,
                Run.project_id == user.project_id,
                Run.remote_job_id.in_(remote_job_ids),
            )
        ).all()
    )
    if not existing_runs:
        return None
    by_job = {run.remote_job_id: run for run in existing_runs}
    expected_jobs = set(remote_job_ids)
    if set(by_job) == expected_jobs and len(by_job) == len(expected_jobs):
        return {
            "status": "already_imported",
            "user_id": user.id,
            "project_id": user.project_id,
            "run_ids": [by_job[job_id].id for job_id in remote_job_ids],
        }
    raise Mn5ImportError("hay una importación MN5 parcial para esta cuenta; no se modifica")


def import_mn5_results(
    session: Session,
    *,
    source_root: Path,
    direct_root: Path,
    email: str,
    settings: Settings | None = None,
) -> dict[str, object]:
    settings = settings or get_settings()
    source_root = source_root.expanduser().resolve()
    direct_root = direct_root.expanduser().resolve()
    remote_root = settings.hpc_remote_root.rstrip("/")
    if not source_root.is_dir() or not direct_root.is_dir():
        raise Mn5ImportError("source_root y direct_root deben ser directorios existentes")
    user = session.scalar(select(User).where(User.email == normalize_email(email)))
    if user is None or not user.is_active:
        raise Mn5ImportError(f"la cuenta no existe o está inactiva: {normalize_email(email)}")
    all_jobs = [CORE_REMOTE_JOB_ID, *(str(spec["remote_job_id"]) for spec in DDG_RUNS)]
    existing_result = _historical_import_result(session, user, all_jobs)
    if existing_result is not None:
        return existing_result
    contexts = {CORE_REMOTE_RUN_ID: _remote_context(direct_root, CORE_REMOTE_RUN_ID)}
    for spec in DDG_RUNS:
        contexts[spec["remote_run_id"]] = _remote_context(direct_root, str(spec["remote_run_id"]))
    core_context = contexts[CORE_REMOTE_RUN_ID]
    sequence = str(core_context.get("sequence") or "")
    if not sequence:
        raise Mn5ImportError("el run_context CPU no contiene la secuencia canónica")
    protein = _get_or_create_protein(session, user, sequence)
    variants = _load_selected_variants(direct_root, sequence)
    structure_mapping = _load_structure_mapping(source_root, sequence)
    created_storage_keys: list[str] = []
    store = ArtifactStore(settings)
    try:
        core_payloads = _expected_stage_payloads(
            source_root,
            core_context,
            set(CORE_STAGE_KEYS),
            expected_job_id=CORE_REMOTE_JOB_ID,
            remote_root=remote_root,
        )
        for stage_id, expected_key in CORE_STAGE_KEYS.items():
            if core_payloads[stage_id]["cache_key"] != expected_key:
                raise Mn5ImportError(f"hash de stage inesperado: {stage_id}")
        core_results: dict[str, StageResult] = {}
        core_import_details: dict[str, dict[str, object]] = {}
        core_stage_ids = [
            definition.id for definition in STAGE_DEFINITIONS if definition.id in core_payloads
        ]
        for stage_id in core_stage_ids:
            payload = core_payloads[stage_id]
            result, detail = _ensure_stage_result(
                session,
                store,
                payload,
                sequence=sequence,
                sequence_sha256=SEQUENCE_SHA256,
                owner_id=user.id,
                project_id=user.project_id,
                protein_id=protein.id,
                remote_run_id=CORE_REMOTE_RUN_ID,
                created_storage_keys=created_storage_keys,
            )
            core_results[stage_id] = result
            core_import_details[stage_id] = detail
        core_run = _create_historical_run(
            session,
            store,
            protein=protein,
            user=user,
            context=core_context,
            remote_job_id=CORE_REMOTE_JOB_ID,
            actual_payloads=core_payloads,
            source_stage_results=core_results,
            variants=variants,
            structure_mapping=structure_mapping,
            direct_root=direct_root,
            remote_root=remote_root,
            created_storage_keys=created_storage_keys,
            reused_stage_ids=set(),
            import_label="cpu_baseline",
        )
        run_ids = [core_run.id]
        for spec in DDG_RUNS:
            remote_run_id = str(spec["remote_run_id"])
            context = contexts[remote_run_id]
            payloads = _expected_stage_payloads(
                source_root,
                context,
                EXPECTED_DDG_STAGE_IDS,
                expected_job_id=str(spec["remote_job_id"]),
                remote_root=remote_root,
            )
            if payloads["variant_ddg"]["cache_key"] != spec["cache_key"]:
                raise Mn5ImportError(f"hash DDG inesperado para {spec['variant']}")
            result, _ = _ensure_stage_result(
                session,
                store,
                payloads["variant_ddg"],
                sequence=sequence,
                sequence_sha256=SEQUENCE_SHA256,
                owner_id=user.id,
                project_id=user.project_id,
                protein_id=protein.id,
                remote_run_id=remote_run_id,
                created_storage_keys=created_storage_keys,
            )
            stage_results = dict(core_results)
            stage_results["variant_ddg"] = result
            run = _create_historical_run(
                session,
                store,
                protein=protein,
                user=user,
                context=context,
                remote_job_id=str(spec["remote_job_id"]),
                actual_payloads=payloads,
                source_stage_results=stage_results,
                variants=variants,
                structure_mapping=structure_mapping,
                direct_root=direct_root,
                remote_root=remote_root,
                created_storage_keys=created_storage_keys,
                reused_stage_ids=EXPECTED_DDG_STAGE_IDS - {"variant_ddg"},
                import_label=f"variant_ddg_{spec['variant']}",
            )
            run_ids.append(run.id)
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        for storage_key in created_storage_keys:
            try:
                store.resolve(storage_key).unlink(missing_ok=True)
            except OSError:
                pass
        concurrent_result = _historical_import_result(session, user, all_jobs)
        if concurrent_result is not None:
            return concurrent_result
        raise Mn5ImportError(
            "la importación MN5 colisionó con otra operación; no se pudo reconciliar"
        ) from exc
    except Exception:
        session.rollback()
        for storage_key in created_storage_keys:
            try:
                store.resolve(storage_key).unlink(missing_ok=True)
            except OSError:
                pass
        raise
    return {
        "status": "imported",
        "user_id": user.id,
        "project_id": user.project_id,
        "protein_id": protein.id,
        "sequence_sha256": SEQUENCE_SHA256,
        "runs_imported": 1 + len(DDG_RUNS),
        "run_ids": run_ids,
        "core_stage_results": len(core_results),
        "variant_stage_results": len(DDG_RUNS),
        "bounded_artifact_limit_bytes": MAX_IMPORTED_ARTIFACT_BYTES,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Import verified historical MN5 results")
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--direct-root", type=Path, required=True)
    parser.add_argument("--email", required=True)
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    session_factory: SessionFactory | None = None,
) -> int:
    args = _parser().parse_args(argv)
    factory = session_factory or SessionLocal
    with factory() as session:
        try:
            result = import_mn5_results(
                session,
                source_root=args.source_root,
                direct_root=args.direct_root,
                email=args.email,
            )
        except Mn5ImportError as exc:
            session.rollback()
            print(f"MN5 import failed: {exc}")
            return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0
