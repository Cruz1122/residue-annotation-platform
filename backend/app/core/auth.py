from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.db import get_db

if TYPE_CHECKING:
    from app.features.auth.models import User


@dataclass(frozen=True, slots=True)
class Principal:
    user_id: str
    project_id: str
    role: Literal["admin", "user"] = "user"

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    def can_access(self, owner_id: str, project_id: str) -> bool:
        return self.is_admin or owner_id == self.user_id or project_id == self.project_id


def _extract_bearer(authorization: str | None) -> str | None:
    if authorization is None:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return token.strip()


def _resolve_bearer_user(
    token: str,
    session: Session,
    settings: Settings,
) -> "User":
    from app.features.auth.models import User
    from app.features.auth.service import AuthTokenInvalid, decode_access_token

    try:
        claims = decode_access_token(token, settings)
    except (AuthTokenInvalid, RuntimeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired access token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    user = session.scalar(select(User).where(User.id == str(claims["sub"])))
    if user is None or not user.is_active or user.token_version != int(claims["ver"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired access token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


def get_authenticated_user(
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> "User":
    token = _extract_bearer(authorization)
    if token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Bearer access token is required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return _resolve_bearer_user(token, session, settings)


def require_admin(user: "User" = Depends(get_authenticated_user)) -> "User":
    if user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator access required",
        )
    return user


def get_principal(
    x_user_id: str | None = Header(default=None),
    x_project_id: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Principal:
    """Resolve ownership at the API boundary.

    Development/test use an explicit local principal so the application can run
    without an unapproved SSO integration. Production is fail-closed and needs
    both headers from the configured authentication gateway.
    """

    token = _extract_bearer(authorization)
    if token is not None:
        user = _resolve_bearer_user(token, session, settings)
        return Principal(user_id=user.id, project_id=user.project_id, role=user.role)

    trusted_headers = settings.auth_trusted_headers_enabled and settings.is_production
    development_fallback = settings.app_env in {"development", "test"}
    if development_fallback:
        user_id = x_user_id or settings.dev_user_id
        project_id = x_project_id or settings.dev_project_id
    elif trusted_headers:
        # A production gateway must inject both headers; never fall back to the
        # development principal when they are missing.
        user_id = x_user_id
        project_id = x_project_id
    else:
        user_id = None
        project_id = None
    if not user_id or not project_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Bearer access token is required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if len(user_id) > 128 or len(project_id) > 128:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid principal")
    # Trusted headers intentionally remain least-privileged. Administrator
    # authorization is available only to a persisted, authenticated account.
    return Principal(user_id=user_id, project_id=project_id, role="user")
