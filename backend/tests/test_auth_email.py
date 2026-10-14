from __future__ import annotations

import pytest
from app.core.config import Settings, get_settings
from app.features.auth.email import (
    AuthEmail,
    EmailDeliveryError,
    password_reset_email,
    send_auth_email,
    verification_email,
)
from app.features.auth.models import User
from app.main import app
from pydantic import ValidationError

PASSWORD = "correct horse battery staple"


def _resend_settings(tmp_path) -> Settings:
    return Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        email_provider="resend",
        resend_api_key="re_test_only",
        email_from="Residue Annotation <accounts@example.org>",
        frontend_base_url="https://app.example.org/",
    )


def test_auth_email_templates_use_configured_frontend_and_encode_token(tmp_path):
    settings = _resend_settings(tmp_path)

    verification = verification_email(settings, "token with & symbols")
    reset = password_reset_email(settings, "reset/value")

    assert (
        "https://app.example.org/auth/verify-email/#token=token+with+%26+symbols"
        in verification.text
    )
    assert "token+with+%26amp%3B+symbols" not in verification.html
    assert "token+with+%26+symbols" in verification.html
    assert "https://app.example.org/auth/reset-password/#token=reset%2Fvalue" in reset.text
    assert "24 horas" in verification.text
    assert "30 minutos" in reset.text


def test_resend_delivery_passes_text_html_and_category(monkeypatch, tmp_path):
    settings = _resend_settings(tmp_path)
    captured: dict[str, object] = {}

    def fake_send(params):
        captured.update(params)
        return {"id": "email-123"}

    monkeypatch.setattr("app.features.auth.email.resend.Emails.send", fake_send)
    message = AuthEmail(subject="Subject", text="Plain", html="<strong>HTML</strong>")

    assert send_auth_email(settings, "person@example.org", message) == "email-123"
    assert captured == {
        "from": "Residue Annotation <accounts@example.org>",
        "to": ["person@example.org"],
        "subject": "Subject",
        "text": "Plain",
        "html": "<strong>HTML</strong>",
        "tags": [{"name": "category", "value": "account_security"}],
    }


def test_production_requires_operational_email_and_https(tmp_path):
    common = {
        "app_env": "production",
        "database_url": "sqlite://",
        "artifact_root": tmp_path / "artifacts",
        "auth_jwt_secret": "production-test-secret-that-is-long-enough",
    }

    with pytest.raises(ValidationError, match="EMAIL_PROVIDER=resend"):
        Settings(**common)
    with pytest.raises(ValidationError, match="HTTPS"):
        Settings(
            **common,
            email_provider="resend",
            resend_api_key="re_test_only",
            email_from="Residue Annotation <accounts@example.org>",
            frontend_base_url="http://app.example.org",
        )


def test_registration_dispatches_verification_email(monkeypatch, client, tmp_path):
    settings = _resend_settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings
    delivered: list[tuple[str, str]] = []
    monkeypatch.setattr(
        "app.features.auth.router.send_verification_email",
        lambda _settings, recipient, token: delivered.append((recipient, token)),
    )

    response = client.post(
        "/api/v1/auth/register",
        json={"email": "Person@Example.org", "password": PASSWORD},
    )

    assert response.status_code == 201
    assert delivered == [("person@example.org", response.json()["verification_token"])]


def test_registration_persists_account_before_reporting_delivery_failure(
    monkeypatch, client, session, tmp_path
):
    settings = _resend_settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings

    def fail_delivery(*_args, **_kwargs):
        raise EmailDeliveryError("sanitized provider failure")

    monkeypatch.setattr("app.features.auth.router.send_verification_email", fail_delivery)

    response = client.post(
        "/api/v1/auth/register",
        json={"email": "person@example.org", "password": PASSWORD},
    )

    assert response.status_code == 503
    assert "verification email" in response.json()["detail"]
    assert session.query(User).filter_by(email="person@example.org").one().email_verified_at is None


def test_reset_delivery_failure_keeps_non_enumerating_response(monkeypatch, client, tmp_path):
    registered = client.post(
        "/api/v1/auth/register",
        json={"email": "person@example.org", "password": PASSWORD},
    )
    token = registered.json()["verification_token"]
    assert client.post("/api/v1/auth/verify-email", json={"token": token}).status_code == 200

    settings = _resend_settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings

    def fail_delivery(*_args, **_kwargs):
        raise EmailDeliveryError("sanitized provider failure")

    monkeypatch.setattr("app.features.auth.router.send_password_reset_email", fail_delivery)

    existing = client.post("/api/v1/auth/reset-password", json={"email": "person@example.org"})
    missing = client.post("/api/v1/auth/reset-password", json={"email": "missing@example.org"})

    assert existing.status_code == missing.status_code == 202
    assert existing.json()["message"] == missing.json()["message"]
