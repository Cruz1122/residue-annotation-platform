import hashlib
from pathlib import Path

import pytest
from app.core.config import Settings, get_settings
from app.features.auth import router as auth_router
from app.features.auth.models import AuditEvent, User, UserRole
from app.features.auth.service import AdminBootstrapError, bootstrap_first_admin, issue_access_token
from app.features.runs.models import Artifact, Run, StageResult
from app.features.runs.state import RunStageStatus
from app.main import app
from fastapi import HTTPException
from sqlalchemy.orm import Session as SqlAlchemySession
from starlette.requests import Request

PASSWORD = "correct horse battery staple"


def _register_and_verify(client, email: str = "alice@example.com") -> dict:
    registered = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": PASSWORD},
    )
    assert registered.status_code == 201
    verification_token = registered.json()["verification_token"]
    verified = client.post(
        "/api/v1/auth/verify-email",
        json={"token": verification_token},
    )
    assert verified.status_code == 200
    return verified.json()["user"]


def test_auth_register_verify_login_me_and_rotating_refresh(client, session):
    registered = client.post(
        "/api/v1/auth/register",
        json={"email": "Alice@Example.com", "password": PASSWORD},
    )
    assert registered.status_code == 201
    assert registered.json()["verification_token"]

    before_verification = client.post(
        "/api/v1/auth/login",
        json={"email": "alice@example.com", "password": PASSWORD},
    )
    assert before_verification.status_code == 403

    verification = client.post(
        "/api/v1/auth/verify-email",
        json={"token": registered.json()["verification_token"]},
    )
    assert verification.status_code == 200
    assert verification.json()["user"]["role"] == "user"

    login = client.post(
        "/api/v1/auth/login",
        json={"email": "alice@example.com", "password": PASSWORD},
    )
    assert login.status_code == 200
    first_tokens = login.json()
    headers = {"Authorization": f"Bearer {first_tokens['access_token']}"}

    me = client.get("/api/v1/auth/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["user"]["email"] == "alice@example.com"
    assert me.json()["user"]["role"] == "user"

    refreshed = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": first_tokens["refresh_token"]},
    )
    assert refreshed.status_code == 200
    second_tokens = refreshed.json()
    assert second_tokens["refresh_token"] != first_tokens["refresh_token"]
    assert second_tokens["user"]["role"] == "user"

    replay = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": first_tokens["refresh_token"]},
    )
    assert replay.status_code == 401

    logout = client.post(
        "/api/v1/auth/logout",
        json={"refresh_token": second_tokens["refresh_token"]},
    )
    assert logout.status_code == 200
    assert session.query(AuditEvent).count() >= 4


def test_registration_rejects_role_injection_and_creates_only_users(client, session):
    injected = client.post(
        "/api/v1/auth/register",
        json={"email": "attacker@example.com", "password": PASSWORD, "role": "admin"},
    )

    assert injected.status_code == 422
    assert session.query(User).count() == 0

    registered = _register_and_verify(client, "normal@example.com")
    assert registered["role"] == UserRole.USER.value
    assert session.query(User).one().role == UserRole.USER.value


def test_role_management_patch_is_allowed_by_cors(client):
    response = client.options(
        "/api/v1/auth/users/user-id/role",
        headers={
            "Origin": "http://localhost:4742",
            "Access-Control-Request-Method": "PATCH",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )

    assert response.status_code == 200
    assert "PATCH" in response.headers["access-control-allow-methods"]


def test_password_change_invalidates_old_access_and_refresh_tokens(client):
    _register_and_verify(client)
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "alice@example.com", "password": PASSWORD},
    ).json()
    old_headers = {"Authorization": f"Bearer {login['access_token']}"}

    changed = client.post(
        "/api/v1/auth/change-password",
        headers=old_headers,
        json={"current_password": PASSWORD, "password": "new correct password"},
    )
    assert changed.status_code == 200

    old_me = client.get("/api/v1/auth/me", headers=old_headers)
    assert old_me.status_code == 401
    old_refresh = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": login["refresh_token"]},
    )
    assert old_refresh.status_code == 401

    new_login = client.post(
        "/api/v1/auth/login",
        json={"email": "alice@example.com", "password": "new correct password"},
    )
    assert new_login.status_code == 200


def test_password_change_invalidates_pending_reset_token(client):
    _register_and_verify(client)
    login = _login(client)
    requested = client.post(
        "/api/v1/auth/reset-password",
        json={"email": "alice@example.com"},
    )
    reset_token = requested.json()["reset_token"]

    changed = client.post(
        "/api/v1/auth/change-password",
        headers={"Authorization": f"Bearer {login['access_token']}"},
        json={"current_password": PASSWORD, "password": "new correct password"},
    )
    assert changed.status_code == 200

    stale_reset = client.post(
        "/api/v1/auth/reset-password/confirm",
        json={"token": reset_token, "password": "attacker selected password"},
    )
    assert stale_reset.status_code == 400


def test_password_reset_is_one_time_and_invalidates_sessions(client, session):
    _register_and_verify(client)
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "alice@example.com", "password": PASSWORD},
    ).json()

    requested = client.post(
        "/api/v1/auth/reset-password",
        json={"email": "alice@example.com"},
    )
    assert requested.status_code == 202
    reset_token = requested.json()["reset_token"]

    reset = client.post(
        "/api/v1/auth/reset-password/confirm",
        json={"token": reset_token, "password": "reset correct password"},
    )
    assert reset.status_code == 200

    replay = client.post(
        "/api/v1/auth/reset-password/confirm",
        json={"token": reset_token, "password": "another password"},
    )
    assert replay.status_code == 400

    old_refresh = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": login["refresh_token"]},
    )
    assert old_refresh.status_code == 401
    user = session.query(User).one()
    assert user.email_verified_at is not None


def test_protected_auth_endpoint_requires_bearer_token(client):
    response = client.get("/api/v1/auth/me")
    assert response.status_code == 401


def test_login_rate_limit_returns_retry_after(client, tmp_path: Path):
    _register_and_verify(client)
    app.dependency_overrides[get_settings] = lambda: Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        auth_rate_limit_login=1,
    )

    first = client.post(
        "/api/v1/auth/login",
        json={"email": "alice@example.com", "password": "wrong password"},
    )
    second = client.post(
        "/api/v1/auth/login",
        json={"email": "alice@example.com", "password": "wrong password"},
    )

    assert first.status_code == 401
    assert second.status_code == 429
    assert int(second.headers["Retry-After"]) >= 1


def test_production_principal_rejects_untrusted_headers(client, tmp_path: Path):
    app.dependency_overrides[get_settings] = lambda: Settings(
        app_env="production",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        auth_jwt_secret="production-test-secret-that-is-long-enough",
        auth_trusted_headers_enabled=False,
        email_provider="resend",
        resend_api_key="re_test_only",
        email_from="Residue Annotation <accounts@example.org>",
        frontend_base_url="https://app.example.org",
    )

    response = client.get(
        "/api/v1/proteins",
        headers={"X-User-Id": "attacker", "X-Project-Id": "attacker-project"},
    )

    assert response.status_code == 401


def test_bearer_ownership_blocks_access_between_users(client):
    _register_and_verify(client, "alice@example.com")
    _register_and_verify(client, "bob@example.com")
    alice = client.post(
        "/api/v1/auth/login",
        json={"email": "alice@example.com", "password": PASSWORD},
    ).json()
    bob = client.post(
        "/api/v1/auth/login",
        json={"email": "bob@example.com", "password": PASSWORD},
    ).json()
    alice_headers = {"Authorization": f"Bearer {alice['access_token']}"}
    bob_headers = {"Authorization": f"Bearer {bob['access_token']}"}

    protein = client.post(
        "/api/v1/proteins",
        headers=alice_headers,
        json={"sequence": "ACDE"},
    )
    assert protein.status_code == 201
    protein_id = protein.json()["id"]

    assert client.get(f"/api/v1/proteins/{protein_id}", headers=bob_headers).status_code == 403
    upload = client.post(
        "/api/v1/uploads",
        headers=alice_headers,
        files={"file": ("query.fasta", b">query\nACDE", "text/plain")},
        data={"input_type": "fasta"},
    )
    assert upload.status_code == 201
    assert (
        client.get(f"/api/v1/uploads/{upload.json()['id']}", headers=bob_headers).status_code == 404
    )
    run = client.post("/api/v1/runs", headers=alice_headers, json={"protein_id": protein_id})
    assert run.status_code == 201
    assert client.get(f"/api/v1/runs/{run.json()['id']}", headers=bob_headers).status_code == 403


def test_first_admin_bootstrap_requires_a_verified_account_and_runs_once(client, session):
    client.post(
        "/api/v1/auth/register",
        json={"email": "pending@example.com", "password": PASSWORD},
    )
    with pytest.raises(AdminBootstrapError, match="not verified"):
        bootstrap_first_admin(session, "pending@example.com")
    session.rollback()

    _register_and_verify(client, "admin@example.com")
    administrator = bootstrap_first_admin(session, "ADMIN@example.com")
    session.commit()

    assert administrator.role == UserRole.ADMIN.value
    assert session.query(AuditEvent).filter_by(action="bootstrap_admin").count() == 1
    with pytest.raises(AdminBootstrapError, match="already exists"):
        bootstrap_first_admin(session, "pending@example.com")


def test_admin_management_is_admin_only_invalidates_sessions_and_preserves_last_admin(
    client, session
):
    first_admin = _register_and_verify(client, "admin@example.com")
    second_user = _register_and_verify(client, "second@example.com")
    bootstrap_first_admin(session, "admin@example.com")
    session.commit()
    admin_tokens = _login(client, "admin@example.com")
    user_tokens = _login(client, "second@example.com")
    admin_headers = {"Authorization": f"Bearer {admin_tokens['access_token']}"}
    user_headers = {"Authorization": f"Bearer {user_tokens['access_token']}"}

    assert client.get("/api/v1/auth/users", headers=user_headers).status_code == 403
    denied = client.patch(
        f"/api/v1/auth/users/{first_admin['id']}/role",
        headers=user_headers,
        json={"role": "user"},
    )
    assert denied.status_code == 403

    listed = client.get("/api/v1/auth/users", headers=admin_headers)
    assert listed.status_code == 200
    assert {item["role"] for item in listed.json()} == {"admin", "user"}

    promoted = client.patch(
        f"/api/v1/auth/users/{second_user['id']}/role",
        headers=admin_headers,
        json={"role": "admin"},
    )
    assert promoted.status_code == 200
    assert promoted.json()["role"] == "admin"
    assert client.get("/api/v1/auth/me", headers=user_headers).status_code == 401

    second_admin_tokens = _login(client, "second@example.com")
    second_admin_headers = {"Authorization": f"Bearer {second_admin_tokens['access_token']}"}
    demoted = client.patch(
        f"/api/v1/auth/users/{first_admin['id']}/role",
        headers=second_admin_headers,
        json={"role": "user"},
    )
    assert demoted.status_code == 200
    assert demoted.json()["role"] == "user"
    assert client.get("/api/v1/auth/me", headers=admin_headers).status_code == 401

    last_admin = client.patch(
        f"/api/v1/auth/users/{second_user['id']}/role",
        headers=second_admin_headers,
        json={"role": "user"},
    )
    assert last_admin.status_code == 409
    assert "last administrator" in last_admin.json()["detail"]
    session.expire_all()
    assert session.get(User, second_user["id"]).role == UserRole.ADMIN.value
    assert session.query(AuditEvent).filter_by(action="change_user_role").count() == 2


def test_admin_can_access_resources_outside_own_project(client, session, tmp_path: Path):
    _register_and_verify(client, "owner@example.com")
    _register_and_verify(client, "admin@example.com")
    bootstrap_first_admin(session, "admin@example.com")
    session.commit()
    owner_tokens = _login(client, "owner@example.com")
    admin_tokens = _login(client, "admin@example.com")
    owner_headers = {"Authorization": f"Bearer {owner_tokens['access_token']}"}
    admin_headers = {"Authorization": f"Bearer {admin_tokens['access_token']}"}

    protein = client.post(
        "/api/v1/proteins",
        headers=owner_headers,
        json={"sequence": "ACDE"},
    )
    upload = client.post(
        "/api/v1/uploads",
        headers=owner_headers,
        files={"file": ("query.fasta", b">query\nACDE", "text/plain")},
        data={"input_type": "fasta"},
    )
    run = client.post(
        "/api/v1/runs",
        headers=owner_headers,
        json={"protein_id": protein.json()["id"]},
    )
    assert (protein.status_code, upload.status_code, run.status_code) == (201, 201, 201)

    assert (
        client.get(f"/api/v1/proteins/{protein.json()['id']}", headers=admin_headers).status_code
        == 200
    )
    listed = client.get("/api/v1/proteins", headers=admin_headers)
    assert protein.json()["id"] in {item["id"] for item in listed.json()}
    assert (
        client.get(f"/api/v1/uploads/{upload.json()['id']}", headers=admin_headers).status_code
        == 200
    )
    assert client.get(f"/api/v1/runs/{run.json()['id']}", headers=admin_headers).status_code == 200

    persisted_run = session.get(Run, run.json()["id"])
    stage = next(item for item in persisted_run.stages if item.stage_id == "protein_identity")
    result = StageResult(
        protein_id=persisted_run.protein_id,
        stage_id=stage.stage_id,
        cache_key="a" * 64,
        status="success",
        provenance={"source": "authorization-test"},
        owner_id=persisted_run.owner_id,
        project_id=persisted_run.project_id,
    )
    session.add(result)
    session.flush()
    stage.stage_result_id = result.id
    stage.status = RunStageStatus.SUCCESS
    storage_key = "authorization/admin-access.txt"
    path = tmp_path / "artifacts" / storage_key
    path.parent.mkdir(parents=True, exist_ok=True)
    artifact_payload = b"verified"
    path.write_bytes(artifact_payload)
    artifact = Artifact(
        stage_result_id=result.id,
        artifact_type="authorization-test",
        storage_backend="filesystem",
        storage_key=storage_key,
        sha256=hashlib.sha256(artifact_payload).hexdigest(),
        size=len(artifact_payload),
        media_type="text/plain",
    )
    session.add(artifact)
    session.commit()

    assert client.get(f"/api/v1/artifacts/{artifact.id}", headers=admin_headers).status_code == 200


def test_bootstrap_admin_management_command(client, session, capsys):
    from app.manage import main

    _register_and_verify(client, "operator@example.com")
    bind = session.get_bind()

    def session_factory() -> SqlAlchemySession:
        return SqlAlchemySession(bind=bind, expire_on_commit=False)

    assert (
        main(
            ["bootstrap-admin", "--email", "operator@example.com"],
            session_factory=session_factory,
        )
        == 0
    )
    session.expire_all()
    assert session.query(User).filter_by(email="operator@example.com").one().role == "admin"
    assert "Administrator bootstrapped" in capsys.readouterr().out

    assert (
        main(
            ["bootstrap-admin", "--email", "operator@example.com"],
            session_factory=session_factory,
        )
        == 1
    )
    assert "already exists" in capsys.readouterr().err


def _login(client, email: str = "alice@example.com") -> dict:
    response = client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": PASSWORD},
    )
    assert response.status_code == 200
    return response.json()


def test_bearer_logout_revokes_every_session_and_access_token(client):
    _register_and_verify(client)
    first = _login(client)
    second = _login(client)
    headers = {"Authorization": f"Bearer {first['access_token']}"}

    logout = client.post("/api/v1/auth/logout", headers=headers)

    assert logout.status_code == 200
    assert client.get("/api/v1/auth/me", headers=headers).status_code == 401
    for tokens in (first, second):
        replay = client.post(
            "/api/v1/auth/refresh",
            json={"refresh_token": tokens["refresh_token"]},
        )
        assert replay.status_code == 401


def test_refresh_logout_revokes_only_the_presented_session(client):
    _register_and_verify(client)
    first = _login(client)
    second = _login(client)
    first_headers = {"Authorization": f"Bearer {first['access_token']}"}

    logout = client.post(
        "/api/v1/auth/logout",
        json={"refresh_token": first["refresh_token"]},
    )

    assert logout.status_code == 200
    surviving = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": second["refresh_token"]},
    )
    assert surviving.status_code == 200
    # Replaying the revoked token is treated as reuse and revokes the family.
    revoked = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": first["refresh_token"]},
    )
    assert revoked.status_code == 401
    # Access tokens are stateless; a single-session logout does not invalidate them.
    assert client.get("/api/v1/auth/me", headers=first_headers).status_code == 200


def test_logout_of_rotated_refresh_token_revokes_its_replacement(client):
    _register_and_verify(client)
    original = _login(client)
    rotated = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": original["refresh_token"]},
    )
    assert rotated.status_code == 200

    logout = client.post(
        "/api/v1/auth/logout",
        json={"refresh_token": original["refresh_token"]},
    )
    assert logout.status_code == 200

    replacement = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": rotated.json()["refresh_token"]},
    )
    assert replacement.status_code == 401


def test_logout_accepts_lowercase_bearer_scheme(client):
    _register_and_verify(client)
    tokens = _login(client)

    logout = client.post(
        "/api/v1/auth/logout",
        headers={"Authorization": f"bearer {tokens['access_token']}"},
    )

    assert logout.status_code == 200
    assert (
        client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        ).status_code
        == 401
    )


def _request_from(ip: str) -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/v1/auth/login",
            "headers": [],
            "query_string": b"",
            "scheme": "http",
            "server": ("testserver", 80),
            "client": (ip, 1234),
        }
    )


def test_rate_limit_account_bucket_survives_ip_rotation(session, tmp_path: Path):
    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        auth_rate_limit_login=1,
    )

    auth_router._enforce(
        session,
        _request_from("10.0.0.1"),
        settings,
        scope="login",
        value="alice@example.com",
        limit=1,
        account_value="alice@example.com",
    )

    with pytest.raises(HTTPException) as error:
        auth_router._enforce(
            session,
            _request_from("10.0.0.2"),
            settings,
            scope="login",
            value="alice@example.com",
            limit=1,
            account_value="alice@example.com",
        )

    assert error.value.status_code == 429
    assert int(error.value.headers["Retry-After"]) >= 1


def test_stale_bearer_logout_does_not_revoke_fresh_sessions(client):
    _register_and_verify(client)
    first = _login(client)
    second = _login(client)

    changed = client.post(
        "/api/v1/auth/change-password",
        headers={"Authorization": f"Bearer {second['access_token']}"},
        json={"current_password": PASSWORD, "password": "another correct password"},
    )
    assert changed.status_code == 200
    fresh = changed.json()

    stale_logout = client.post(
        "/api/v1/auth/logout",
        headers={"Authorization": f"Bearer {first['access_token']}"},
    )

    assert stale_logout.status_code == 200
    assert (
        client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {fresh['access_token']}"},
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/v1/auth/refresh",
            json={"refresh_token": fresh["refresh_token"]},
        ).status_code
        == 200
    )


def test_aggregate_ip_bucket_blocks_multiple_accounts(session, tmp_path: Path):
    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        auth_rate_limit_login=1,
        auth_rate_limit_ip=1,
    )

    auth_router._enforce(
        session,
        _request_from("10.0.0.7"),
        settings,
        scope="login",
        value="a@example.com",
        limit=1,
        account_value="a@example.com",
    )

    with pytest.raises(HTTPException) as error:
        auth_router._enforce(
            session,
            _request_from("10.0.0.7"),
            settings,
            scope="login",
            value="b@example.com",
            limit=1,
            account_value="b@example.com",
        )

    assert error.value.status_code == 429


def test_malformed_unicode_returns_structured_422(client):
    response = client.post(
        "/api/v1/auth/register",
        content=b'{"email":"\\ud800@example.com","password":"correct horse battery staple"}',
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 422
    assert "detail" in response.json()


def test_production_trusted_headers_require_both_headers(client, tmp_path: Path):
    app.dependency_overrides[get_settings] = lambda: Settings(
        app_env="production",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        auth_jwt_secret="production-test-secret-that-is-long-enough",
        auth_trusted_headers_enabled=True,
        email_provider="resend",
        resend_api_key="re_test_only",
        email_from="Residue Annotation <accounts@example.org>",
        frontend_base_url="https://app.example.org",
    )

    assert client.get("/api/v1/proteins").status_code == 401
    allowed = client.get(
        "/api/v1/proteins",
        headers={"X-User-Id": "u1", "X-Project-Id": "p1"},
    )
    assert allowed.status_code == 200


def test_staging_rejects_default_jwt_secret(tmp_path: Path):
    settings = Settings(
        app_env="staging",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
    )
    user = User(id="u-1", email="x@example.com", project_id="p-1", password_hash="x")

    with pytest.raises(RuntimeError):
        issue_access_token(user, settings)
