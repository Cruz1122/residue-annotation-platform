import hashlib
import json
from pathlib import Path

from app.core.config import Settings
from app.features.annotations.models import ANNOTATION_TABLES
from app.features.runs.models import Artifact, Run, RunStage, StageResult
from app.features.runs.remote_executor import SSHStageExecutor
from app.features.runs.worker_service import claim_ready_stage
from app.infrastructure.hpc.base import JobHandle, JobRequest, JobState, JobStatus
from sqlalchemy import select

SEQUENCE = "ACDEFGHIKLMNPQRSTVWY"


class FakeCompletedRemote:
    def __init__(self, run_id: str):
        self.run_id = run_id
        self.job_id = "fake-slurm-101"
        self.requests: list[JobRequest] = []
        self.annotations = (
            "aa_position\taa_ref\taccession\n"
            + "".join(
                f"{position}\t{amino_acid}\tP00001\n"
                for position, amino_acid in enumerate(SEQUENCE, start=1)
            )
        ).encode()
        self.summary = b'{"accession":"P00001","status":"verified"}\n'
        self.remote_run = f"/gpfs/test/runs/{run_id}"
        self.result_directory = f"{self.remote_run}/results/protein_identity"

    def ensure_directory(self, remote_path: str) -> None:
        assert remote_path == f"/gpfs/test/.platform_jobs/{self.run_id}"

    def submit(self, request: JobRequest) -> JobHandle:
        self.requests.append(request)
        return JobHandle(job_id=self.job_id, state=JobState.QUEUED)

    def status(self, job_id: str) -> JobStatus:
        assert job_id == self.job_id
        return JobStatus(job_id=job_id, state=JobState.SUCCESS)

    def read_text(self, remote_path: str, max_bytes: int) -> str:
        if remote_path.endswith("protein_identity.result"):
            return self.remote_run
        if remote_path.endswith("run_context.json"):
            return json.dumps(
                {"stage_results": {"protein_identity": {"result_dir": self.result_directory}}}
            )
        if remote_path.endswith("result_manifest.json"):
            return json.dumps(
                {
                    "schema": "stage-result-v1",
                    "stage_id": "protein_identity",
                    "status": "success",
                    "cache_key": "b" * 64,
                    "annotations": "annotations.tsv",
                    "file_integrity": {
                        "annotations": {
                            "sha256": hashlib.sha256(self.annotations).hexdigest(),
                            "size": len(self.annotations),
                        }
                    },
                    "artifacts": {
                        "summary": {
                            "path": "summary.json",
                            "sha256": hashlib.sha256(self.summary).hexdigest(),
                            "size": len(self.summary),
                        }
                    },
                }
            )
        if remote_path.endswith("provenance.json"):
            return json.dumps({"tool": "fake-pipeline", "version": "1.0"})
        raise AssertionError(f"unexpected remote read: {remote_path}")

    def download_to(
        self,
        remote_path: str,
        local_path: Path,
        max_bytes: int,
    ) -> tuple[int, str]:
        payload = self.annotations if remote_path.endswith("annotations.tsv") else self.summary
        assert len(payload) <= max_bytes
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(payload)
        return len(payload), hashlib.sha256(payload).hexdigest()


def test_submit_poll_and_ingest_persist_a_linked_stage_result(client, session, tmp_path: Path):
    protein = client.post(
        "/api/v1/proteins",
        json={
            "sequence": SEQUENCE,
            "aliases": [{"source": "uniprot", "identifier": "P00001"}],
        },
    )
    assert protein.status_code == 201
    created_run = client.post(
        "/api/v1/runs",
        json={"protein_id": protein.json()["id"]},
    )
    assert created_run.status_code == 201

    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_remote_root="/gpfs/test",
    )
    stage = claim_ready_stage(session, settings)
    assert stage is not None
    assert stage.stage_id == "protein_identity"

    remote = FakeCompletedRemote(created_run.json()["id"])
    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    executor.client = remote

    executor.submit_stage(session, stage)
    assert stage.slurm_job_id == remote.job_id
    assert len(remote.requests) == 1
    assert remote.requests[0].stage_id == "protein_identity"

    assert executor.poll_stage(session, stage) is True
    session.expire_all()

    persisted_stage = session.get(RunStage, stage.id)
    assert persisted_stage is not None
    assert persisted_stage.status == "success"
    assert persisted_stage.stage_result_id is not None

    result = session.get(StageResult, persisted_stage.stage_result_id)
    assert result is not None
    assert result.published_at is not None
    assert result.protein_id == protein.json()["id"]
    assert result.owner_id == session.get(Run, created_run.json()["id"]).owner_id
    assert result.status == "success"

    artifacts = list(session.scalars(select(Artifact).where(Artifact.stage_result_id == result.id)))
    assert {artifact.artifact_type for artifact in artifacts} == {"annotations", "summary"}
    artifact_namespaces = {"/".join(artifact.storage_key.split("/")[:4]) for artifact in artifacts}
    assert len(artifact_namespaces) == 1
    assert all((settings.artifact_root / artifact.storage_key).is_file() for artifact in artifacts)

    annotation_table = ANNOTATION_TABLES["protein_identity"]
    rows = session.execute(
        select(annotation_table)
        .where(annotation_table.c.stage_result_id == result.id)
        .order_by(annotation_table.c.aa_position)
    ).mappings()
    annotations = list(rows)
    assert len(annotations) == len(SEQUENCE)
    assert annotations[0]["aa_position"] == 1
    assert annotations[0]["aa_ref"] == "A"
    assert annotations[0]["values"] == {"accession": "P00001"}
