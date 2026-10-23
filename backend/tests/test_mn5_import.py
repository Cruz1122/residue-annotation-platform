from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
from app.features.runs.mn5_import import (
    MAX_IMPORTED_ARTIFACT_BYTES,
    _annotation_rows,
    _artifact_descriptor,
    _copy_file_exclusive,
    _portable,
)


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

    assert [item["artifact_type"] for item in descriptors] == ["annotations", "detail"]
    assert {item["reason"] for item in skipped} == {
        "external_cache",
        "directory_artifact",
        "bounded_import_limit",
    }


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
