from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.features.auth.models import (
    AuditEvent,
    AuthToken,
    RateLimitBucket,
    RefreshToken,
    User,
    UserRole,
)
from app.features.auth.schemas import UserRead

PASSWORD_SCRYPT_N = 2**14
PASSWORD_SCRYPT_R = 8
PASSWORD_SCRYPT_P = 1


class AuthTokenInvalid(ValueError):
    pass


class RateLimitExceeded(ValueError):
    def __init__(self, retry_after: int):
        super().__init__("rate limit exceeded")
        self.retry_after = retry_after


def utcnow() -> datetime:
    return datetime.now(UTC)


def normalize_email(email: str) -> str:
    return email.strip().casefold()


def validate_password_strength(password: str, minimum_length: int) -> None:
    if len(password) < minimum_length:
        raise ValueError(f"password must contain at least {minimum_length} characters")
    if password.strip() != password:
        raise ValueError("password must not start or end with whitespace")
    if len(password.encode("utf-8")) > 1024:
        raise ValueError("password is too large")


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=PASSWORD_SCRYPT_N,
        r=PASSWORD_SCRYPT_R,
        p=PASSWORD_SCRYPT_P,
    )
    return (
        f"scrypt${PASSWORD_SCRYPT_N}${PASSWORD_SCRYPT_R}${PASSWORD_SCRYPT_P}"
        f"${_b64(salt)}${_b64(digest)}"
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, n, r, p, salt, expected = encoded.split("$", 5)
        if scheme != "scrypt":
            return False
        n_value = int(n)
        r_value = int(r)
        p_value = int(p)
        if n_value > 2**18 or r_value > 32 or p_value > 8:
            return False
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=_unb64(salt),
            n=n_value,
            r=r_value,
            p=p_value,
        )
        return hmac.compare_digest(actual, _unb64(expected))
    except (ValueError, TypeError):
        return False


def _jwt_secret(settings: Settings) -> str:
    if settings.app_env in {"staging", "production"} and (
        len(settings.auth_jwt_secret) < 32
        or settings.auth_jwt_secret.startswith("development-only")
    ):
        raise RuntimeError("AUTH_JWT_SECRET must be configured outside development and test")
    return settings.auth_jwt_secret


def issue_access_token(user: User, settings: Settings) -> str:
    now = utcnow()
    payload = {
        "sub": user.id,
        "project_id": user.project_id,
        "type": "access",
        "ver": user.token_version,
        "jti": secrets.token_urlsafe(18),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=settings.auth_access_token_minutes)).timestamp()),
    }
    return jwt.encode(payload, _jwt_secret(settings), algorithm="HS256")


def decode_access_token(token: str, settings: Settings) -> dict[str, Any]:
    try:
        payload = jwt.decode(
            token,
            _jwt_secret(settings),
            algorithms=["HS256"],
            options={"require": ["sub", "type", "ver", "jti", "iat", "exp"]},
        )
    except jwt.PyJWTError as exc:
        raise AuthTokenInvalid("invalid access token") from exc
    if payload.get("type") != "access":
        raise AuthTokenInvalid("invalid access token")
    return payload


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_refresh_token(session: Session, user: User, settings: Settings) -> str:
    raw_token = secrets.token_urlsafe(48)
    session.add(
        RefreshToken(
            user_id=user.id,
            token_hash=_token_hash(raw_token),
            expires_at=utcnow() + timedelta(days=settings.auth_refresh_token_days),
        )
    )
    return raw_token


def rotate_refresh_token(session: Session, raw_token: str, settings: Settings) -> tuple[User, str]:
    # Lock ordering is always user -> tokens: logout, change-password and
    # reset-password lock the user row before revoking tokens, so a token
    # inserted here cannot escape their snapshot.
    token_user_id = session.scalar(
        select(RefreshToken.user_id).where(RefreshToken.token_hash == _token_hash(raw_token))
    )
    if token_user_id is None:
        raise AuthTokenInvalid("invalid refresh token")
    session.scalar(select(User).where(User.id == token_user_id).with_for_update())
    token = session.scalar(
        select(RefreshToken)
        .where(RefreshToken.token_hash == _token_hash(raw_token))
        .with_for_update()
    )
    now = utcnow()
    if token is None or token.user_id != token_user_id:
        raise AuthTokenInvalid("invalid refresh token")
    if token.revoked_at is not None:
        session.execute(
            update(RefreshToken)
            .where(RefreshToken.user_id == token.user_id)
            .where(RefreshToken.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        raise AuthTokenInvalid("refresh token was already revoked")
    expires_at = (
        token.expires_at.replace(tzinfo=UTC)
        if token.expires_at.tzinfo is None
        else token.expires_at
    )
    if expires_at <= now:
        token.revoked_at = now
        raise AuthTokenInvalid("refresh token expired")
    user = session.get(User, token.user_id)
    if user is None or not user.is_active:
        raise AuthTokenInvalid("user is unavailable")
    token.revoked_at = now
    new_raw_token = create_refresh_token(session, user, settings)
    session.flush()
    replacement = session.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == _token_hash(new_raw_token))
    )
    token.replaced_by_id = replacement.id if replacement else None
    return user, new_raw_token


def revoke_refresh_tokens(session: Session, user_id: str) -> None:
    # Lock the user first (same order as rotate_refresh_token) so the UPDATE
    # snapshot sees every token committed before this point.
    session.scalar(select(User).where(User.id == user_id).with_for_update())
    session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id)
        .where(RefreshToken.revoked_at.is_(None))
        .values(revoked_at=utcnow())
    )


def revoke_refresh_token_family(session: Session, raw_token: str) -> str | None:
    """Revoke the presented refresh token and every rotated replacement.

    Rotation and this operation share the user -> token lock order, so a
    replacement cannot be committed between traversal and logout.
    """

    token_hash = _token_hash(raw_token)
    user_id = session.scalar(
        select(RefreshToken.user_id).where(RefreshToken.token_hash == token_hash)
    )
    if user_id is None:
        return None
    session.scalar(select(User).where(User.id == user_id).with_for_update())
    token = session.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == token_hash).with_for_update()
    )
    if token is None or token.user_id != user_id:
        return None

    now = utcnow()
    seen: set[str] = set()
    current: RefreshToken | None = token
    while current is not None and current.id not in seen:
        seen.add(current.id)
        current.revoked_at = current.revoked_at or now
        replacement_id = current.replaced_by_id
        current = (
            session.scalar(
                select(RefreshToken)
                .where(RefreshToken.id == replacement_id)
                .where(RefreshToken.user_id == user_id)
                .with_for_update()
            )
            if replacement_id
            else None
        )
    return user_id


def revoke_action_tokens(session: Session, user_id: str, purpose: str) -> None:
    """Consume every outstanding action token of one purpose for an account."""

    session.execute(
        update(AuthToken)
        .where(AuthToken.user_id == user_id)
        .where(AuthToken.purpose == purpose)
        .where(AuthToken.consumed_at.is_(None))
        .values(consumed_at=utcnow())
    )


def create_action_token(session: Session, user: User, purpose: str, lifetime: timedelta) -> str:
    session.execute(
        update(AuthToken)
        .where(AuthToken.user_id == user.id)
        .where(AuthToken.purpose == purpose)
        .where(AuthToken.consumed_at.is_(None))
        .values(consumed_at=utcnow())
    )
    raw_token = secrets.token_urlsafe(48)
    session.add(
        AuthToken(
            user_id=user.id,
            purpose=purpose,
            token_hash=_token_hash(raw_token),
            expires_at=utcnow() + lifetime,
        )
    )
    return raw_token


def consume_action_token(session: Session, raw_token: str, purpose: str) -> User | None:
    action_token = session.scalar(
        select(AuthToken)
        .where(AuthToken.token_hash == _token_hash(raw_token))
        .where(AuthToken.purpose == purpose)
        .with_for_update()
    )
    if action_token is None or action_token.consumed_at is not None:
        return None
    expires_at = (
        action_token.expires_at.replace(tzinfo=UTC)
        if action_token.expires_at.tzinfo is None
        else action_token.expires_at
    )
    if expires_at <= utcnow():
        return None
    user = session.get(User, action_token.user_id)
    if user is None or not user.is_active:
        return None
    action_token.consumed_at = utcnow()
    return user


def serialize_user(user: User) -> UserRead:
    return UserRead(
        id=user.id,
        email=user.email,
        project_id=user.project_id,
        role=user.role,
        email_verified=user.email_verified_at is not None,
        is_active=user.is_active,
        created_at=user.created_at,
    )


class AdminBootstrapError(ValueError):
    pass


class LastAdminError(ValueError):
    pass


def bootstrap_first_admin(session: Session, email: str) -> User:
    """Promote one verified account only while the deployment has no admin.

    Locking the complete, stable user ordering serializes simultaneous bootstrap
    attempts on PostgreSQL. The command that calls this function is an explicit
    operator action; public registration never reaches this path.
    """

    users = list(session.scalars(select(User).order_by(User.id).with_for_update()))
    if any(user.role == UserRole.ADMIN for user in users):
        raise AdminBootstrapError("an administrator already exists")
    normalized_email = normalize_email(email)
    user = next((candidate for candidate in users if candidate.email == normalized_email), None)
    if user is None:
        raise AdminBootstrapError("account does not exist")
    if not user.is_active:
        raise AdminBootstrapError("account is disabled")
    if user.email_verified_at is None:
        raise AdminBootstrapError("account email is not verified")
    user.role = UserRole.ADMIN.value
    user.token_version += 1
    revoke_refresh_tokens(session, user.id)
    record_audit(
        session,
        action="bootstrap_admin",
        # The bootstrap is performed by a database operator, not by the account
        # being promoted, so do not attribute the action to that user.
        actor_user_id=None,
        resource_type="user",
        resource_id=user.id,
        client_ip=None,
        details={"old_role": UserRole.USER.value, "new_role": UserRole.ADMIN.value},
    )
    return user


def change_user_role(session: Session, user: User, new_role: UserRole) -> None:
    """Change a role while preserving at least one administrator."""

    administrators = list(
        session.scalars(
            select(User)
            .where(User.role == UserRole.ADMIN.value)
            .order_by(User.id)
            .with_for_update()
        )
    )
    if user.role == new_role.value:
        return
    if user.role == UserRole.ADMIN.value and new_role == UserRole.USER and len(administrators) <= 1:
        raise LastAdminError("the last administrator cannot be demoted")
    user.role = new_role.value
    user.token_version += 1
    revoke_refresh_tokens(session, user.id)


def record_audit(
    session: Session,
    *,
    action: str,
    actor_user_id: str | None,
    resource_type: str,
    resource_id: str | None,
    client_ip: str | None,
    details: dict[str, object] | None = None,
) -> None:
    # Development/test principals can be configured as headers without a
    # corresponding account row. Keep those local actions auditable as
    # system-scoped events instead of violating the PostgreSQL FK; persisted
    # Bearer/admin users retain their actor identity.
    if actor_user_id is not None and session.get(User, actor_user_id) is None:
        actor_user_id = None
    session.add(
        AuditEvent(
            actor_user_id=actor_user_id,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            client_ip=client_ip,
            details=details or {},
        )
    )


def rate_limit_key(scope: str, value: str) -> str:
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
    return f"auth:{scope}:{digest}"


def enforce_rate_limit(
    session: Session,
    *,
    key: str,
    limit: int,
    window_seconds: int,
) -> None:
    now = utcnow()
    bucket = session.scalar(
        select(RateLimitBucket).where(RateLimitBucket.key == key).with_for_update()
    )
    if bucket is None:
        session.add(RateLimitBucket(key=key, window_started_at=now, count=1))
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            return enforce_rate_limit(session, key=key, limit=limit, window_seconds=window_seconds)
        return

    started_at = (
        bucket.window_started_at.replace(tzinfo=UTC)
        if bucket.window_started_at.tzinfo is None
        else bucket.window_started_at
    )
    elapsed = (now - started_at).total_seconds()
    if elapsed >= window_seconds:
        bucket.window_started_at = now
        bucket.count = 1
        session.commit()
        return
    if bucket.count >= limit:
        session.rollback()
        raise RateLimitExceeded(max(1, int(window_seconds - elapsed)))
    bucket.count += 1
    session.commit()
