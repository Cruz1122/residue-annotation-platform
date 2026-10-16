from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

from app.core.config import Settings, get_settings
from app.features.artifacts.storage import ArtifactStore
from app.features.runs.cache import planned_stage_cache_identity
from app.features.runs.models import Run, RunStage, StageResult
from app.features.runs.preflight import PreflightFailure, execution_uploads
from app.features.runs.service import request_cancel
from app.features.runs.state import RunStageStatus, RunStatus
from app.features.runs.worker_service import (
    _handle_preflight_failure,
    process_one,
    refresh_ready_states,
    reserve_remote_submission,
)
from app.infrastructure.hpc.base import (
    HPCConfigurationError,
    HPCRequestTooLargeError,
    HPCSubmissionAmbiguousError,
    HPCTransportError,
    PrefetchResult,
)
from app.main import app
from sqlalchemy import select

SEQUENCE = "ACDEFGHIKLMNPQRSTVWY"


def test_af3_execution_ignores_attached_structure_upload():
    run = SimpleNamespace(
        configuration=SimpleNamespace(
            structure_source="alphafold3",
            structure_upload_id="structure-upload",
        ),
        uploads=[
            SimpleNamespace(id="fasta-upload", input_type="fasta"),
            SimpleNamespace(id="structure-upload", input_type="structure"),
        ],
    )

    selected = execution_uploads(run)

    assert [upload.id for upload in selected] == ["fasta-upload"]


def _remote_settings(tmp_path: Path) -> Settings:
    return Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_execution_mode="ssh",
        hpc_preflight_retry_seconds=1,
    )


def _remote_run(client, settings: Settings) -> str:
    app.dependency_overrides[get_settings] = lambda: settings
    protein = client.post(
        "/api/v1/proteins",
        json={
            "sequence": SEQUENCE,
            "aliases": [{"source": "uniprot", "identifier": "P00001"}],
        },
    )
    assert protein.status_code == 201, protein.text
    created = client.post("/api/v1/runs", json={"protein_id": protein.json()["id"]})
    assert created.status_code == 201, created.text
    return created.json()["id"]


def _publish_identity_root(session, run_id: str) -> None:
    run = session.get(Run, run_id)
    assert run is not None
    root = next(stage for stage in run.stages if stage.stage_id == "protein_identity")
    result = StageResult(
        protein_id=run.protein_id,
        stage_id=root.stage_id,
        cache_key="a" * 64,
        status="success",
        provenance={"source": "verified-test"},
        owner_id=run.owner_id,
        project_id=run.project_id,
    )
    session.add(result)
    session.flush()
    root.stage_result_id = result.id
    root.status = RunStageStatus.SUCCESS
    session.commit()
    refresh_ready_states(session, {run_id})


def _isolate_stage(session, run_id: str, target_stage_id: str) -> None:
    run = session.get(Run, run_id)
    assert run is not None
    for stage in run.stages:
        if stage.stage_id in {"protein_identity", target_stage_id}:
            continue
        if stage.status in {RunStageStatus.PENDING, RunStageStatus.READY}:
            # This is fixture setup, not a worker transition: a production
            # run never skips an arbitrary ready stage after confirmation.
            stage.status = RunStageStatus.SKIPPED
            stage.finished_at = datetime.now(UTC)
    session.commit()
    refresh_ready_states(session, {run_id})


class PrefetchUnavailableExecutor:
    def __init__(self, _settings: Settings):
        self.submit_calls = 0

    def prepare_external(self, _session, _stage, _requirements):
        raise HPCConfigurationError("prefetch command is not configured")

    def submit_stage(self, _session, _stage):
        self.submit_calls += 1
        raise AssertionError("sbatch must not run when prefetch is unavailable")


def test_remote_preflight_blocks_submit_when_external_cache_is_unavailable(
    client,
    session,
    tmp_path: Path,
    monkeypatch,
):
    settings = _remote_settings(tmp_path)
    run_id = _remote_run(client, settings)
    _publish_identity_root(session, run_id)
    _isolate_stage(session, run_id, "uniprot_features")
    executor = PrefetchUnavailableExecutor(settings)
    monkeypatch.setattr("app.features.runs.worker_service.get_settings", lambda: settings)
    monkeypatch.setattr(
        "app.features.runs.remote_executor.SSHStageExecutor",
        lambda _settings: executor,
    )

    assert process_one(session) is True

    stage = session.scalar(
        select(RunStage)
        .where(RunStage.run_id == run_id)
        .where(RunStage.stage_id == "uniprot_features")
    )
    run = session.get(Run, run_id)
    assert stage is not None
    assert run is not None
    assert stage.status == RunStageStatus.READY
    assert stage.preflight_status == "blocked"
    assert stage.preflight_error_code == "prefetch_configuration_unavailable"
    assert stage.slurm_job_id is None
    assert executor.submit_calls == 0
    assert run.status == RunStatus.PENDING
    assert run.preparation is not None
    assert run.preparation.status == "blocked"
    assert "external_cache" in run.preparation.required_requirements


def test_preflight_failure_does_not_revive_a_concurrently_cancelled_stage(
    client, session, tmp_path: Path, monkeypatch
):
    settings = _remote_settings(tmp_path)
    run_id = _remote_run(client, settings)
    _publish_identity_root(session, run_id)
    _isolate_stage(session, run_id, "uniprot_features")
    stage = next(
        stage for stage in session.get(Run, run_id).stages if stage.stage_id == "uniprot_features"
    )
    assert stage.status == RunStageStatus.READY
    stage.status = RunStageStatus.QUEUED
    session.commit()

    def cancel_during_transition(_session, current, _target):
        current.status = RunStageStatus.CANCELLED
        session.commit()
        raise ValueError("invalid stage transition: cancelled -> ready")

    monkeypatch.setattr(
        "app.features.runs.worker_service.transition_stage",
        cancel_during_transition,
    )

    _handle_preflight_failure(
        session,
        stage,
        settings,
        PreflightFailure(
            "prefetch_configuration_unavailable",
            "prefetch is unavailable",
            retryable=True,
        ),
    )

    session.expire_all()
    persisted = session.get(RunStage, stage.id)
    assert persisted is not None
    assert persisted.status == RunStageStatus.CANCELLED


class SuccessfulPrefetchExecutor:
    def __init__(self, _settings: Settings):
        self.prefetch_requirements: tuple[str, ...] | None = None
        self.observed_preflight_status: str | None = None
        self.submit_calls = 0

    def prepare_external(self, session, stage, requirements):
        self.prefetch_requirements = tuple(requirements)
        self.observed_preflight_status = session.scalar(
            select(RunStage.preflight_status).where(RunStage.id == stage.id)
        )
        return PrefetchResult(
            status="success",
            requirements=tuple(requirements),
            snapshots={"external_cache": "approved-snapshot-v1"},
        )

    def submit_stage(self, session, stage):
        self.submit_calls += 1
        stage.slurm_job_id = "job-123"
        session.commit()


def test_remote_preflight_prefetches_only_the_selected_stage_requirements(
    client,
    session,
    tmp_path: Path,
    monkeypatch,
):
    settings = _remote_settings(tmp_path).model_copy(
        update={"hpc_pipeline_prefetch_command": "validated-prefetch {accession} {requirements}"}
    )
    run_id = _remote_run(client, settings)
    _publish_identity_root(session, run_id)
    _isolate_stage(session, run_id, "uniprot_features")
    run = session.get(Run, run_id)
    assert run is not None and run.preparation is not None
    # An acknowledgement without its immutable snapshot is not enough to
    # bypass the prefetch gate.
    run.preparation.satisfied_requirements = ["external_cache"]
    run.preparation.snapshots = {}
    session.commit()
    executor = SuccessfulPrefetchExecutor(settings)
    monkeypatch.setattr("app.features.runs.worker_service.get_settings", lambda: settings)
    monkeypatch.setattr(
        "app.features.runs.remote_executor.SSHStageExecutor",
        lambda _settings: executor,
    )

    assert process_one(session) is True

    stage = session.scalar(
        select(RunStage)
        .where(RunStage.run_id == run_id)
        .where(RunStage.stage_id == "uniprot_features")
    )
    run = session.get(Run, run_id)
    assert stage is not None
    assert run is not None
    assert executor.prefetch_requirements == ("external_cache",)
    assert executor.observed_preflight_status == "running"
    assert executor.submit_calls == 1
    assert stage.preflight_status == "passed"
    assert stage.status == RunStageStatus.QUEUED
    assert stage.slurm_job_id == "job-123"
    assert run.preparation is not None
    assert run.preparation.status == "pending"
    assert run.preparation.snapshots == {"external_cache": "approved-snapshot-v1"}


def test_verified_prefetch_receipt_is_bound_to_cache_identity(client, session, tmp_path: Path):
    settings = _remote_settings(tmp_path)
    run_id = _remote_run(client, settings)
    run = session.get(Run, run_id)
    assert run is not None
    stage = next(item for item in run.stages if item.stage_id == "uniprot_features")
    # Preparation is global to the run. Another selected stage may still be
    # waiting for its own prerequisite, while this stage already has a valid
    # snapshot that must participate in its cache identity.
    run.preparation.status = "pending"
    run.preparation.satisfied_requirements = ["external_cache"]
    run.preparation.snapshots = {"external_cache": "approved-snapshot-v1"}

    cache_key, factors = planned_stage_cache_identity(stage, run.configuration, {})

    assert factors["versions"]["external_snapshots"] == {"external_cache": "approved-snapshot-v1"}
    assert factors["versions"]["reproducibility_status"] == "external_snapshots_verified"
    assert cache_key


def test_cancel_winning_before_remote_reservation_never_calls_submit(
    client, session, tmp_path: Path, monkeypatch
):
    settings = _remote_settings(tmp_path)
    run_id = _remote_run(client, settings)
    submit_calls: list[str] = []

    class Executor:
        def submit_stage(self, _session, stage):
            submit_calls.append(stage.id)

    executor = Executor()
    monkeypatch.setattr("app.features.runs.worker_service.get_settings", lambda: settings)
    monkeypatch.setattr(
        "app.features.runs.remote_executor.SSHStageExecutor",
        lambda _settings: executor,
    )

    def cancel_after_preflight(current_session, stage, _settings, _executor):
        run = current_session.get(Run, stage.run_id)
        assert run is not None
        request_cancel(current_session, run)

    monkeypatch.setattr(
        "app.features.runs.worker_service._prepare_stage_for_execution",
        cancel_after_preflight,
    )

    assert process_one(session) is True
    stage = session.scalar(
        select(RunStage)
        .where(RunStage.run_id == run_id)
        .where(RunStage.stage_id == "protein_identity")
    )
    assert stage is not None
    assert reserve_remote_submission(session, stage.id) is None
    assert submit_calls == []
    cancelled = session.get(RunStage, stage.id)
    assert cancelled is not None
    assert cancelled.status == RunStageStatus.CANCELLED


def test_pdb_only_remote_run_materializes_canonical_fasta(client, session, tmp_path: Path):
    settings = _remote_settings(tmp_path).model_copy(update={"hpc_input_transfer_enabled": True})
    app.dependency_overrides[get_settings] = lambda: settings
    protein = client.post(
        "/api/v1/proteins",
        json={
            "sequence": SEQUENCE,
            "aliases": [{"source": "uniprot", "identifier": "P00001"}],
        },
    )
    assert protein.status_code == 201

    created = client.post(
        "/api/v1/runs",
        json={"protein_id": protein.json()["id"], "structure_source": "alphafold3"},
    )

    assert created.status_code == 201, created.text
    payload = created.json()
    fasta = payload["configuration"]["input_references"]["fasta"]
    assert fasta["source"] == "canonical_sequence"
    assert fasta["upload_id"] is not None
    assert payload["configuration"]["fasta_upload_id"] is not None
    assert payload["configuration"]["fasta_upload_id"] == fasta["upload_id"]
    upload = session.get(Run, payload["id"])
    assert upload is not None
    fasta_upload = next(item for item in upload.uploads if item.input_type == "fasta")
    assert (
        ArtifactStore(settings).resolve(fasta_upload.storage_key).read_text()
        == ">P00001\nACDEFGHIKLMNPQRSTVWY\n"
    )


class SubmitTransportRecoveryExecutor:
    def __init__(self, _settings: Settings):
        self.submit_calls = 0

    def submit_stage(self, session, stage):
        self.submit_calls += 1
        if self.submit_calls == 1:
            raise HPCTransportError("connection lost after sbatch")
        stage.slurm_job_id = "job-recovered"
        session.commit()


class SubmitRequestTooLargeExecutor:
    def __init__(self, _settings: Settings):
        self.submit_calls = 0

    def submit_stage(self, _session, _stage):
        self.submit_calls += 1
        raise HPCRequestTooLargeError("Slurm submission exceeded the OS argument limit")


def test_submit_transport_failure_keeps_stage_retryable(
    client,
    session,
    tmp_path: Path,
    monkeypatch,
):
    settings = _remote_settings(tmp_path)
    run_id = _remote_run(client, settings)
    _publish_identity_root(session, run_id)
    _isolate_stage(session, run_id, "sequence_frustration")
    executor = SubmitTransportRecoveryExecutor(settings)
    monkeypatch.setattr("app.features.runs.worker_service.get_settings", lambda: settings)
    monkeypatch.setattr(
        "app.features.runs.remote_executor.SSHStageExecutor",
        lambda _settings: executor,
    )

    assert process_one(session) is True
    first = session.scalar(
        select(RunStage)
        .where(RunStage.run_id == run_id)
        .where(RunStage.stage_id == "sequence_frustration")
    )
    assert first is not None
    assert first.status == RunStageStatus.READY
    assert first.slurm_job_id is None
    assert first.error_code is None

    assert process_one(session) is True
    session.expire_all()
    recovered = session.scalar(
        select(RunStage)
        .where(RunStage.run_id == run_id)
        .where(RunStage.stage_id == "sequence_frustration")
    )
    assert recovered is not None
    assert recovered.status == RunStageStatus.QUEUED
    assert recovered.slurm_job_id == "job-recovered"
    assert executor.submit_calls == 2


def test_e2big_submission_failure_is_terminal_and_not_retried(
    client,
    session,
    tmp_path: Path,
    monkeypatch,
):
    settings = _remote_settings(tmp_path)
    run_id = _remote_run(client, settings)
    _publish_identity_root(session, run_id)
    _isolate_stage(session, run_id, "sequence_frustration")
    executor = SubmitRequestTooLargeExecutor(settings)
    monkeypatch.setattr("app.features.runs.worker_service.get_settings", lambda: settings)
    monkeypatch.setattr(
        "app.features.runs.remote_executor.SSHStageExecutor",
        lambda _settings: executor,
    )

    assert process_one(session) is True
    session.expire_all()
    failed = session.scalar(
        select(RunStage)
        .where(RunStage.run_id == run_id)
        .where(RunStage.stage_id == "sequence_frustration")
    )
    assert failed is not None
    assert failed.status == RunStageStatus.FAILED
    assert failed.error_code == "hpc_request_too_large"
    assert "OS argument limit" in failed.error_message
    assert process_one(session) is False
    assert executor.submit_calls == 1


class AmbiguousSubmitExecutor:
    def __init__(self, _settings: Settings):
        self.submit_calls = 0

    def submit_stage(self, _session, _stage):
        self.submit_calls += 1
        raise HPCSubmissionAmbiguousError("job-accepted")

    def poll_stage(self, _session, _stage):
        return True


def test_ambiguous_submit_persists_job_id_for_polling_without_retrying_submit(
    client,
    session,
    tmp_path: Path,
    monkeypatch,
):
    settings = _remote_settings(tmp_path)
    run_id = _remote_run(client, settings)
    _publish_identity_root(session, run_id)
    _isolate_stage(session, run_id, "sequence_frustration")
    executor = AmbiguousSubmitExecutor(settings)
    monkeypatch.setattr("app.features.runs.worker_service.get_settings", lambda: settings)
    monkeypatch.setattr(
        "app.features.runs.remote_executor.SSHStageExecutor",
        lambda _settings: executor,
    )

    assert process_one(session) is True
    stage = session.scalar(
        select(RunStage)
        .where(RunStage.run_id == run_id)
        .where(RunStage.stage_id == "sequence_frustration")
    )
    assert stage is not None
    # An accepted submission has not proved execution yet; polling must observe
    # Slurm RUNNING before the product exposes that phase.
    assert stage.status == RunStageStatus.QUEUED
    assert stage.slurm_job_id == "job-accepted"
    assert executor.submit_calls == 1

    assert process_one(session) is True
    assert executor.submit_calls == 1
