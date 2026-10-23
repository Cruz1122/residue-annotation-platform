import hashlib
import io
import os
from zipfile import ZipFile

import pytest
from app.features.artifacts.presentation import artifact_presentation, safe_download_media_type
from app.features.artifacts.storage import ArtifactIntegrityError, ArtifactStore
from app.features.proteins.models import Protein
from app.features.runs.models import Artifact, Run, RunStage, StageResult

HEADERS = {"X-User-Id": "u1", "X-Project-Id": "p1"}


def _artifact_with_recorded_size(client, session, size: int) -> str:
    protein = Protein(
        sequence="ACDE",
        length=4,
        sequence_sha256=hashlib.sha256(b"ACDE").hexdigest(),
        owner_id="u1",
        project_id="p1",
    )
    session.add(protein)
    session.flush()
    run = Run(protein_id=protein.id, status="success", owner_id="u1", project_id="p1")
    session.add(run)
    session.flush()
    result = StageResult(
        protein_id=protein.id,
        stage_id="protein_identity",
        cache_key="d" * 64,
        status="success",
        provenance={"tool": "test"},
        owner_id="u1",
        project_id="p1",
    )
    session.add(result)
    session.flush()
    session.add(
        RunStage(
            run_id=run.id,
            stage_id="protein_identity",
            status="success",
            stage_result_id=result.id,
        )
    )
    artifact = Artifact(
        stage_result_id=result.id,
        artifact_type="annotations",
        storage_backend="filesystem",
        storage_key="artifact/content.bin",
        sha256=hashlib.sha256(b"data").hexdigest(),
        size=size,
    )
    session.add(artifact)
    session.commit()
    return artifact.id


def _artifact_with_content(
    session, tmp_path, content: bytes, artifact_type: str, media_type: str
) -> str:
    protein = Protein(
        sequence="ACDE",
        length=4,
        sequence_sha256=hashlib.sha256(b"ACDE").hexdigest(),
        owner_id="u1",
        project_id="p1",
    )
    session.add(protein)
    session.flush()
    run = Run(protein_id=protein.id, status="success", owner_id="u1", project_id="p1")
    session.add(run)
    session.flush()
    result = StageResult(
        protein_id=protein.id,
        stage_id="variant_ddg",
        cache_key="e" * 64,
        status="success",
        provenance={"tool": "test"},
        owner_id="u1",
        project_id="p1",
    )
    session.add(result)
    session.flush()
    session.add(
        RunStage(
            run_id=run.id,
            stage_id="variant_ddg",
            status="success",
            stage_result_id=result.id,
        )
    )
    storage_key = f"artifact/{artifact_type}.tsv"
    stored = tmp_path / "artifacts" / storage_key
    stored.parent.mkdir(parents=True, exist_ok=True)
    stored.write_bytes(content)
    artifact = Artifact(
        stage_result_id=result.id,
        artifact_type=artifact_type,
        storage_backend="filesystem",
        storage_key=storage_key,
        sha256=hashlib.sha256(content).hexdigest(),
        size=len(content),
        media_type=media_type,
    )
    session.add(artifact)
    session.commit()
    return artifact.id


def test_missing_artifact_file_returns_404(client, session):
    artifact_id = _artifact_with_recorded_size(client, session, size=4)

    response = client.get(f"/api/v1/artifacts/{artifact_id}/content", headers=HEADERS)

    assert response.status_code == 404
    assert response.json()["detail"] == "Artifact content unavailable"


def test_artifact_size_mismatch_returns_409(client, session, tmp_path):
    artifact_id = _artifact_with_recorded_size(client, session, size=4)
    stored = tmp_path / "artifacts" / "artifact" / "content.bin"
    stored.parent.mkdir(parents=True, exist_ok=True)
    stored.write_bytes(b"12345")

    response = client.get(f"/api/v1/artifacts/{artifact_id}/content", headers=HEADERS)

    assert response.status_code == 409
    assert response.json()["detail"] == "Artifact content does not match its record"


def test_artifact_digest_mismatch_returns_409(client, session, tmp_path):
    artifact_id = _artifact_with_recorded_size(client, session, size=4)
    stored = tmp_path / "artifacts" / "artifact" / "content.bin"
    stored.parent.mkdir(parents=True, exist_ok=True)
    stored.write_bytes(b"tamp")

    response = client.get(f"/api/v1/artifacts/{artifact_id}/content", headers=HEADERS)

    assert response.status_code == 409
    assert response.json()["detail"] == "Artifact content does not match its record"


def test_artifact_download_serves_matching_content(client, session, tmp_path):
    artifact_id = _artifact_with_recorded_size(client, session, size=4)
    stored = tmp_path / "artifacts" / "artifact" / "content.bin"
    stored.parent.mkdir(parents=True, exist_ok=True)
    stored.write_bytes(b"data")

    response = client.get(f"/api/v1/artifacts/{artifact_id}/content", headers=HEADERS)

    assert response.status_code == 200
    assert response.content == b"data"
    assert response.headers["content-disposition"].startswith('attachment; filename="')
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-content-type-options"] == "nosniff"


def test_artifact_presentation_sanitizes_original_extension_and_media_type():
    presentation = artifact_presentation(
        "new_scientific_table",
        "application/octet-stream\r\nX-Injected: yes",
        "exports/report.html",
    )

    assert presentation.download_filename == "new-scientific-table.bin"
    assert safe_download_media_type("text/plain; charset=utf-8") == "text/plain"
    assert safe_download_media_type("text/plain\r\nX-Injected: yes") == "application/octet-stream"


def test_tabular_artifact_download_defaults_to_readable_excel(client, session, tmp_path):
    content = (
        b"aa_position\taa_ref\taa_alt\tddg_value\tcadd_phred_mean\tp_tm_alpha"
        b"\tvariant_ddg_R43C_sd\tnote\n43\tR\tC\t-1.25\t12.5\t0.8\t0.25\t=2+2\n"
    )
    artifact_id = _artifact_with_content(
        session,
        tmp_path,
        content,
        artifact_type="variant_annotations",
        media_type="text/tab-separated-values",
    )

    response = client.get(f"/api/v1/artifacts/{artifact_id}/content", headers=HEADERS)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    assert 'filename="resultados-de-ddg-por-variante.xlsx"' in response.headers[
        "content-disposition"
    ]
    with ZipFile(io.BytesIO(response.content)) as workbook:
        sheet = workbook.read("xl/worksheets/sheet1.xml").decode("utf-8")
    assert "Posición del residuo" in sheet
    assert "Aminoácido de referencia" in sheet
    assert "ΔΔG" in sheet
    assert "Media CADD PHRED" in sheet
    assert "Probabilidad TM α" in sheet
    assert "ΔΔG R43C · desviación estándar" in sheet
    assert "R" in sheet
    assert "=2+2" in sheet
    assert "<f>" not in sheet

    original = client.get(
        f"/api/v1/artifacts/{artifact_id}/content?format=original", headers=HEADERS
    )
    assert original.status_code == 200
    assert original.content == content
    assert original.headers["content-type"].startswith("text/tab-separated-values")


def test_native_json_artifact_keeps_its_original_format(client, session, tmp_path):
    content = b'{"rows":[{"aa_position":43,"source":"UniProt"}]}'
    artifact_id = _artifact_with_content(
        session,
        tmp_path,
        content,
        artifact_type="selected_reference_json",
        media_type="application/json",
    )

    metadata = client.get(f"/api/v1/artifacts/{artifact_id}", headers=HEADERS)
    response = client.get(f"/api/v1/artifacts/{artifact_id}/content", headers=HEADERS)

    assert metadata.status_code == 200
    assert metadata.json()["display_name"] == "Referencia estructural seleccionada (JSON)"
    assert metadata.json()["format_label"] == "JSON"
    assert metadata.json()["download_format"] == "original"
    assert response.status_code == 200
    assert response.content == content
    assert response.headers["content-type"].startswith("application/json")
    assert 'filename="referencia-estructural-seleccionada-json.json"' in response.headers[
        "content-disposition"
    ]


def test_verified_artifact_stream_uses_the_hashed_descriptor(tmp_path):
    from app.core.config import Settings

    stored = tmp_path / "artifacts" / "artifact" / "content.bin"
    stored.parent.mkdir(parents=True, exist_ok=True)
    stored.write_bytes(b"data")
    store = ArtifactStore(Settings(artifact_root=tmp_path / "artifacts"))

    stream = store.open_verified(
        "artifact/content.bin",
        size=4,
        sha256=hashlib.sha256(b"data").hexdigest(),
    )
    try:
        assert stream.read() == b"data"
    finally:
        stream.close()

    with pytest.raises(ArtifactIntegrityError):
        store.open_verified(
            "artifact/content.bin",
            size=4,
            sha256=hashlib.sha256(b"tampered").hexdigest(),
        )


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="named pipes are not supported")
def test_verified_artifact_stream_rejects_special_files(tmp_path):
    from app.core.config import Settings
    from app.features.artifacts.storage import ArtifactPathError

    stored = tmp_path / "artifacts" / "artifact" / "pipe"
    stored.parent.mkdir(parents=True, exist_ok=True)
    os.mkfifo(stored)
    store = ArtifactStore(Settings(artifact_root=tmp_path / "artifacts"))

    with pytest.raises(ArtifactPathError):
        store.open_verified("artifact/pipe", size=0, sha256=hashlib.sha256(b"").hexdigest())


def test_artifact_metadata_never_exposes_storage_or_gpfs_paths(client, session):
    artifact_id = _artifact_with_recorded_size(client, session, size=4)

    response = client.get(f"/api/v1/artifacts/{artifact_id}", headers=HEADERS)

    assert response.status_code == 200
    payload = response.json()
    assert "storage_key" not in payload
    assert "/gpfs/" not in str(payload)
    assert payload["download_url"] == f"/api/v1/artifacts/{artifact_id}/content"


def test_foreign_principal_cannot_read_or_download_artifact(client, session):
    artifact_id = _artifact_with_recorded_size(client, session, size=4)
    foreign_headers = {"X-User-Id": "other-user", "X-Project-Id": "other-project"}

    metadata = client.get(f"/api/v1/artifacts/{artifact_id}", headers=foreign_headers)
    content = client.get(f"/api/v1/artifacts/{artifact_id}/content", headers=foreign_headers)

    assert metadata.status_code == 404
    assert content.status_code == 404
