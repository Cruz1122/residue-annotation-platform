import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from app.core.config import Settings
from app.features.annotations.models import ANNOTATION_TABLES
from app.features.artifacts.storage import ArtifactStore
from app.features.runs.cache import (
    expected_artifact_types_for_stage,
    planned_stage_cache_identity,
)
from app.features.runs.models import Artifact, Run, RunStage, StageResult
from app.features.runs.remote_executor import (
    RemoteStageExecutionError,
    SSHStageExecutor,
    _expected_remote_provenance_binding,
    _validate_legacy_remote_cache_contract,
    _validated_local_cache_plan,
)
from app.features.runs.worker_service import claim_ready_stage
from app.features.stages.registry import STAGE_BY_ID
from app.infrastructure.hpc.base import (
    HPCConfigurationError,
    HPCTransportError,
    JobHandle,
    JobRequest,
    JobState,
    JobStatus,
)
from app.infrastructure.hpc.transfer import (
    remote_pipeline_input_namespace,
    remote_pipeline_input_path,
)
from paramiko.ssh_exception import AuthenticationException, BadHostKeyException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

SEQUENCE = "ACDEFGHIKLMNPQRSTVWY"


def _artifact_entries(stage_id: str, payload: bytes) -> dict[str, dict[str, object]]:
    digest = hashlib.sha256(payload).hexdigest()
    return {
        artifact_type: {
            "path": f"/gpfs/test/cache/{artifact_type}.json",
            "external": True,
            "sha256": digest,
            "size": len(payload),
        }
        for artifact_type in sorted(expected_artifact_types_for_stage(stage_id) - {"annotations"})
    }


def _bind_remote(remote: object, stage: RunStage, cache_key: str) -> None:
    binding = _expected_remote_provenance_binding(stage, cache_key)
    remote.provenance = json.dumps(
        {
            "tool": "fake-pipeline",
            "version": "1.0",
            "platform_binding": binding,
        },
        sort_keys=True,
    ).encode()


def _prepare_remote(remote: object, stage: RunStage) -> str:
    dependency_cache_keys = {
        dependency: hashlib.sha256(f"test:{dependency}".encode()).hexdigest()
        for dependency in STAGE_BY_ID[stage.stage_id].dependencies
    }
    cache_key, cache_factors = planned_stage_cache_identity(
        stage,
        stage.run.configuration,
        dependency_cache_keys,
    )
    stage.cache_key = cache_key
    stage.cache_factors = cache_factors
    remote.cache_key = cache_key
    _bind_remote(remote, stage, cache_key)
    return cache_key


class FakeCompletedRemote:
    def __init__(self, run_id: str):
        self.run_id = run_id
        self.job_id = "fake-slurm-101"
        self.requests: list[JobRequest] = []
        self.annotations = (
            "protein_id\taa_position\taa_ref\tgene\taccession\n"
            + "".join(
                f"P00001\t{position}\t{amino_acid}\tGENE1\tP00001\n"
                for position, amino_acid in enumerate(SEQUENCE, start=1)
            )
        ).encode()
        self.summary = b'{"accession":"P00001","status":"verified"}\n'
        self.provenance = b'{"tool":"fake-pipeline","version":"1.0"}'
        self.cache_key = "b" * 64
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
        if remote_path.endswith("DONE"):
            return "OK\n"
        if remote_path.endswith("result_manifest.json"):
            return json.dumps(
                {
                    "schema": "stage-result-v1",
                    "stage_id": "protein_identity",
                    "status": "success",
                    "cache_key": self.cache_key,
                    "annotations": "annotations.tsv",
                    "file_integrity": {
                        "annotations": {
                            "sha256": hashlib.sha256(self.annotations).hexdigest(),
                            "size": len(self.annotations),
                        },
                        "provenance.json": {
                            "sha256": hashlib.sha256(self.provenance).hexdigest(),
                            "size": len(self.provenance),
                        },
                    },
                    "artifacts": _artifact_entries("protein_identity", self.summary),
                }
            )
        if remote_path.endswith("provenance.json"):
            return self.provenance.decode("utf-8")
        raise AssertionError(f"unexpected remote read: {remote_path}")

    def download_to(
        self,
        remote_path: str,
        local_path: Path,
        max_bytes: int,
    ) -> tuple[int, str]:
        if remote_path.endswith("summary.json"):
            assert remote_path == "/gpfs/test/cache/summary.json"
        payload = self.annotations if remote_path.endswith("annotations.tsv") else self.summary
        assert len(payload) <= max_bytes
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(payload)
        return len(payload), hashlib.sha256(payload).hexdigest()


class FakeArtifactOnlyRemote(FakeCompletedRemote):
    """Remote stage result whose contract publishes artifacts but no table."""

    stage_id = "conformational_ensemble"

    def __init__(self, run_id: str):
        super().__init__(run_id)
        self.provenance = b'{"tool":"fake-structure-pipeline","version":"1.0"}'
        self.cache_key = "c" * 64
        self.result_directory = f"{self.remote_run}/results/{self.stage_id}"

    def read_text(self, remote_path: str, max_bytes: int) -> str:
        if remote_path.endswith(f"{self.stage_id}.result"):
            return self.remote_run
        if remote_path.endswith("run_context.json"):
            return json.dumps(
                {"stage_results": {self.stage_id: {"result_dir": self.result_directory}}}
            )
        if remote_path.endswith("DONE"):
            return "OK\n"
        if remote_path.endswith("result_manifest.json"):
            return json.dumps(
                {
                    "schema": "stage-result-v1",
                    "stage_id": self.stage_id,
                    "status": "success",
                    "partial": False,
                    "cache_key": self.cache_key,
                    "file_integrity": {
                        "provenance.json": {
                            "sha256": hashlib.sha256(self.provenance).hexdigest(),
                            "size": len(self.provenance),
                        }
                    },
                    "artifacts": _artifact_entries(self.stage_id, self.summary),
                }
            )
        if remote_path.endswith("provenance.json"):
            return self.provenance.decode("utf-8")
        raise AssertionError(f"unexpected remote read: {remote_path}")


class FakeDirectoryArtifactRemote(FakeArtifactOnlyRemote):
    def read_text(self, remote_path: str, max_bytes: int) -> str:
        if remote_path.endswith("result_manifest.json"):
            manifest = json.loads(super().read_text(remote_path, max_bytes))
            manifest["artifacts"]["conformational_ensemble_final_dir"] = {
                "path": "conformational_ensemble_final_dir",
                "external": False,
                "sha256": None,
                "size": None,
            }
            return json.dumps(manifest)
        return super().read_text(remote_path, max_bytes)

    def download_directory_to(
        self,
        remote_path: str,
        local_path: Path,
        max_bytes: int,
        max_entries: int,
    ) -> tuple[int, str]:
        assert remote_path.endswith(
            "/results/conformational_ensemble/conformational_ensemble_final_dir"
        )
        payload = b"deterministic-directory-archive"
        assert len(payload) <= max_bytes
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(payload)
        return len(payload), hashlib.sha256(payload).hexdigest()


class FakeCollidingArtifactRemote(FakeCompletedRemote):
    def read_text(self, remote_path: str, max_bytes: int) -> str:
        if remote_path.endswith("result_manifest.json"):
            manifest = json.loads(super().read_text(remote_path, max_bytes))
            manifest["artifacts"]["canonical_fasta"] = {
                "path": "/gpfs/test/cache/a/model.cif",
                "external": True,
                "sha256": hashlib.sha256(self.summary).hexdigest(),
                "size": len(self.summary),
            }
            manifest["artifacts"]["protein_identity"] = {
                "path": "/gpfs/test/cache/b/model.cif",
                "external": True,
                "sha256": hashlib.sha256(self.summary).hexdigest(),
                "size": len(self.summary),
            }
            return json.dumps(manifest)
        return super().read_text(remote_path, max_bytes)


class FakeNonCanonicalArtifactRemote(FakeCompletedRemote):
    def read_text(self, remote_path: str, max_bytes: int) -> str:
        if remote_path.endswith("result_manifest.json"):
            manifest = json.loads(super().read_text(remote_path, max_bytes))
            manifest["artifacts"]["protein/identity"] = manifest["artifacts"].pop(
                "protein_identity"
            )
            return json.dumps(manifest)
        return super().read_text(remote_path, max_bytes)


class FakeReservedAnnotationsArtifactRemote(FakeCompletedRemote):
    def read_text(self, remote_path: str, max_bytes: int) -> str:
        if remote_path.endswith("result_manifest.json"):
            manifest = json.loads(super().read_text(remote_path, max_bytes))
            manifest["artifacts"]["annotations"] = manifest["artifacts"]["canonical_fasta"]
            return json.dumps(manifest)
        return super().read_text(remote_path, max_bytes)


class FakeTruncatedManifestRemote(FakeCompletedRemote):
    def read_text(self, remote_path: str, max_bytes: int) -> str:
        if remote_path.endswith("result_manifest.json"):
            return '{"schema":"stage-result-v1"'
        return super().read_text(remote_path, max_bytes)


class FakeTamperedProvenanceRemote(FakeCompletedRemote):
    def read_text(self, remote_path: str, max_bytes: int) -> str:
        if remote_path.endswith("provenance.json"):
            return '{"tool":"tampered","version":"1.0"}'
        return super().read_text(remote_path, max_bytes)


class FakeInvalidCanonicalAnnotationsRemote(FakeCompletedRemote):
    def __init__(self, run_id: str, *, wrong_protein: bool = False):
        super().__init__(run_id)
        lines = self.annotations.splitlines()
        if wrong_protein:
            lines[1] = lines[1].replace(b"P00001\t1\tA", b"OTHER\t1\tA", 1)
        else:
            lines = lines[:-1]
        self.annotations = b"\n".join(lines) + b"\n"

    def read_text(self, remote_path: str, max_bytes: int) -> str:
        if remote_path.endswith("result_manifest.json"):
            manifest = json.loads(super().read_text(remote_path, max_bytes))
            manifest["file_integrity"]["annotations"] = {
                "sha256": hashlib.sha256(self.annotations).hexdigest(),
                "size": len(self.annotations),
            }
            return json.dumps(manifest)
        return super().read_text(remote_path, max_bytes)


class FakeUnavailableRemote:
    def read_text(self, _remote_path: str, _max_bytes: int) -> str:
        raise RuntimeError("remote path /gpfs/private/secret is unavailable")


class FakeTransportUnavailableRemote(FakeCompletedRemote):
    def status(self, job_id: str) -> JobStatus:
        raise HPCTransportError("SSH transport is unavailable")


class FakeTransportUnavailableDuringIngest(FakeCompletedRemote):
    def read_text(self, _remote_path: str, _max_bytes: int) -> str:
        raise HPCTransportError("SSH transport is unavailable")


class FakeAuthenticationStatusRemote(FakeCompletedRemote):
    def status(self, _job_id: str) -> JobStatus:
        raise AuthenticationException("authentication failed")


class FakeBadHostStatusRemote(FakeCompletedRemote):
    def status(self, _job_id: str) -> JobStatus:
        raise BadHostKeyException("mn5.example", None, None)


class FakeConfigurationStatusRemote(FakeCompletedRemote):
    def status(self, _job_id: str) -> JobStatus:
        raise HPCConfigurationError("squeue is not configured")


class FakeAuthenticationDuringIngestRemote(FakeCompletedRemote):
    def read_text(self, _remote_path: str, _max_bytes: int) -> str:
        raise AuthenticationException("authentication failed")


class FakeBadHostDuringIngestRemote(FakeCompletedRemote):
    def read_text(self, _remote_path: str, _max_bytes: int) -> str:
        raise BadHostKeyException("mn5.example", None, None)


class FakeConfigurationDuringIngestRemote(FakeCompletedRemote):
    def read_text(self, _remote_path: str, _max_bytes: int) -> str:
        raise HPCConfigurationError("result path is not configured")


def test_remote_failure_message_redacts_untrusted_paths(tmp_path: Path):
    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_remote_root="/gpfs/test",
    )
    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    executor.client = FakeUnavailableRemote()
    stage = SimpleNamespace(run_id="run-1", stage_id="protein_identity")

    message = executor._failure_message(
        stage,
        "Slurm failed at /scratch/private/output password=secret-value",
    )

    assert "/gpfs/" not in message
    assert "/scratch/" not in message
    assert "secret-value" not in message


def test_remote_script_is_cpu_only_and_defensively_skips_gpu_pipeline_stages(tmp_path: Path):
    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_remote_root="/gpfs/test",
        hpc_pipeline_cpu_budget=120,
        hpc_pipeline_gpu_budget=0,
        hpc_pipeline_pdb_substitution_enabled=False,
    )
    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    run = SimpleNamespace(
        id="run-1",
        configuration=SimpleNamespace(structure_source="provided_pdb"),
    )
    stage = SimpleNamespace(stage_id="protein_identity")

    script = executor._script(run, stage, "P00001", "/gpfs/test/.platform_jobs/run-1/result")

    assert "--cpu-budget 120" in script
    assert "--stages protein_identity" in script
    assert "--skip-stage conformational_ensemble" in script
    assert "--skip-stage membrane_topology" in script
    assert "--skip-stage sequence_frustration" in script
    assert "--skip-stage structure_modeling" in script
    assert "--gres=gpu:" not in script


@pytest.mark.parametrize(
    "remote_type",
    [FakeTransportUnavailableRemote, FakeTransportUnavailableDuringIngest],
)
def test_remote_transport_outage_keeps_accepted_stage_retryable(
    client, session, tmp_path: Path, remote_type
):
    protein = client.post(
        "/api/v1/proteins",
        json={
            "sequence": SEQUENCE,
            "aliases": [{"source": "uniprot", "identifier": "P00001"}],
        },
    )
    assert protein.status_code == 201
    created_run = client.post("/api/v1/runs", json={"protein_id": protein.json()["id"]})
    assert created_run.status_code == 201

    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_remote_root="/gpfs/test",
    )
    stage = claim_ready_stage(session, settings)
    assert stage is not None
    remote = remote_type(created_run.json()["id"])
    _prepare_remote(remote, stage)
    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    executor.client = remote

    executor.submit_stage(session, stage)
    assert executor.poll_stage(session, stage) is True

    session.expire_all()
    persisted_stage = session.get(RunStage, stage.id)
    assert persisted_stage is not None
    assert persisted_stage.status == "running"
    assert persisted_stage.error_code is None
    assert session.scalar(select(StageResult)) is None


@pytest.mark.parametrize(
    ("remote_type", "error_code"),
    [
        (FakeAuthenticationStatusRemote, "hpc_authentication_failed"),
        (FakeBadHostStatusRemote, "hpc_host_key_rejected"),
        (FakeConfigurationStatusRemote, "hpc_configuration_error"),
    ],
)
def test_non_retryable_hpc_status_errors_are_audited(
    client, session, tmp_path: Path, remote_type, error_code: str
):
    protein = client.post(
        "/api/v1/proteins",
        json={
            "sequence": SEQUENCE,
            "aliases": [{"source": "uniprot", "identifier": "P00001"}],
        },
    )
    assert protein.status_code == 201
    created_run = client.post("/api/v1/runs", json={"protein_id": protein.json()["id"]})
    assert created_run.status_code == 201

    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_remote_root="/gpfs/test",
    )
    stage = claim_ready_stage(session, settings)
    assert stage is not None
    remote = remote_type(created_run.json()["id"])
    _prepare_remote(remote, stage)
    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    executor.client = remote

    executor.submit_stage(session, stage)
    assert executor.poll_stage(session, stage) is True

    session.expire_all()
    persisted_stage = session.get(RunStage, stage.id)
    assert persisted_stage is not None
    assert persisted_stage.status == "failed"
    assert persisted_stage.error_code == error_code
    assert persisted_stage.error_message in {
        "HPC authentication failed",
        "HPC host key was rejected",
        "HPC configuration is invalid",
    }
    assert session.scalar(select(StageResult)) is None


@pytest.mark.parametrize(
    ("remote_type", "error_code"),
    [
        (FakeAuthenticationDuringIngestRemote, "hpc_authentication_failed"),
        (FakeBadHostDuringIngestRemote, "hpc_host_key_rejected"),
        (FakeConfigurationDuringIngestRemote, "hpc_configuration_error"),
    ],
)
def test_non_retryable_hpc_result_errors_are_audited(
    client, session, tmp_path: Path, remote_type, error_code: str
):
    protein = client.post(
        "/api/v1/proteins",
        json={
            "sequence": SEQUENCE,
            "aliases": [{"source": "uniprot", "identifier": "P00001"}],
        },
    )
    assert protein.status_code == 201
    created_run = client.post("/api/v1/runs", json={"protein_id": protein.json()["id"]})
    assert created_run.status_code == 201

    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_remote_root="/gpfs/test",
    )
    stage = claim_ready_stage(session, settings)
    assert stage is not None
    remote = remote_type(created_run.json()["id"])
    _prepare_remote(remote, stage)
    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    executor.client = remote

    executor.submit_stage(session, stage)
    assert executor.poll_stage(session, stage) is True

    session.expire_all()
    persisted_stage = session.get(RunStage, stage.id)
    assert persisted_stage is not None
    assert persisted_stage.status == "failed"
    assert persisted_stage.error_code == error_code
    assert persisted_stage.error_message in {
        "HPC authentication failed",
        "HPC host key was rejected",
        "HPC configuration is invalid",
    }
    assert session.scalar(select(StageResult)) is None


@pytest.mark.parametrize(
    ("wrong_protein", "error_message"),
    [
        (True, "protein_id does not match"),
        (False, "does not cover the canonical sequence"),
    ],
)
def test_remote_annotations_require_identity_and_complete_coverage(
    client,
    session,
    tmp_path: Path,
    wrong_protein: bool,
    error_message: str,
):
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
    remote = FakeInvalidCanonicalAnnotationsRemote(
        created_run.json()["id"],
        wrong_protein=wrong_protein,
    )
    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    executor.client = remote

    _prepare_remote(remote, stage)
    executor.submit_stage(session, stage)
    assert executor.poll_stage(session, stage) is True

    session.expire_all()
    persisted_stage = session.get(RunStage, stage.id)
    assert persisted_stage is not None
    assert persisted_stage.status == "failed"
    assert persisted_stage.error_code == "remote_result_invalid"
    assert error_message in (persisted_stage.error_message or "")
    assert session.scalar(select(StageResult)) is None


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

    _prepare_remote(remote, stage)
    executor.submit_stage(session, stage)
    assert stage.slurm_job_id == remote.job_id
    assert len(remote.requests) == 1
    assert remote.requests[0].stage_id == "protein_identity"
    assert remote.requests[0].submission_receipt_path == (
        f"/gpfs/test/.platform_jobs/{created_run.json()['id']}/protein_identity.submitted"
    )
    remote_script = remote.requests[0].command[2]
    assert (
        f"python main.py {remote_pipeline_input_namespace(created_run.json()['id'])} "
        "--accession P00001"
    ) in remote_script
    pipeline_line = next(line for line in remote_script.splitlines() if line.startswith("python"))
    assert remote_pipeline_input_namespace(created_run.json()["id"]) in pipeline_line
    assert "set -u" in remote_script
    assert "pipeline_status=$?" in remote_script
    assert 'exit "$pipeline_status"' in remote_script
    assert "SLURM_JOB_ID" in remote_script
    assert 'grep -Fq "SLURM_JOB_ID | ${SLURM_JOB_ID}" "$log"' in remote_script

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
    assert {artifact.artifact_type for artifact in artifacts} == expected_artifact_types_for_stage(
        "protein_identity"
    )
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
    assert annotations[0]["values"] == {"gene": "GENE1", "accession": "P00001"}

    run_response = client.get(f"/api/v1/runs/{created_run.json()['id']}")
    assert run_response.status_code == 200
    assert any(
        item["id"] == "protein_identity" and item["status"] == "success"
        for item in run_response.json()["stages"]
    )

    annotations_response = client.get(
        f"/api/v1/runs/{created_run.json()['id']}/annotations?limit=2"
    )
    assert annotations_response.status_code == 200
    assert annotations_response.json()["rows"][0]["stage_id"] == "protein_identity"
    assert annotations_response.json()["rows"][0]["aa_ref"] == "A"
    assert annotations_response.json()["truncated"] is True

    summary_artifact = next(
        artifact for artifact in artifacts if artifact.artifact_type == "protein_identity"
    )
    artifact_response = client.get(f"/api/v1/artifacts/{summary_artifact.id}")
    assert artifact_response.status_code == 200
    assert artifact_response.json()["sha256"] == summary_artifact.sha256
    artifact_content = client.get(f"/api/v1/artifacts/{summary_artifact.id}/content")
    assert artifact_content.status_code == 200
    assert artifact_content.content == remote.summary


def test_artifact_only_remote_stage_ingests_without_annotations(client, session, tmp_path: Path):
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

    run = session.get(Run, created_run.json()["id"])
    assert run is not None
    stage = next(item for item in run.stages if item.stage_id == "conformational_ensemble")

    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_remote_root="/gpfs/test",
    )
    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    remote = FakeDirectoryArtifactRemote(run.id)
    executor.client = remote
    _prepare_remote(remote, stage)

    result_id, reused = executor._ingest_result(session, stage)
    session.commit()

    assert reused is False
    result = session.get(StageResult, result_id)
    assert result is not None
    assert {artifact.artifact_type for artifact in result.artifacts} == (
        expected_artifact_types_for_stage(stage.stage_id)
    )
    artifact = next(
        item
        for item in result.artifacts
        if item.artifact_type == "conformational_ensemble_final_dir"
    )
    assert artifact.media_type == "application/x-tar"
    assert artifact.storage_key.endswith("/conformational_ensemble_final_dir.tar")
    assert result.provenance["remote_directory_artifacts"] == ["conformational_ensemble_final_dir"]
    assert not result.provenance["remote_provenance"].get("annotations")


def test_remote_artifacts_with_same_basename_get_distinct_storage_keys(
    client, session, tmp_path: Path
):
    protein = client.post(
        "/api/v1/proteins",
        json={"sequence": SEQUENCE, "aliases": [{"source": "uniprot", "identifier": "P00001"}]},
    )
    assert protein.status_code == 201
    created_run = client.post("/api/v1/runs", json={"protein_id": protein.json()["id"]})
    assert created_run.status_code == 201

    run = session.get(Run, created_run.json()["id"])
    assert run is not None
    stage = next(item for item in run.stages if item.stage_id == "protein_identity")
    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_remote_root="/gpfs/test",
    )
    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    remote = FakeCollidingArtifactRemote(run.id)
    executor.client = remote
    _prepare_remote(remote, stage)

    result_id, reused = executor._ingest_result(session, stage)
    session.commit()

    assert reused is False
    result = session.get(StageResult, result_id)
    assert result is not None
    artifacts = {artifact.artifact_type: artifact for artifact in result.artifacts}
    assert set(artifacts) == expected_artifact_types_for_stage(stage.stage_id)
    assert artifacts["canonical_fasta"].storage_key != artifacts["protein_identity"].storage_key
    assert all(
        (settings.artifact_root / artifact.storage_key).is_file() for artifact in artifacts.values()
    )


@pytest.mark.parametrize(
    ("remote_type", "error_message"),
    [
        (FakeNonCanonicalArtifactRemote, "artifact contract"),
        (FakeReservedAnnotationsArtifactRemote, "reserves annotations"),
    ],
)
def test_remote_manifest_requires_exact_registry_artifact_names(
    client, session, tmp_path: Path, remote_type, error_message: str
):
    protein = client.post("/api/v1/proteins", json={"sequence": SEQUENCE})
    assert protein.status_code == 201
    created_run = client.post("/api/v1/runs", json={"protein_id": protein.json()["id"]})
    assert created_run.status_code == 201
    run = session.get(Run, created_run.json()["id"])
    assert run is not None
    stage = next(item for item in run.stages if item.stage_id == "protein_identity")
    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_remote_root="/gpfs/test",
    )
    remote = remote_type(run.id)
    _prepare_remote(remote, stage)
    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    executor.client = remote

    with pytest.raises(RemoteStageExecutionError, match=error_message):
        executor._ingest_result(session, stage)

    assert session.scalar(select(StageResult)) is None


def test_remote_submit_selects_transferred_pipeline_inputs(client, session, tmp_path: Path):
    protein = client.post(
        "/api/v1/proteins",
        json={
            "sequence": SEQUENCE,
            "aliases": [{"source": "uniprot", "identifier": "P00001"}],
        },
    )
    assert protein.status_code == 201
    upload = client.post(
        "/api/v1/uploads",
        files={"file": ("query.fasta", b">P00001\nACDEFGHIKLMNPQRSTVWY\n", "text/plain")},
        data={"input_type": "fasta"},
    )
    assert upload.status_code == 201
    created_run = client.post(
        "/api/v1/runs",
        json={"protein_id": protein.json()["id"], "upload_ids": [upload.json()["id"]]},
    )
    assert created_run.status_code == 201

    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_remote_root="/gpfs/test",
        hpc_input_transfer_enabled=True,
    )
    run = session.get(Run, created_run.json()["id"])
    assert run is not None
    attached = run.uploads[0]
    attached.transfer_status = "uploaded"
    attached.remote_path = remote_pipeline_input_path(
        settings,
        remote_pipeline_input_namespace(run.id),
        run.id,
        attached.id,
        ".fasta",
        input_type="fasta",
    )
    session.commit()
    session.refresh(run)

    stage = claim_ready_stage(session, settings)
    assert stage is not None
    remote = FakeCompletedRemote(run.id)
    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    executor.client = remote

    _prepare_remote(remote, stage)
    executor.submit_stage(session, stage)

    assert remote.requests[0].environment["PIPELINE_SELECTED_FASTA"] == attached.remote_path
    configuration_manifest = json.loads(
        remote.requests[0].environment["PIPELINE_CONFIGURATION_JSON"]
    )
    assert configuration_manifest["configuration_id"] == run.configuration.id
    assert configuration_manifest["sequence_sha256"] == run.configuration.sequence_sha256
    assert configuration_manifest["versions"] == run.configuration.versions
    assert "PIPELINE_STRUCTURE_MAPPING_JSON" in remote.requests[0].environment
    assert "PIPELINE_UPSTREAM_CACHE_KEYS_JSON" in remote.requests[0].environment


def test_remote_submit_rejects_ambient_inputs_when_transfer_is_enabled(
    client, session, tmp_path: Path
):
    protein = client.post(
        "/api/v1/proteins",
        json={
            "sequence": SEQUENCE,
            "aliases": [{"source": "uniprot", "identifier": "P00001"}],
        },
    )
    assert protein.status_code == 201
    created_run = client.post("/api/v1/runs", json={"protein_id": protein.json()["id"]})
    assert created_run.status_code == 201

    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_remote_root="/gpfs/test",
        hpc_input_transfer_enabled=True,
    )
    stage = claim_ready_stage(session, settings)
    assert stage is not None
    remote = FakeCompletedRemote(created_run.json()["id"])
    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    executor.client = remote

    _prepare_remote(remote, stage)
    with pytest.raises(RemoteStageExecutionError, match="attached FASTA input"):
        executor.submit_stage(session, stage)
    assert remote.requests == []


def test_truncated_remote_manifest_fails_stage_without_publishing(client, session, tmp_path: Path):
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
    remote = FakeTruncatedManifestRemote(created_run.json()["id"])
    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    executor.client = remote

    _prepare_remote(remote, stage)
    executor.submit_stage(session, stage)
    assert executor.poll_stage(session, stage) is True
    session.expire_all()

    persisted_stage = session.get(RunStage, stage.id)
    assert persisted_stage is not None
    assert persisted_stage.status == "failed"
    assert persisted_stage.error_code == "remote_result_invalid"
    assert persisted_stage.stage_result_id is None


def test_tampered_remote_provenance_fails_before_publishing(client, session, tmp_path: Path):
    protein = client.post(
        "/api/v1/proteins",
        json={"sequence": SEQUENCE},
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
    remote = FakeTamperedProvenanceRemote(created_run.json()["id"])
    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    executor.client = remote
    _prepare_remote(remote, stage)

    with pytest.raises(RemoteStageExecutionError, match="provenance does not match its manifest"):
        executor._ingest_result(session, stage)

    assert session.scalar(select(StageResult)) is None


def test_remote_provenance_binding_must_match_confirmed_configuration(
    client, session, tmp_path: Path
):
    protein = client.post("/api/v1/proteins", json={"sequence": SEQUENCE})
    assert protein.status_code == 201
    created_run = client.post("/api/v1/runs", json={"protein_id": protein.json()["id"]})
    assert created_run.status_code == 201

    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_remote_root="/gpfs/test",
    )
    stage = claim_ready_stage(session, settings)
    assert stage is not None
    remote = FakeCompletedRemote(created_run.json()["id"])
    _prepare_remote(remote, stage)
    payload = json.loads(remote.provenance)
    payload["platform_binding"]["sequence_sha256"] = "f" * 64
    remote.provenance = json.dumps(payload, sort_keys=True).encode()
    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    executor.client = remote

    with pytest.raises(RemoteStageExecutionError, match="confirmed run configuration"):
        executor._ingest_result(session, stage)

    assert session.scalar(select(StageResult)) is None


def test_legacy_mn5_cache_payload_binds_remote_identity_to_local_configuration(
    client, session, tmp_path: Path
):
    protein = client.post("/api/v1/proteins", json={"sequence": SEQUENCE})
    assert protein.status_code == 201
    created_run = client.post("/api/v1/runs", json={"protein_id": protein.json()["id"]})
    assert created_run.status_code == 201

    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_remote_root="/gpfs/test",
    )
    stage = claim_ready_stage(session, settings)
    assert stage is not None
    local_cache_key = _prepare_remote(FakeCompletedRemote(stage.run_id), stage)
    expected_sequence = stage.run.configuration.sequence_sha256
    payload = {
        "schema": "stage-cache-v2",
        "stage_id": stage.stage_id,
        "contract_version": STAGE_BY_ID[stage.stage_id].stage_version,
        "stage_code_sha256": "a" * 64,
        "sequence_sha256": expected_sequence,
        "query_sequence_sha256": expected_sequence,
        "reference_sequence_sha256": expected_sequence,
        "dependency_cache_keys": {},
        "resource_identity": "remote-resource",
        "scientific_parameters": {"remote_resource_version": "pinned-by-mn5"},
    }
    remote_cache_key = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()
    manifest = {"metadata": {"canonical_sequence_sha256": expected_sequence}}
    provenance = {
        "operational": {
            "cache_key": remote_cache_key,
            "sequence_sha256": expected_sequence,
            "cache_payload": payload,
        }
    }

    binding = _validate_legacy_remote_cache_contract(
        stage,
        local_cache_key,
        remote_cache_key,
        manifest,
        provenance,
    )

    assert binding["platform_cache_key"] == local_cache_key
    assert binding["remote_cache_key"] == remote_cache_key
    assert binding["remote_stage_code_sha256"] == "a" * 64
    assert binding["scientific_parameters"] == {"remote_resource_version": "pinned-by-mn5"}
    assert binding["confirmed_scientific_parameters"] == {}


def test_remote_ingest_requires_a_locally_planned_cache_identity(client, session, tmp_path: Path):
    protein = client.post("/api/v1/proteins", json={"sequence": SEQUENCE})
    assert protein.status_code == 201
    created_run = client.post("/api/v1/runs", json={"protein_id": protein.json()["id"]})
    assert created_run.status_code == 201
    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_remote_root="/gpfs/test",
    )
    stage = claim_ready_stage(session, settings)
    assert stage is not None
    remote = FakeCompletedRemote(created_run.json()["id"])
    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    executor.client = remote

    with pytest.raises(RemoteStageExecutionError, match="locally planned cache key"):
        executor._ingest_result(session, stage)

    assert session.scalar(select(StageResult)) is None


def test_remote_submit_requires_a_locally_planned_cache_identity(client, session, tmp_path: Path):
    protein = client.post("/api/v1/proteins", json={"sequence": SEQUENCE})
    assert protein.status_code == 201
    created_run = client.post("/api/v1/runs", json={"protein_id": protein.json()["id"]})
    assert created_run.status_code == 201
    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_remote_root="/gpfs/test",
    )
    stage = claim_ready_stage(session, settings)
    assert stage is not None
    remote = FakeCompletedRemote(created_run.json()["id"])
    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    executor.client = remote

    with pytest.raises(RemoteStageExecutionError, match="locally planned cache key"):
        executor.submit_stage(session, stage)

    assert remote.requests == []
    assert stage.slurm_job_id is None


def test_remote_ingest_rejects_cache_factor_drift(client, session, tmp_path: Path):
    protein = client.post("/api/v1/proteins", json={"sequence": SEQUENCE})
    assert protein.status_code == 201
    created_run = client.post("/api/v1/runs", json={"protein_id": protein.json()["id"]})
    assert created_run.status_code == 201
    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_remote_root="/gpfs/test",
    )
    stage = claim_ready_stage(session, settings)
    assert stage is not None
    remote = FakeCompletedRemote(created_run.json()["id"])
    _prepare_remote(remote, stage)
    stage.cache_factors = {**stage.cache_factors, "sequence_sha256": "f" * 64}
    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    executor.client = remote

    with pytest.raises(
        RemoteStageExecutionError, match="does not match the confirmed configuration"
    ):
        executor._ingest_result(session, stage)

    assert session.scalar(select(StageResult)) is None


def test_concurrent_cache_publication_reuses_committed_winner(
    client, session, tmp_path: Path, monkeypatch
):
    protein = client.post(
        "/api/v1/proteins",
        json={"sequence": SEQUENCE, "aliases": [{"source": "uniprot", "identifier": "P00001"}]},
    )
    assert protein.status_code == 201
    created_run = client.post("/api/v1/runs", json={"protein_id": protein.json()["id"]})
    assert created_run.status_code == 201
    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_remote_root="/gpfs/test",
    )
    stage = claim_ready_stage(session, settings)
    assert stage is not None
    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    cache_key = _prepare_remote(executor, stage)
    store = ArtifactStore(settings)
    temporary_key = "remote/loser/annotations.tsv"
    temporary_path = store.resolve(temporary_key)
    temporary_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path.write_bytes(b"losing publication")
    winner = SimpleNamespace(id="winner-stage-result")
    monkeypatch.setattr(
        executor,
        "_find_reusable_result",
        lambda *_args, **_kwargs: winner,
    )
    error = IntegrityError(
        "INSERT",
        {},
        Exception("UNIQUE constraint failed: stage_results.uq_stage_result_cache"),
    )

    recovered = executor._recover_concurrent_cache_publication(
        session,
        stage,
        cache_key,
        store,
        [temporary_key],
        error,
    )

    assert recovered == (winner.id, True)
    assert not temporary_path.exists()


def test_cache_plan_requires_every_declared_dependency(client, session):
    protein = client.post("/api/v1/proteins", json={"sequence": SEQUENCE})
    assert protein.status_code == 201
    created_run = client.post("/api/v1/runs", json={"protein_id": protein.json()["id"]})
    assert created_run.status_code == 201
    run = session.get(Run, created_run.json()["id"])
    assert run is not None
    stage = next(item for item in run.stages if item.stage_id == "structural_regime")
    cache_key, factors = planned_stage_cache_identity(stage, run.configuration, {})
    stage.cache_key = cache_key
    stage.cache_factors = factors

    with pytest.raises(RemoteStageExecutionError, match="omit dependency identities"):
        _validated_local_cache_plan(stage)
