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


def test_run_history_keeps_two_runs_of_one_protein_independent(client):
    protein_id = _create_protein(client)
    first = client.post("/api/v1/runs", json={"protein_id": protein_id})
    assert first.status_code == 201
    first_id = first.json()["id"]
    assert client.post(f"/api/v1/runs/{first_id}/cancel").status_code == 200

    second = client.post(
        "/api/v1/runs",
        json={
            "protein_id": protein_id,
            "variants": [{"aa_position": 1, "aa_ref": "A", "aa_alt": "C"}],
        },
    )
    assert second.status_code == 201
    second_id = second.json()["id"]

    history = client.get("/api/v1/runs")

    assert history.status_code == 200
    payload = history.json()
    by_id = {item["id"]: item for item in payload}
    assert {first_id, second_id}.issubset(by_id)
    assert by_id[first_id]["status"] == "cancelled"
    assert by_id[first_id]["requested_variants"] == []
    assert by_id[second_id]["requested_variants"] == [
        {"aa_position": 1, "aa_ref": "A", "aa_alt": "C"}
    ]
    assert len(by_id[first_id]["stages"]) == len(by_id[second_id]["stages"]) == 18


def test_projects_create_independent_runs_from_the_same_shared_protein(client, session):
    project_a = {"X-User-Id": "user-a", "X-Project-Id": "project-a"}
    project_b = {"X-User-Id": "user-b", "X-Project-Id": "project-b"}
    first_protein = client.post("/api/v1/proteins", headers=project_a, json={"sequence": SEQUENCE})
    assert first_protein.status_code == 201
    first_run = client.post(
        "/api/v1/runs", headers=project_a, json={"protein_id": first_protein.json()["id"]}
    )
    assert first_run.status_code == 201, first_run.text

    second_protein = client.post(
        "/api/v1/proteins", headers=project_b, json={"sequence": SEQUENCE.lower()}
    )
    assert second_protein.status_code == 200, second_protein.text
    assert second_protein.json()["id"] == first_protein.json()["id"]
    second_run = client.post(
        "/api/v1/runs", headers=project_b, json={"protein_id": second_protein.json()["id"]}
    )

    assert second_run.status_code == 201, second_run.text
    assert second_run.json()["id"] != first_run.json()["id"]
    second_run_row = session.get(Run, second_run.json()["id"])
    assert second_run_row is not None
    assert second_run_row.owner_id == "user-b"
    assert second_run_row.project_id == "project-b"
    assert client.get("/api/v1/runs", headers=project_a).json()[0]["id"] == first_run.json()["id"]
    assert client.get("/api/v1/runs", headers=project_b).json()[0]["id"] == second_run.json()["id"]
    assert (
        client.get(f"/api/v1/runs/{first_run.json()['id']}", headers=project_b).status_code == 403
    )
    assert (
        client.get(f"/api/v1/runs/{second_run.json()['id']}", headers=project_a).status_code == 403
    )
    unlinked_project = {"X-User-Id": "user-c", "X-Project-Id": "project-c"}
    unlinked_run = client.post(
        "/api/v1/runs",
        headers=unlinked_project,
        json={"protein_id": first_protein.json()["id"]},
    )
    assert unlinked_run.status_code == 403


def test_run_history_supports_authorized_pagination(client):
    protein_id = _create_protein(client)
    run_ids = []
    for _ in range(3):
        created = client.post("/api/v1/runs", json={"protein_id": protein_id})
        assert created.status_code == 201
        run_ids.append(created.json()["id"])
        assert client.post(f"/api/v1/runs/{run_ids[-1]}/cancel").status_code == 200

    first_page = client.get("/api/v1/runs?limit=2&offset=0")
    second_page = client.get("/api/v1/runs?limit=2&offset=2")

    assert first_page.status_code == second_page.status_code == 200
    assert len(first_page.json()) == 2
    assert len(second_page.json()) == 1
    assert {item["id"] for item in first_page.json() + second_page.json()} == set(run_ids)


def test_cpu_only_remote_run_uses_selected_stage_resources(client):
    from app.core.config import Settings, get_settings
    from app.main import app

    app.dependency_overrides[get_settings] = lambda: Settings(
        app_env="test",
        database_url="sqlite://",
        hpc_execution_mode="ssh",
        hpc_input_transfer_enabled=True,
        hpc_pipeline_cpu_budget=120,
        hpc_pipeline_gpu_budget=0,
    )
    protein = client.post(
        "/api/v1/proteins",
        json={"sequence": SEQUENCE, "aliases": [{"source": "uniprot", "identifier": "P00001"}]},
    )
    assert protein.status_code == 201

    response = client.post(
        "/api/v1/runs",
        json={"protein_id": protein.json()["id"], "scientific_accession": "P00001"},
    )

    assert response.status_code == 201, response.text
    configuration = response.json()["configuration"]
    assert configuration["selected_stage_ids"] == [
        "protein_identity",
        "variant_predictors",
        "pharmacogenomics",
        "uniprot_features",
        "evolutionary_conservation",
        "functional_region_evidence",
        "experimental_variant_evidence",
    ]
    omitted = {item["stage_id"]: item for item in configuration["omitted_stages"]}
    assert omitted["sequence_frustration"]["reason"] == "gpu_unavailable"
    assert omitted["membrane_topology"]["reason"] == "gpu_unavailable"
    assert omitted["structure_modeling"]["reason"] == "gpu_unavailable"
    assert omitted["conformational_ensemble"]["reason"] == "gpu_unavailable"


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


def test_run_provenance_redacts_nested_sensitive_keys(client, session):
    protein_id = _create_protein(client)
    run_id = client.post("/api/v1/runs", json={"protein_id": protein_id}).json()["id"]
    run = session.get(Run, run_id)
    stage = next(item for item in run.stages if item.stage_id == "protein_identity")
    result = StageResult(
        protein_id=protein_id,
        stage_id=stage.stage_id,
        cache_key="e" * 64,
        status="success",
        provenance={
            "tool": "verified-test",
            "password": "secret-value",
            "nested": {
                "api_key": "abc123",
                "client_secret_key": "nested-secret",
                "oauth_token_value": "nested-token",
                "db_password_hash": "nested-password",
                "path": "/gpfs/private/result",
            },
            "list": [{"private_key_material": "list-secret"}],
        },
        owner_id=run.owner_id,
        project_id=run.project_id,
    )
    session.add(result)
    session.flush()
    stage.stage_result_id = result.id
    stage.status = RunStageStatus.SUCCESS
    session.commit()

    response = client.get(f"/api/v1/runs/{run_id}")

    assert response.status_code == 200
    provenance = response.json()["stages"][0]["provenance"]
    assert provenance["tool"] == "verified-test"
    assert provenance["password"] == "<redacted>"
    assert provenance["nested"]["api_key"] == "<redacted>"
    assert provenance["nested"]["client_secret_key"] == "<redacted>"
    assert provenance["nested"]["oauth_token_value"] == "<redacted>"
    assert provenance["nested"]["db_password_hash"] == "<redacted>"
    assert provenance["list"][0]["private_key_material"] == "<redacted>"
    assert "/gpfs/" not in str(provenance)


def test_retryable_preflight_error_is_not_projected_as_terminal_run_error(client, session):
    protein_id = _create_protein(client)
    run_id = client.post("/api/v1/runs", json={"protein_id": protein_id}).json()["id"]
    run = session.get(Run, run_id)
    assert run is not None and run.preparation is not None
    stage = next(item for item in run.stages if item.stage_id == "protein_identity")
    run.preparation.status = "blocked"
    run.preparation.error_code = "temporary_prerequisite_unavailable"
    run.preparation.error_message = "retry later"
    stage.preflight_status = "blocked"
    stage.preflight_error_code = "temporary_prerequisite_unavailable"
    stage.preflight_error_message = "retry later"
    session.commit()

    response = client.get(f"/api/v1/runs/{run_id}")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "pending"
    assert payload["error_code"] is None
    assert payload["error_message"] is None
    assert payload["preparation"]["status"] == "blocked"


def test_worker_finishes_failed_run_after_descendants_are_skipped(client, session):
    protein_id = _create_protein(client)
    run_id = client.post("/api/v1/runs", json={"protein_id": protein_id}).json()["id"]

    assert process_one(session) is True
    assert process_one(session) is False
    run = session.get(Run, run_id)

    assert run.status == "failed"
    assert all(stage.status in {"failed", "skipped"} for stage in run.stages)
    assert session.scalar(select(ActiveRunSlot).where(ActiveRunSlot.run_id == run_id)) is None
    history = client.get("/api/v1/runs").json()
    failed_summary = next(item for item in history if item["id"] == run_id)
    assert failed_summary["error_code"] == "stage_execution_unavailable"
    assert "no reviewed executable adapter" in failed_summary["error_message"]


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
