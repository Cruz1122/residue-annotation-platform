from __future__ import annotations

import logging
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import get_authenticated_user, require_admin
from app.core.config import Settings, get_settings
from app.core.db import get_db
from app.features.auth.email import (
    EmailDeliveryError,
    send_password_reset_email,
    send_verification_email,
)
from app.features.auth.models import User, UserRole
from app.features.auth.schemas import (
    ActionResponse,
    ChangePasswordRequest,
    EmailRequest,
    LoginRequest,
    LoginResponse,
    LogoutRequest,
    MeResponse,
    RefreshRequest,
    RegisterRequest,
    ResetPasswordConfirmRequest,
    UserRead,
    UserRoleUpdate,
    VerifyEmailRequest,
    VerifyEmailResponse,
)
from app.features.auth.service import (
    AuthTokenInvalid,
    LastAdminError,
    RateLimitExceeded,
    change_user_role,
    consume_action_token,
    create_action_token,
    create_refresh_token,
    decode_access_token,
    enforce_rate_limit,
    hash_password,
    issue_access_token,
    normalize_email,
    rate_limit_key,
    record_audit,
    revoke_action_tokens,
    revoke_refresh_token_family,
    revoke_refresh_tokens,
    rotate_refresh_token,
    serialize_user,
    utcnow,
    validate_password_strength,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])
logger = logging.getLogger(__name__)


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _enforce(
    session: Session,
    request: Request,
    settings: Settings,
    *,
    scope: str,
    value: str,
    limit: int,
    account_value: str | None = None,
) -> None:
    ip = _client_ip(request)
    checks = [
        (rate_limit_key(scope, f"{ip}:{value}"), limit),
        # Aggregate per-IP bucket bounds credential stuffing across accounts.
        # Its own limit avoids over-blocking users behind NAT/reverse proxies.
        (rate_limit_key(f"{scope}:ip", ip), settings.auth_rate_limit_ip),
    ]
    if account_value is not None:
        # A per-account bucket also bounds distributed attempts that rotate IPs.
        checks.append((rate_limit_key(f"{scope}:account", account_value), limit))
    for key, key_limit in checks:
        try:
            enforce_rate_limit(
                session,
                key=key,
                limit=key_limit,
                window_seconds=settings.auth_rate_limit_window_seconds,
            )
        except RateLimitExceeded as exc:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many authentication attempts",
                headers={"Retry-After": str(exc.retry_after)},
            ) from exc


def _token_response(session: Session, user: User, settings: Settings) -> LoginResponse:
    access_token = issue_access_token(user, settings)
    refresh_token = create_refresh_token(session, user, settings)
    return LoginResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=settings.auth_access_token_minutes * 60,
        user=serialize_user(user),
    )


def _dev_token(settings: Settings, token: str, field: str) -> dict[str, str]:
    if settings.app_env in {"development", "test"}:
        return {field: token}
    return {}


@router.post("/register", response_model=ActionResponse, status_code=status.HTTP_201_CREATED)
def register(
    payload: RegisterRequest,
    request: Request,
    session: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ActionResponse:
    email = normalize_email(str(payload.email))
    _enforce(
        session,
        request,
        settings,
        scope="register",
        value=email,
        limit=settings.auth_rate_limit_register,
        account_value=email,
    )
    try:
        validate_password_strength(payload.password, settings.auth_password_min_length)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from exc
    if session.scalar(select(User).where(User.email == email)) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Account already exists")

    # Registration is intentionally least-privileged. Roles can only be
    # changed through the administrator boundary or the first-admin command.
    user = User(
        email=email,
        password_hash=hash_password(payload.password),
        role=UserRole.USER.value,
    )
    session.add(user)
    try:
        session.flush()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Account already exists"
        ) from exc
    verification_token = create_action_token(
        session,
        user,
        "verify_email",
        timedelta(hours=settings.auth_verification_token_hours),
    )
    record_audit(
        session,
        action="register",
        actor_user_id=user.id,
        resource_type="user",
        resource_id=user.id,
        client_ip=_client_ip(request),
    )
    session.commit()
    try:
        send_verification_email(settings, user.email, verification_token)
    except EmailDeliveryError as exc:
        logger.error("Verification email delivery failed for user_id=%s", user.id)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Account created, but the verification email could not be sent; "
                "request a new verification email"
            ),
        ) from exc
    response_data = {
        "message": "Account created; verify your email before login",
        **_dev_token(settings, verification_token, "verification_token"),
    }
    return ActionResponse(**response_data)


@router.post("/login", response_model=LoginResponse)
def login(
    payload: LoginRequest,
    request: Request,
    session: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> LoginResponse:
    email = normalize_email(str(payload.email))
    _enforce(
        session,
        request,
        settings,
        scope="login",
        value=email,
        limit=settings.auth_rate_limit_login,
        account_value=email,
    )
    user = session.scalar(select(User).where(User.email == email))
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account is disabled")
    if user.email_verified_at is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Email verification required"
        )
    user.last_login_at = utcnow()
    result = _token_response(session, user, settings)
    record_audit(
        session,
        action="login",
        actor_user_id=user.id,
        resource_type="user",
        resource_id=user.id,
        client_ip=_client_ip(request),
    )
    session.commit()
    return result


@router.post("/refresh", response_model=LoginResponse)
def refresh(
    payload: RefreshRequest,
    request: Request,
    session: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> LoginResponse:
    _enforce(
        session,
        request,
        settings,
        scope="refresh",
        value=payload.refresh_token,
        limit=settings.auth_rate_limit_refresh,
    )
    try:
        user, rotated_token = rotate_refresh_token(session, payload.refresh_token, settings)
    except AuthTokenInvalid as exc:
        session.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token"
        ) from exc
    result = LoginResponse(
        access_token=issue_access_token(user, settings),
        refresh_token=rotated_token,
        expires_in=settings.auth_access_token_minutes * 60,
        user=serialize_user(user),
    )
    record_audit(
        session,
        action="refresh",
        actor_user_id=user.id,
        resource_type="user",
        resource_id=user.id,
        client_ip=_client_ip(request),
    )
    session.commit()
    return result


@router.post("/logout", response_model=ActionResponse)
def logout(
    request: Request,
    response: Response,
    payload: LogoutRequest | None = None,
    session: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ActionResponse:
    payload = payload or LogoutRequest()
    actor_id: str | None = None
    revoked_session = False
    access_user: User | None = None

    scheme, _, credentials = (request.headers.get("Authorization") or "").partition(" ")
    if scheme.lower() == "bearer" and credentials.strip():
        try:
            claims = decode_access_token(credentials.strip(), settings)
        except (AuthTokenInvalid, RuntimeError):
            claims = None
        if claims:
            access_user = session.get(User, str(claims["sub"]), with_for_update=True)
            # A stale or disabled session cannot revoke anything: otherwise a
            # leaked access token could lock the account out repeatedly.
            if access_user is not None and (
                not access_user.is_active or int(claims["ver"]) != access_user.token_version
            ):
                access_user = None

    if access_user is not None:
        # A Bearer logout is a full-session logout: it revokes every refresh
        # token and invalidates outstanding access tokens by bumping the
        # session version. A refresh-token-only logout revokes that session.
        actor_id = access_user.id
        access_user.token_version += 1
        revoke_refresh_tokens(session, access_user.id)
    elif payload.refresh_token:
        actor_id = revoke_refresh_token_family(session, payload.refresh_token)
        revoked_session = actor_id is not None

    record_audit(
        session,
        action="logout",
        actor_user_id=actor_id,
        resource_type="session",
        resource_id=None,
        client_ip=_client_ip(request),
        details={
            "scope": "all" if access_user is not None else ("single" if revoked_session else "none")
        },
    )
    session.commit()
    response.status_code = status.HTTP_200_OK
    return ActionResponse(message="Logged out")


@router.get("/me", response_model=MeResponse)
def me(user: User = Depends(get_authenticated_user)) -> MeResponse:
    return MeResponse(user=serialize_user(user))


@router.get("/users", response_model=list[UserRead])
def list_users(
    _: User = Depends(require_admin),
    session: Session = Depends(get_db),
) -> list[UserRead]:
    users = session.scalars(select(User).order_by(User.created_at, User.id))
    return [serialize_user(user) for user in users]


@router.patch("/users/{user_id}/role", response_model=UserRead)
def update_user_role(
    user_id: str,
    payload: UserRoleUpdate,
    request: Request,
    administrator: User = Depends(require_admin),
    session: Session = Depends(get_db),
) -> UserRead:
    target = session.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    previous_role = target.role
    try:
        change_user_role(session, target, UserRole(payload.role))
    except LastAdminError as exc:
        session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    if target.role != previous_role:
        record_audit(
            session,
            action="change_user_role",
            actor_user_id=administrator.id,
            resource_type="user",
            resource_id=target.id,
            client_ip=_client_ip(request),
            details={"old_role": previous_role, "new_role": target.role},
        )
    session.commit()
    session.refresh(target)
    return serialize_user(target)


@router.post("/verify-email/request", response_model=ActionResponse, status_code=202)
def request_email_verification(
    payload: EmailRequest,
    request: Request,
    session: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ActionResponse:
    email = normalize_email(str(payload.email))
    _enforce(
        session,
        request,
        settings,
        scope="verify",
        value=email,
        limit=settings.auth_rate_limit_verify,
        account_value=email,
    )
    user = session.scalar(select(User).where(User.email == email))
    token = None
    if user is not None and user.is_active and user.email_verified_at is None:
        token = create_action_token(
            session,
            user,
            "verify_email",
            timedelta(hours=settings.auth_verification_token_hours),
        )
    session.commit()
    if token:
        try:
            send_verification_email(settings, user.email, token)
        except EmailDeliveryError:
            # Keep the response non-enumerating. Operators receive a safe log
            # containing only the internal account identifier.
            logger.error("Verification email delivery failed for user_id=%s", user.id)
    response_data = {"message": "If the account exists, a verification message was queued"}
    if token:
        response_data.update(_dev_token(settings, token, "verification_token"))
    return ActionResponse(**response_data)


@router.post("/verify-email", response_model=VerifyEmailResponse)
def verify_email(
    payload: VerifyEmailRequest,
    request: Request,
    session: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> VerifyEmailResponse:
    _enforce(
        session,
        request,
        settings,
        scope="verify-token",
        value=payload.token,
        limit=settings.auth_rate_limit_verify,
    )
    user = consume_action_token(session, payload.token, "verify_email")
    if user is None:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired token"
        )
    user.email_verified_at = utcnow()
    record_audit(
        session,
        action="verify_email",
        actor_user_id=user.id,
        resource_type="user",
        resource_id=user.id,
        client_ip=_client_ip(request),
    )
    session.commit()
    return VerifyEmailResponse(message="Email verified", user=serialize_user(user))


@router.post("/reset-password", response_model=ActionResponse, status_code=202)
def request_password_reset(
    payload: EmailRequest,
    request: Request,
    session: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ActionResponse:
    email = normalize_email(str(payload.email))
    _enforce(
        session,
        request,
        settings,
        scope="reset",
        value=email,
        limit=settings.auth_rate_limit_reset,
        account_value=email,
    )
    user = session.scalar(select(User).where(User.email == email))
    token = None
    if user is not None and user.is_active:
        token = create_action_token(
            session,
            user,
            "reset_password",
            timedelta(minutes=settings.auth_reset_token_minutes),
        )
    session.commit()
    if token:
        try:
            send_password_reset_email(settings, user.email, token)
        except EmailDeliveryError:
            logger.error("Password reset email delivery failed for user_id=%s", user.id)
    response_data = {"message": "If the account exists, a reset message was queued"}
    if token:
        response_data.update(_dev_token(settings, token, "reset_token"))
    return ActionResponse(**response_data)


@router.post("/reset-password/confirm", response_model=ActionResponse)
def confirm_password_reset(
    payload: ResetPasswordConfirmRequest,
    request: Request,
    session: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ActionResponse:
    _enforce(
        session,
        request,
        settings,
        scope="reset-token",
        value=payload.token,
        limit=settings.auth_rate_limit_reset,
    )
    try:
        validate_password_strength(payload.password, settings.auth_password_min_length)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from exc
    user = consume_action_token(session, payload.token, "reset_password")
    if user is None:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired token"
        )
    user = session.get(User, user.id, with_for_update=True)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    user.password_hash = hash_password(payload.password)
    user.password_changed_at = utcnow()
    user.token_version += 1
    revoke_action_tokens(session, user.id, "reset_password")
    revoke_refresh_tokens(session, user.id)
    record_audit(
        session,
        action="reset_password",
        actor_user_id=user.id,
        resource_type="user",
        resource_id=user.id,
        client_ip=_client_ip(request),
    )
    session.commit()
    return ActionResponse(message="Password changed")


@router.post("/change-password", response_model=LoginResponse)
def change_password(
    payload: ChangePasswordRequest,
    request: Request,
    user: User = Depends(get_authenticated_user),
    session: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> LoginResponse:
    _enforce(
        session,
        request,
        settings,
        scope="change-password",
        value=user.id,
        limit=settings.auth_rate_limit_login,
        account_value=user.id,
    )
    # Lock the user before touching sessions so concurrent refresh rotation
    # cannot publish a token that escapes revocation.
    locked_user = session.get(User, user.id, with_for_update=True)
    if locked_user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    user = locked_user
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    try:
        validate_password_strength(payload.password, settings.auth_password_min_length)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from exc
    user.password_hash = hash_password(payload.password)
    user.password_changed_at = utcnow()
    user.token_version += 1
    revoke_action_tokens(session, user.id, "reset_password")
    revoke_refresh_tokens(session, user.id)
    result = _token_response(session, user, settings)
    record_audit(
        session,
        action="change_password",
        actor_user_id=user.id,
        resource_type="user",
        resource_id=user.id,
        client_ip=_client_ip(request),
    )
    session.commit()
    return result
