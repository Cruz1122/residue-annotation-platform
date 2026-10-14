from datetime import UTC, datetime, timedelta

from app.core.config import get_settings
from app.features.runs.models import ActiveRunSlot, Run, RunStage
from app.features.runs.service import transition_stage
from app.features.runs.state import RunStageStatus
from app.features.runs.worker_service import (
    claim_ready_stage,
    claim_remote_stage,
    process_one,
    recover_stale_stages,
    release_remote_stage_claim,
    renew_stage_lease,
)
from app.infrastructure.hpc.base import HPCConfigurationError
from sqlalchemy import select

SEQUENCE = "ACDE"


def _create_run(client) -> str:
    protein = client.post("/api/v1/proteins", json={"sequence": SEQUENCE})
    assert protein.status_code == 201
    run = client.post("/api/v1/runs", json={"protein_id": protein.json()["id"]})
    assert run.status_code == 201
    return run.json()["id"]


def _expire_lease(session, stage: RunStage) -> None:
    stage.lease_expires_at = datetime.now(UTC) - timedelta(seconds=1)
    session.commit()


def test_stale_claim_is_requeued_and_slot_is_released(client, session):
    run_id = _create_run(client)
    settings = get_settings()
    stage = claim_ready_stage(session, settings)

    assert stage is not None
    assert stage.status == RunStageStatus.QUEUED
    assert stage.attempt_count == 1
    # Simulate a worker process dying before the stage reached a terminal state.
    _expire_lease(session, stage)
    assert session.query(ActiveRunSlot).count() == 1

    recovered = recover_stale_stages(session, settings)

    assert run_id in recovered
    session.refresh(stage)
    assert stage.status == RunStageStatus.READY
    assert stage.lease_expires_at is None
    assert stage.error_code is None

    assert process_one(session) is True
    assert process_one(session) is False
    run = session.get(Run, run_id)
    assert run.status == "failed"
    assert session.query(ActiveRunSlot).count() == 0


def test_stale_claim_exhausts_attempts_and_fails_the_stage(client, session):
    run_id = _create_run(client)
    settings = get_settings()
    stage = claim_ready_stage(session, settings)
    assert stage is not None
    stage.attempt_count = settings.run_worker_max_attempts
    _expire_lease(session, stage)

    recover_stale_stages(session, settings)

    session.refresh(stage)
    assert stage.status == RunStageStatus.FAILED
    assert stage.error_code == "lease_expired"
    assert process_one(session) is False
    run = session.get(Run, run_id)
    assert run.status == "failed"
    assert session.query(ActiveRunSlot).count() == 0


def test_stale_remote_stage_keeps_lease_for_polling(client, session):
    _create_run(client)
    settings = get_settings()
    stage = claim_ready_stage(session, settings)
    assert stage is not None
    stage.slurm_job_id = "54321"
    _expire_lease(session, stage)

    recover_stale_stages(session, settings)

    session.refresh(stage)
    assert stage.status == RunStageStatus.QUEUED
    assert stage.lease_expires_at is not None
    assert stage.lease_expires_at.replace(tzinfo=UTC) > datetime.now(UTC)


def test_cancelled_run_stale_stage_is_cancelled(client, session):
    run_id = _create_run(client)
    settings = get_settings()
    stage = claim_ready_stage(session, settings)
    assert stage is not None
    run = session.get(Run, run_id)
    assert run is not None
    run.status = "cancel_requested"
    _expire_lease(session, stage)

    recover_stale_stages(session, settings)

    session.refresh(stage)
    assert stage.status == RunStageStatus.CANCELLED


def test_renew_stage_lease_only_for_active_stages(client, session):
    _create_run(client)
    settings = get_settings()
    stage = claim_ready_stage(session, settings)
    assert stage is not None
    stage.lease_expires_at = datetime.now(UTC).replace(tzinfo=None) - timedelta(seconds=60)
    session.commit()

    assert renew_stage_lease(session, stage.id, settings) is True
    session.refresh(stage)
    renewed_lease = stage.lease_expires_at
    assert renewed_lease is not None
    assert renewed_lease > datetime.now(UTC).replace(tzinfo=None)

    transition_stage(session, stage, RunStageStatus.RUNNING)
    transition_stage(session, stage, RunStageStatus.SUCCESS)
    session.commit()

    assert renew_stage_lease(session, stage.id, settings) is False


def test_remote_stage_claim_is_exclusive_until_released(client, session):
    run_id = _create_run(client)
    stages = list(
        session.scalars(
            select(RunStage)
            .where(RunStage.run_id == run_id)
            .order_by(RunStage.created_at, RunStage.stage_id)
        )
    )
    for stage in stages[:2]:
        stage.status = RunStageStatus.QUEUED
        stage.slurm_job_id = f"job-{stage.id[:8]}"
        stage.lease_expires_at = datetime.now(UTC).replace(tzinfo=None) + timedelta(minutes=5)
    session.commit()

    settings = get_settings()
    first = claim_remote_stage(session, settings)
    second = claim_remote_stage(session, settings)
    third = claim_remote_stage(session, settings)

    assert first is not None
    assert second is not None
    assert first[0].id != second[0].id
    assert third is None

    release_remote_stage_claim(session, first[0].id, first[1])
    reclaimed = claim_remote_stage(session, settings)
    assert reclaimed is not None
    assert reclaimed[0].id == first[0].id


def test_remote_configuration_outage_keeps_stage_durable_and_retries(monkeypatch, client, session):
    run_id = _create_run(client)
    settings = get_settings().model_copy(update={"hpc_execution_mode": "ssh"})
    events: list[dict[str, object]] = []

    monkeypatch.setattr("app.features.runs.worker_service.get_settings", lambda: settings)
    monkeypatch.setattr(
        "app.features.runs.remote_executor.SSHStageExecutor",
        lambda _settings: (_ for _ in ()).throw(
            HPCConfigurationError("SSH password file is unavailable")
        ),
    )
    monkeypatch.setattr(
        "app.features.runs.worker_service.log_worker_event",
        lambda event, **kwargs: events.append({"event": event, **kwargs}),
    )

    assert process_one(session) is False
    stage = session.scalar(select(RunStage).where(RunStage.run_id == run_id))
    run = session.get(Run, run_id)
    assert stage is not None
    assert run is not None
    assert stage.status == RunStageStatus.READY
    assert stage.slurm_job_id is None
    assert run.status == "pending"
    assert events == [
        {
            "event": "remote_executor_unavailable",
            "status": "retryable",
            "error_code": "hpc_configuration_unavailable",
        }
    ]
