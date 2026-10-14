import hashlib
import json
from pathlib import Path

import pytest
from app.core.config import Settings
from app.features.annotations.service import insert_annotation_rows
from app.features.artifacts.storage import ArtifactStore
from app.features.runs.models import Artifact, Run, RunStage, StageResult
from app.features.runs.remote_executor import (
    RemoteStageExecutionError,
    SSHStageExecutor,
    _parse_annotation_rows,
)
from app.features.runs.state import RunStageStatus
from sqlalchemy import select

SEQUENCE = "ACDEFGHIKLMNPQRSTVWY"


def _create_run(client) -> str:
    protein = client.post("/api/v1/proteins", json={"sequence": SEQUENCE})
    assert protein.status_code == 201
    run = client.post("/api/v1/runs", json={"protein_id": protein.json()["id"]})
    assert run.status_code == 201
    return run.json()["id"]


def _publish_rows(
    session,
    run_id: str,
    stage_id: str,
    rows: list[tuple[int, str, dict]],
) -> str:
    run = session.get(Run, run_id)
    stage = next(item for item in run.stages if item.stage_id == stage_id)
    result = StageResult(
        protein_id=run.protein_id,
        stage_id=stage_id,
        cache_key=hashlib.sha256(stage_id.encode()).hexdigest(),
        status="success",
        provenance={"tool": "verified-test"},
        owner_id=run.owner_id,
        project_id=run.project_id,
    )
    session.add(result)
    session.flush()
    stage.stage_result_id = result.id
    stage.status = RunStageStatus.SUCCESS
    insert_annotation_rows(
        session,
        stage_id,
        result.id,
        [
            {"aa_position": position, "aa_ref": aa_ref, "values": values}
            for position, aa_ref, values in rows
        ],
    )
    session.commit()
    return result.id


def _published_protein_identity_run(client, session, rows: int = 5) -> str:
    run_id = _create_run(client)
    _publish_rows(
        session,
        run_id,
        "protein_identity",
        [
            (position, SEQUENCE[position - 1], {"score": position / 10})
            for position in range(1, rows + 1)
        ],
    )
    return run_id


def test_annotations_endpoint_paginates_and_reports_truncation(client, session):
    run_id = _published_protein_identity_run(client, session, rows=5)

    first = client.get(f"/api/v1/runs/{run_id}/annotations?limit=2")
    assert first.status_code == 200
    assert [row["aa_position"] for row in first.json()["rows"]] == [1, 2]
    assert first.json()["truncated"] is True

    last = client.get(f"/api/v1/runs/{run_id}/annotations?limit=2&offset=4")
    assert [row["aa_position"] for row in last.json()["rows"]] == [5]
    assert last.json()["truncated"] is False

    default_page = client.get(f"/api/v1/runs/{run_id}/annotations")
    assert len(default_page.json()["rows"]) == 5
    assert default_page.json()["truncated"] is False


def test_annotations_endpoint_rejects_invalid_pagination(client, session):
    run_id = _published_protein_identity_run(client, session, rows=1)

    assert client.get(f"/api/v1/runs/{run_id}/annotations?limit=0").status_code == 422
    assert client.get(f"/api/v1/runs/{run_id}/annotations?offset=-1").status_code == 422


def test_annotations_pagination_spans_multiple_stages(client, session):
    run_id = _create_run(client)
    _publish_rows(
        session,
        run_id,
        "protein_identity",
        [
            (1, "A", {"kind": "identity"}),
            (2, "C", {"kind": "identity"}),
            (3, "D", {"kind": "identity"}),
        ],
    )
    _publish_rows(
        session,
        run_id,
        "physicochemical_context",
        [(1, "A", {"kind": "context"}), (2, "C", {"kind": "context"})],
    )

    first_page = client.get(f"/api/v1/runs/{run_id}/annotations?limit=4")
    assert first_page.status_code == 200
    assert [row["aa_position"] for row in first_page.json()["rows"]] == [1, 2, 3, 1]
    assert first_page.json()["rows"][3]["values"] == {"kind": "context"}
    assert first_page.json()["truncated"] is True

    deep_page = client.get(f"/api/v1/runs/{run_id}/annotations?offset=3&limit=3")
    assert [row["values"] for row in deep_page.json()["rows"]] == [
        {"kind": "context"},
        {"kind": "context"},
    ]
    assert deep_page.json()["truncated"] is False

    final_page = client.get(f"/api/v1/runs/{run_id}/annotations?offset=4&limit=10")
    assert [row["aa_position"] for row in final_page.json()["rows"]] == [2]
    assert final_page.json()["rows"][0]["values"] == {"kind": "context"}
    assert final_page.json()["truncated"] is False


def _stage_for_consumer(
    session,
    client,
    stage_id: str = "protein_identity",
) -> RunStage:
    protein = client.post("/api/v1/proteins", json={"sequence": SEQUENCE})
    assert protein.status_code == 201
    protein_id = protein.json()["id"]
    run_id = client.post("/api/v1/runs", json={"protein_id": protein_id}).json()["id"]
    run = session.get(Run, run_id)
    stage = next(item for item in run.stages if item.stage_id == stage_id)
    result = StageResult(
        protein_id=protein_id,
        stage_id=stage_id,
        cache_key=hashlib.sha256(stage_id.encode()).hexdigest(),
        status="success",
        provenance={"tool": "verified-test"},
        owner_id=run.owner_id,
        project_id=run.project_id,
    )
    session.add(result)
    session.flush()
    stage.stage_result_id = result.id
    stage.status = RunStageStatus.SUCCESS
    session.commit()
    return stage


def _consumer() -> SSHStageExecutor:
    return SSHStageExecutor.__new__(SSHStageExecutor)


def test_annotation_consumer_rejects_duplicate_positions(client, session, tmp_path: Path):
    stage = _stage_for_consumer(session, client)
    annotations = tmp_path / "rows.tsv"
    annotations.write_text(
        "aa_position\taa_ref\tscore\n1\tA\t0.1\n1\tA\t0.2\n",
        encoding="utf-8",
    )

    with pytest.raises(RemoteStageExecutionError):
        _consumer()._consume_annotation_file(
            session,
            local_path=annotations,
            stage=stage,
            stage_result_id=str(stage.stage_result_id),
        )


def test_annotation_consumer_rejects_reference_mismatch(client, session, tmp_path: Path):
    stage = _stage_for_consumer(session, client)
    annotations = tmp_path / "rows.tsv"
    annotations.write_text(
        "aa_position\taa_ref\tscore\n1\tY\t0.1\n",
        encoding="utf-8",
    )

    with pytest.raises(RemoteStageExecutionError):
        _consumer()._consume_annotation_file(
            session,
            local_path=annotations,
            stage=stage,
            stage_result_id=str(stage.stage_result_id),
        )


def test_annotation_consumer_requires_full_coverage_for_identity(client, session, tmp_path: Path):
    stage = _stage_for_consumer(session, client)
    annotations = tmp_path / "rows.tsv"
    annotations.write_text(
        "aa_position\taa_ref\tscore\n1\tA\t0.1\n",
        encoding="utf-8",
    )

    with pytest.raises(RemoteStageExecutionError):
        _consumer()._consume_annotation_file(
            session,
            local_path=annotations,
            stage=stage,
            stage_result_id=str(stage.stage_result_id),
        )


def test_parse_annotation_rows_accepts_valid_tsv():
    rows = _parse_annotation_rows("aa_position\taa_ref\tscore\n1\tA\t0.5\n2\tC\t0.7\n")

    assert [row["aa_position"] for row in rows] == [1, 2]
    assert rows[0]["values"] == {"score": "0.5"}
    assert rows[0]["qc_status"] == "verified"


def test_reusable_result_requires_existing_artifacts(client, session, tmp_path: Path):
    stage = _stage_for_consumer(session, client)
    result = session.get(StageResult, stage.stage_result_id)
    assert result is not None
    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
    )
    store = ArtifactStore(settings)
    storage_key = "remote/reuse/annotations.tsv"
    path = store.resolve(storage_key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"data")
    session.add(
        Artifact(
            stage_result_id=result.id,
            artifact_type="annotations",
            storage_backend="filesystem",
            storage_key=storage_key,
            sha256=hashlib.sha256(b"data").hexdigest(),
            size=4,
        )
    )
    session.commit()
    executor = SSHStageExecutor.__new__(SSHStageExecutor)

    found = executor._find_reusable_result(session, stage, result.cache_key, store)
    assert found is not None
    assert found.id == result.id

    path.write_bytes(b"tampered")
    assert executor._find_reusable_result(session, stage, result.cache_key, store) is None

    path.unlink()
    assert executor._find_reusable_result(session, stage, result.cache_key, store) is None


def test_ingest_result_reuses_existing_cache_entry(client, session, tmp_path: Path):
    stage = _stage_for_consumer(session, client)
    result = session.get(StageResult, stage.stage_result_id)
    assert result is not None
    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_remote_root="/gpfs/root",
    )
    store = ArtifactStore(settings)
    storage_key = "remote/reuse/annotations.tsv"
    path = store.resolve(storage_key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"data")
    session.add(
        Artifact(
            stage_result_id=result.id,
            artifact_type="annotations",
            storage_backend="filesystem",
            storage_key=storage_key,
            sha256=hashlib.sha256(b"data").hexdigest(),
            size=4,
        )
    )
    session.commit()
    manifest = {
        "schema": "stage-result-v1",
        "stage_id": "protein_identity",
        "status": "success",
        "cache_key": result.cache_key,
        "annotations": "rows.tsv",
        "artifacts": {"model": {"path": "model.cif", "sha256": "b" * 64, "size": 4}},
    }

    class _FakeClient:
        def read_text(self, remote_path: str, max_bytes: int) -> str:
            if remote_path.endswith(".result"):
                return "/gpfs/root/runs/run-1"
            if remote_path.endswith("run_context.json"):
                return json.dumps({"stage_results": {}})
            if remote_path.endswith("result_manifest.json"):
                return json.dumps(manifest)
            if remote_path.endswith("provenance.json"):
                return "{}"
            raise RuntimeError(f"unexpected read: {remote_path}")

    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    executor.client = _FakeClient()

    reused_id, reused = executor._ingest_result(session, stage)

    assert reused is True
    assert reused_id == result.id


def test_stale_cache_entry_is_purged_and_republished(client, session, tmp_path: Path):
    stage = _stage_for_consumer(session, client, "physicochemical_context")
    result = session.get(StageResult, stage.stage_result_id)
    assert result is not None
    old_id = result.id
    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_remote_root="/gpfs/root",
    )
    session.add(
        Artifact(
            stage_result_id=result.id,
            artifact_type="annotations",
            storage_backend="filesystem",
            storage_key="remote/stale/annotations.tsv",
            sha256="a" * 64,
            size=4,
        )
    )
    session.commit()
    annotations = b"aa_position\taa_ref\tscore\n1\tA\t0.5\n2\tC\t0.7\n"
    artifact_payload = b"data"
    manifest = {
        "schema": "stage-result-v1",
        "stage_id": "physicochemical_context",
        "status": "success",
        "cache_key": result.cache_key,
        "annotations": "rows.tsv",
        "artifacts": {
            "model": {
                "path": "model.cif",
                "sha256": hashlib.sha256(artifact_payload).hexdigest(),
                "size": len(artifact_payload),
            }
        },
    }

    class _FakeClient:
        def read_text(self, remote_path: str, max_bytes: int) -> str:
            if remote_path.endswith(".result"):
                return "/gpfs/root/runs/run-1"
            if remote_path.endswith("run_context.json"):
                return json.dumps({"stage_results": {}})
            if remote_path.endswith("result_manifest.json"):
                return json.dumps(manifest)
            if remote_path.endswith("provenance.json"):
                return "{}"
            raise RuntimeError(f"unexpected read: {remote_path}")

        def download_to(
            self, remote_path: str, local_path: Path, max_bytes: int
        ) -> tuple[int, str]:
            payload = annotations if remote_path.endswith("rows.tsv") else artifact_payload
            local_path.parent.mkdir(parents=True, exist_ok=True)
            local_path.write_bytes(payload)
            return len(payload), hashlib.sha256(payload).hexdigest()

    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    executor.client = _FakeClient()

    new_id, reused = executor._ingest_result(session, stage)

    assert reused is False
    assert new_id != old_id
    assert session.get(StageResult, old_id) is None
    remaining = list(
        session.scalars(select(StageResult).where(StageResult.cache_key == result.cache_key))
    )
    assert len(remaining) == 1
    assert remaining[0].id == new_id
