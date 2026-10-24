from __future__ import annotations

import hashlib
import json
import shutil
import tarfile
from pathlib import Path
from types import SimpleNamespace
from zipfile import ZipFile

import pytest
from app.core.config import Settings
from app.features.artifacts.storage import ArtifactStore
from app.features.runs.mn5_import import (
    CORE_REMOTE_RUN_ID,
    CORE_STAGE_KEYS,
    MAX_IMPORTED_ARTIFACT_BYTES,
    MAX_IMPORTED_DIRECTORY_BYTES,
    MAX_IMPORTED_DIRECTORY_ENTRIES,
    Mn5ImportError,
    _annotation_rows,
    _archive_local_directory,
    _artifact_descriptor,
    _copy_file_exclusive,
    _historical_bioemu_directory_available,
    _portable,
    _reconcile_existing_bioemu_artifact,
)
from app.features.runs.models import Artifact


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_annotation_contract_requires_only_stage_outputs(tmp_path: Path):
    annotations = tmp_path / "annotations.tsv"
    annotations.write_text(
        "protein_id\taa_position\taa_ref\tvariant_in_statin_ldlc_region\n"
        "P02649\t1\tA\tfalse\n"
        "P02649\t2\tC\ttrue\n"
        "P02649\t3\tD\tfalse\n"
        "P02649\t4\tE\tfalse\n",
        encoding="utf-8",
    )

    rows = _annotation_rows(
        {"stage_id": "functional_region_evidence", "stage_dir": tmp_path},
        "ACDE",
    )

    assert len(rows) == 4
    assert rows[1]["values"] == {"variant_in_statin_ldlc_region": "true"}
    assert rows[1]["qc_status"] == "verified"


def test_artifact_descriptor_records_bounded_skips_and_verified_files(tmp_path: Path):
    annotations = tmp_path / "annotations.tsv"
    annotations.write_text("placeholder\n", encoding="utf-8")
    detail = tmp_path / "detail.tsv"
    detail.write_text("position\tvalue\n1\t0.5\n", encoding="utf-8")
    variant_dir = tmp_path / "variant_structures"
    variant_dir.mkdir()
    (variant_dir / "E21K.pdb").write_text("MODEL E21K\n", encoding="utf-8")
    manifest = {
        "file_integrity": {
            "annotations": {"size": annotations.stat().st_size, "sha256": _sha256(annotations)}
        },
        "artifacts": {
            "detail": {
                "path": "detail.tsv",
                "size": detail.stat().st_size,
                "sha256": _sha256(detail),
            },
            "external_cache": {"external": True, "path": "external"},
            "directory_output": {"path": "output", "size": None},
            "variant_dir": {"path": "variant_structures", "size": None, "sha256": None},
            "large_output": {
                "path": "large.bin",
                "size": MAX_IMPORTED_ARTIFACT_BYTES + 1,
                "sha256": "0" * 64,
            },
        },
    }

    descriptors, skipped = _artifact_descriptor(
        {"stage_id": "protein_identity", "stage_dir": tmp_path, "manifest": manifest}
    )

    assert [item["artifact_type"] for item in descriptors] == [
        "annotations",
        "detail",
        "variant_dir",
    ]
    variant_descriptor = descriptors[-1]
    assert variant_descriptor["kind"] == "directory"
    assert variant_descriptor["archive_filename"] == "variant_structures.zip"
    assert {item["reason"] for item in skipped} == {
        "external_cache",
        "directory_artifact",
        "bounded_import_limit",
    }


def test_missing_variant_directory_is_reported_without_inventing_an_artifact(tmp_path: Path):
    annotations = tmp_path / "annotations.tsv"
    annotations.write_text("placeholder\n", encoding="utf-8")
    manifest = {
        "file_integrity": {
            "annotations": {"size": annotations.stat().st_size, "sha256": _sha256(annotations)}
        },
        "artifacts": {
            "variant_dir": {"path": "missing-variants", "size": None, "sha256": None},
        },
    }

    descriptors, skipped = _artifact_descriptor(
        {"stage_id": "variant_ddg", "stage_dir": tmp_path, "manifest": manifest}
    )

    assert [item["artifact_type"] for item in descriptors] == ["annotations"]
    assert skipped == [
        {
            "artifact_type": "variant_dir",
            "reason": "directory_not_available",
            "path": "missing-variants",
        }
    ]


def test_bioemu_final_directory_preserves_samples_xtc_bytes_in_a_tar(tmp_path: Path):
    annotations = tmp_path / "annotations.tsv"
    annotations.write_text("placeholder\n", encoding="utf-8")
    final_directory = tmp_path / "final"
    final_directory.mkdir()
    (final_directory / "topology.pdb").write_text("PDB topology\n", encoding="utf-8")
    (final_directory / "samples.xtc").write_bytes(b"fixture XTC bytes")
    manifest = {
        "file_integrity": {
            "annotations": {"size": annotations.stat().st_size, "sha256": _sha256(annotations)}
        },
        "artifacts": {
            "conformational_ensemble_final_dir": {"path": "final", "size": None},
        },
    }

    descriptors, skipped = _artifact_descriptor(
        {
            "stage_id": "conformational_ensemble",
            "stage_dir": tmp_path,
            "manifest": manifest,
        }
    )

    assert skipped == []
    assert [item["artifact_type"] for item in descriptors] == [
        "annotations",
        "conformational_ensemble_final_dir",
    ]
    directory_descriptor = descriptors[1]
    assert directory_descriptor["archive_format"] == "tar"
    assert directory_descriptor["archive_filename"] == "final.tar"

    archive = tmp_path / "final.tar"
    _archive_local_directory(
        Path(directory_descriptor["path"]),
        archive,
        archive_format="tar",
    )
    with tarfile.open(archive, "r:") as stream:
        assert stream.getnames() == ["final", "final/samples.xtc", "final/topology.pdb"]
        xtc = stream.extractfile("final/samples.xtc")
        assert xtc is not None
        assert xtc.read() == b"fixture XTC bytes"


def test_existing_bioemu_import_can_reconcile_its_published_final_directory(tmp_path: Path):
    direct_root = tmp_path / "direct"
    context = direct_root / "runs" / CORE_REMOTE_RUN_ID
    context.mkdir(parents=True)
    (context / "run_context.json").write_text("{}\n", encoding="utf-8")
    stage_dir = (
        tmp_path
        / "source"
        / "results"
        / "conformational_ensemble"
        / CORE_STAGE_KEYS["conformational_ensemble"]
    )
    final_directory = stage_dir / "final"
    final_directory.mkdir(parents=True)
    manifest = {
        "artifacts": {
            "conformational_ensemble_final_dir": {"path": "final", "size": None},
        },
    }
    (stage_dir / "result_manifest.json").write_text(
        json.dumps(manifest),
        encoding="utf-8",
    )

    assert _historical_bioemu_directory_available(tmp_path / "source", direct_root)

    shutil.rmtree(final_directory)
    assert not _historical_bioemu_directory_available(tmp_path / "source", direct_root)


def _bioemu_reconciliation_fixture(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    artifact: Artifact | None,
):
    settings = Settings(artifact_root=tmp_path / "artifacts")
    store = ArtifactStore(settings)
    stage_result = SimpleNamespace(id="stage-result")
    core_run = SimpleNamespace(id="run-id", protein_id="protein-id")

    class ReconciliationSession:
        def __init__(self) -> None:
            self.scalar_results = [stage_result, artifact]
            self.commits = 0
            self.rollbacks = 0

        def get(self, model, identifier):
            assert identifier == core_run.id
            return core_run

        def scalar(self, statement):
            return self.scalar_results.pop(0)

        def commit(self) -> None:
            self.commits += 1

        def rollback(self) -> None:
            self.rollbacks += 1

    monkeypatch.setattr(
        "app.features.runs.mn5_import._remote_context",
        lambda *args: {"sequence": "ACD"},
    )
    monkeypatch.setattr(
        "app.features.runs.mn5_import._stage_payload",
        lambda *args, **kwargs: {"stage_id": "conformational_ensemble"},
    )
    session = ReconciliationSession()
    return settings, store, session


def _published_bioemu_artifact(store: ArtifactStore) -> tuple[Artifact, Path]:
    storage_key = "historical/conformational-ensemble/final.tar"
    artifact_path = store.resolve(storage_key)
    artifact_path.parent.mkdir(parents=True)
    artifact_path.write_bytes(b"published final directory archive")
    artifact = Artifact(
        stage_result_id="stage-result",
        artifact_type="conformational_ensemble_final_dir",
        storage_backend="filesystem",
        storage_key=storage_key,
        sha256=_sha256(artifact_path),
        size=artifact_path.stat().st_size,
        media_type="application/x-tar",
    )
    return artifact, artifact_path


def test_existing_bioemu_artifact_skips_rearchive_and_duplicate_audit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    settings = Settings(artifact_root=tmp_path / "artifacts")
    store = ArtifactStore(settings)
    artifact, _ = _published_bioemu_artifact(store)
    settings, _, session = _bioemu_reconciliation_fixture(tmp_path, monkeypatch, artifact)
    monkeypatch.setattr(
        "app.features.runs.mn5_import._ensure_stage_result",
        lambda *args, **kwargs: pytest.fail("no debe volver a empaquetar el artefacto"),
    )
    monkeypatch.setattr(
        "app.features.runs.mn5_import.record_audit",
        lambda *args, **kwargs: pytest.fail("no debe duplicar la auditoría"),
    )

    result = _reconcile_existing_bioemu_artifact(
        session,
        SimpleNamespace(id="user-id", project_id="project-id"),
        existing_result={"run_ids": ["run-id"], "status": "already_imported"},
        source_root=tmp_path / "source",
        direct_root=tmp_path / "direct",
        settings=settings,
    )

    assert result["status"] == "already_imported"
    assert session.commits == 0
    assert session.rollbacks == 0


def test_existing_bioemu_artifact_with_changed_bytes_fails_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    settings = Settings(artifact_root=tmp_path / "artifacts")
    store = ArtifactStore(settings)
    artifact, artifact_path = _published_bioemu_artifact(store)
    settings, _, session = _bioemu_reconciliation_fixture(tmp_path, monkeypatch, artifact)
    artifact_path.write_bytes(b"changed")
    monkeypatch.setattr(
        "app.features.runs.mn5_import._ensure_stage_result",
        lambda *args, **kwargs: pytest.fail("debe fallar antes de reempaquetar"),
    )

    with pytest.raises(Mn5ImportError, match="no conserva su integridad"):
        _reconcile_existing_bioemu_artifact(
            session,
            SimpleNamespace(id="user-id", project_id="project-id"),
            existing_result={"run_ids": ["run-id"], "status": "already_imported"},
            source_root=tmp_path / "source",
            direct_root=tmp_path / "direct",
            settings=settings,
        )

    assert session.commits == 0
    assert session.rollbacks == 0


def test_missing_bioemu_artifact_still_runs_initial_reconciliation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    settings, _, session = _bioemu_reconciliation_fixture(tmp_path, monkeypatch, None)
    reconciled: list[bool] = []
    audits: list[dict[str, object]] = []
    monkeypatch.setattr(
        "app.features.runs.mn5_import._ensure_stage_result",
        lambda *args, **kwargs: (SimpleNamespace(id="stage-result"), {"artifact_count": 1}),
    )
    monkeypatch.setattr(
        "app.features.runs.mn5_import.record_audit",
        lambda *args, **kwargs: audits.append(kwargs["details"]),
    )

    result = _reconcile_existing_bioemu_artifact(
        session,
        SimpleNamespace(id="user-id", project_id="project-id"),
        existing_result={"run_ids": ["run-id"], "status": "already_imported"},
        source_root=tmp_path / "source",
        direct_root=tmp_path / "direct",
        settings=settings,
    )
    reconciled.append(bool(result.get("bioemu_artifacts_reconciled")))

    assert result["status"] == "reconciled"
    assert reconciled == [True]
    assert len(audits) == 1
    assert session.commits == 1


def test_local_variant_directory_archive_is_bounded_deterministic_and_rejects_symlinks(
    tmp_path: Path,
):
    source = tmp_path / "variant_structures"
    nested = source / "nested"
    nested.mkdir(parents=True)
    (source / "R43C.pdb").write_text("MODEL R43C\n", encoding="utf-8")
    (nested / "metadata.json").write_text("{}\n", encoding="utf-8")
    archive = tmp_path / "variant_structures.zip"

    size, digest = _archive_local_directory(
        source,
        archive,
        max_bytes=MAX_IMPORTED_DIRECTORY_BYTES,
        max_entries=MAX_IMPORTED_DIRECTORY_ENTRIES,
    )

    assert size == archive.stat().st_size
    assert len(digest) == 64
    with ZipFile(archive, "r") as stream:
        assert stream.namelist() == [
            "variant_structures/",
            "variant_structures/R43C.pdb",
            "variant_structures/nested/",
            "variant_structures/nested/metadata.json",
        ]
        assert stream.read("variant_structures/R43C.pdb") == b"MODEL R43C\n"

    outside = tmp_path / "outside"
    outside.write_text("do not include\n", encoding="utf-8")
    (source / "escape").symlink_to(outside)
    with pytest.raises(ValueError, match="symlink"):
        _archive_local_directory(source, tmp_path / "unsafe.zip")
    assert not (tmp_path / "unsafe.zip").exists()


def test_exclusive_copy_does_not_overwrite_another_importer(tmp_path: Path):
    source = tmp_path / "source.tsv"
    destination = tmp_path / "destination.tsv"
    source.write_bytes(b"new bytes")
    destination.write_bytes(b"existing bytes")

    with pytest.raises(FileExistsError):
        _copy_file_exclusive(source, destination)

    assert destination.read_bytes() == b"existing bytes"


def test_portable_provenance_removes_absolute_mn5_root():
    remote_root = "/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion"

    assert _portable(
        {"path": f"{remote_root}/results/protein_identity/key/annotations.tsv"}, remote_root
    ) == {"path": "mn5://results/protein_identity/key/annotations.tsv"}
