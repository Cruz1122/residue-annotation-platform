import hashlib
import os

import pytest
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
