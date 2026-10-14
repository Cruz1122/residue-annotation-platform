def test_health_contract(client):
    response = client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {"status": "ok"}


def test_unknown_route_is_not_health(client):
    response = client.get("/api/v1/does-not-exist")

    assert response.status_code == 404
    assert response.json() != {"status": "ok"}


def test_database_health(client):
    response = client.get("/api/v1/health/db")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_metrics_endpoint_does_not_expose_run_or_job_identifiers(client):
    response = client.get("/api/v1/metrics")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert "run_id" not in response.text
    assert "job_id" not in response.text


def test_metrics_endpoint_reports_durable_run_and_stage_state(client):
    protein = client.post("/api/v1/proteins", json={"sequence": "ACDEFGHIKLMNPQRSTVWY"})
    assert protein.status_code == 201
    created = client.post("/api/v1/runs", json={"protein_id": protein.json()["id"]})
    assert created.status_code == 201

    response = client.get("/api/v1/metrics")

    assert response.status_code == 200
    assert "rap_metrics_database_available 1" in response.text
    assert 'rap_runs_by_status{status="pending"} 1' in response.text
    assert 'rap_run_stages_by_status{stage_id="protein_identity",status="ready"} 1' in response.text
    assert "rap_active_run_slots 1" in response.text
    assert created.json()["id"] not in response.text
