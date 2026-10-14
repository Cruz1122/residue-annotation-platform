from app.features.annotations.service import insert_annotation_rows
from app.features.auth.models import AuditEvent
from app.features.runs.models import ActiveRunSlot, Run, RunStage, StageResult
from app.features.runs.service import transition_stage
from app.features.runs.state import RunStageStatus
from app.features.runs.worker_service import process_one, refresh_ready_states
from app.features.stages.registry import STAGE_BY_ID, STAGE_DEFINITIONS
from sqlalchemy import select

SEQUENCE = "ACDEFGHIKLMNPQRSTVWY"


def _create_protein(client):
    response = client.post("/api/v1/proteins", json={"sequence": SEQUENCE})
    assert response.status_code == 201
    return response.json()["id"]


def test_run_is_created_with_persisted_stage_graph(client, session):
    protein_id = _create_protein(client)
    response = client.post("/api/v1/runs", json={"protein_id": protein_id})

    assert response.status_code == 201
    payload = response.json()
    assert payload["status"] == "pending"
    assert len(payload["stages"]) == 18
    assert payload["stages"][0]["status"] == "ready"
    assert payload["stages"][15]["status"] == "skipped"
    assert session.query(Run).count() == 1
    assert session.query(RunStage).count() == 18


def test_run_creation_rejects_hpc_budget_below_registry(monkeypatch, client):
    import app.features.runs.service as runs_service
    from app.core.config import Settings

    monkeypatch.setattr(
        runs_service,
        "get_settings",
        lambda: Settings(
            app_env="test",
            database_url="sqlite://",
            hpc_pipeline_cpu_budget=32,
            hpc_pipeline_gpu_budget=0,
        ),
    )
    protein_id = _create_protein(client)

    response = client.post("/api/v1/runs", json={"protein_id": protein_id})

    assert response.status_code == 503
    assert response.json()["detail"] == (
        "configured HPC budget cannot execute the registered pipeline"
    )


def test_variant_reference_is_validated(client):
    protein_id = _create_protein(client)
    response = client.post(
        "/api/v1/runs",
        json={
            "protein_id": protein_id,
            "variants": [{"aa_position": 1, "aa_ref": "Y", "aa_alt": "A"}],
        },
    )

    assert response.status_code == 422
    assert "aa_ref" in response.json()["detail"]


def test_invalid_state_transition_is_rejected(session):
    stage = RunStage(stage_id="protein_identity", status=RunStageStatus.SUCCESS)

    try:
        transition_stage(session, stage, RunStageStatus.RUNNING)
    except ValueError as exc:
        assert "invalid stage transition" in str(exc)
    else:
        raise AssertionError("terminal stage transition unexpectedly succeeded")


def test_run_not_found_does_not_invent_progress(client):
    response = client.get("/api/v1/runs/does-not-exist")

    assert response.status_code == 404
    assert response.json()["detail"] == "Run not found"


def test_run_events_emits_the_persisted_terminal_snapshot(client):
    protein_id = _create_protein(client)
    created = client.post("/api/v1/runs", json={"protein_id": protein_id})
    assert created.status_code == 201
    run_id = created.json()["id"]

    cancelled = client.post(f"/api/v1/runs/{run_id}/cancel")
    assert cancelled.status_code == 200

    response = client.get(f"/api/v1/runs/{run_id}/events")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert "event: snapshot" in response.text
    assert '"status":"cancelled"' in response.text
    assert ": heartbeat" not in response.text


def test_run_events_refreshes_from_the_current_persisted_snapshot(monkeypatch, client, session):
    protein_id = _create_protein(client)
    created = client.post("/api/v1/runs", json={"protein_id": protein_id})
    assert created.status_code == 201
    run_id = created.json()["id"]

    changed = False

    async def persist_terminal_state(_: float) -> None:
        nonlocal changed
        if changed:
            return
        run = session.get(Run, run_id)
        assert run is not None
        run.status = "cancelled"
        session.commit()
        changed = True

    # Let the request cross one refresh boundary. This keeps the test
    # deterministic while proving that the long-lived stream re-reads the
    # persisted state through the injected database bind.
    monkeypatch.setattr("app.features.runs.router.asyncio.sleep", persist_terminal_state)
    response = client.get(f"/api/v1/runs/{run_id}/events")

    assert response.status_code == 200
    assert response.text.count("event: snapshot") == 2
    assert '"status":"pending"' in response.text
    assert '"status":"cancelled"' in response.text


def test_variants_are_normalized_and_duplicate_positions_are_rejected(client):
    protein_id = _create_protein(client)
    response = client.post(
        "/api/v1/runs",
        json={
            "protein_id": protein_id,
            "variants": [{"aa_position": 1, "aa_ref": "a", "aa_alt": "c"}],
        },
    )

    assert response.status_code == 201
    assert response.json()["requested_variants"] == [
        {"aa_position": 1, "aa_ref": "A", "aa_alt": "C"}
    ]

    duplicate = client.post(
        "/api/v1/runs",
        json={
            "protein_id": protein_id,
            "variants": [
                {"aa_position": 1, "aa_ref": "A", "aa_alt": "C"},
                {"aa_position": 1, "aa_ref": "A", "aa_alt": "D"},
            ],
        },
    )
    assert duplicate.status_code == 422


def test_annotations_return_only_published_rows(client, session):
    protein_id = _create_protein(client)
    run_response = client.post("/api/v1/runs", json={"protein_id": protein_id})
    run_id = run_response.json()["id"]
    run = session.get(Run, run_id)
    stage = next(item for item in run.stages if item.stage_id == "protein_identity")
    result = StageResult(
        protein_id=protein_id,
        stage_id=stage.stage_id,
        cache_key="a" * 64,
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
        stage.stage_id,
        result.id,
        [{"aa_position": 1, "aa_ref": "A", "values": {"gene": "example"}}],
    )
    session.commit()

    response = client.get(f"/api/v1/runs/{run_id}/annotations")

    assert response.status_code == 200
    payload = response.json()
    assert payload["rows"][0]["aa_position"] == 1
    assert payload["rows"][0]["values"] == {"gene": "example"}
    assert "protein_identity" not in payload["pending_stage_ids"]


def test_worker_finishes_failed_run_after_descendants_are_skipped(client, session):
    protein_id = _create_protein(client)
    run_id = client.post("/api/v1/runs", json={"protein_id": protein_id}).json()["id"]

    assert process_one(session) is True
    assert process_one(session) is False
    run = session.get(Run, run_id)

    assert run.status == "failed"
    assert all(stage.status in {"failed", "skipped"} for stage in run.stages)
    assert session.scalar(select(ActiveRunSlot).where(ActiveRunSlot.run_id == run_id)) is None


def test_ready_states_require_all_dependencies(client, session):
    protein_id = _create_protein(client)
    run_id = client.post("/api/v1/runs", json={"protein_id": protein_id}).json()["id"]
    run = session.get(Run, run_id)
    assert run is not None

    root = next(stage for stage in run.stages if stage.stage_id == "protein_identity")
    transition_stage(session, root, RunStageStatus.SUCCESS)
    session.commit()

    refresh_ready_states(session, {run_id})
    states = {stage.stage_id: RunStageStatus(stage.status) for stage in run.stages}
    selected_stage_ids = set(run.configuration.selected_stage_ids)
    for definition in STAGE_DEFINITIONS:
        if definition.dependencies == ("protein_identity",):
            expected = (
                RunStageStatus.READY
                if definition.id in selected_stage_ids
                else RunStageStatus.SKIPPED
            )
            assert states[definition.id] == expected
        elif (
            definition.id != "protein_identity" and states[definition.id] != RunStageStatus.SKIPPED
        ):
            assert states[definition.id] == RunStageStatus.PENDING


def test_dependency_failure_propagates_skipped_descendants(client, session):
    protein_id = _create_protein(client)
    run_id = client.post("/api/v1/runs", json={"protein_id": protein_id}).json()["id"]
    failing_run = session.get(Run, run_id)
    assert failing_run is not None
    root = next(stage for stage in failing_run.stages if stage.stage_id == "protein_identity")
    transition_stage(session, root, RunStageStatus.FAILED)
    session.commit()

    # Each pass only consumes the state made visible by the previous pass;
    # repeating the worker refresh models the durable propagation tick-by-tick.
    for _ in range(len(STAGE_DEFINITIONS)):
        refresh_ready_states(session, {run_id})

    final_states = {stage.stage_id: RunStageStatus(stage.status) for stage in failing_run.stages}
    for definition in STAGE_DEFINITIONS:
        if definition.id == "protein_identity":
            continue
        assert final_states[definition.id] == RunStageStatus.SKIPPED

    # Keep the assertion coupled to the registry: a new stage with a missing
    # dependency must fail the test instead of silently escaping the matrix.
    assert set(final_states) == set(STAGE_BY_ID)


def test_run_create_and_cancel_are_audited_without_scientific_payloads(client, session):
    protein_id = _create_protein(client)
    created = client.post(
        "/api/v1/runs",
        json={
            "protein_id": protein_id,
            "variants": [{"aa_position": 1, "aa_ref": "A", "aa_alt": "C"}],
        },
    )
    assert created.status_code == 201
    run_id = created.json()["id"]

    cancelled = client.post(f"/api/v1/runs/{run_id}/cancel")
    assert cancelled.status_code == 200

    events = list(session.scalars(select(AuditEvent)))
    assert {event.action for event in events} == {"create_run", "cancel_run"}
    assert all(event.resource_id == run_id for event in events)
    assert all("sequence" not in event.details for event in events)
    create_event = next(event for event in events if event.action == "create_run")
    assert create_event.details["requested_variant_count"] == 1
