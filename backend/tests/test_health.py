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
