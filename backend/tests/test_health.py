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
