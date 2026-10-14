from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


class PasswordPayload(BaseModel):
    password: str = Field(min_length=12, max_length=128)

    @field_validator("password")
    @classmethod
    def reject_password_whitespace(cls, value: str) -> str:
        if value.strip() != value:
            raise ValueError("password must not start or end with whitespace")
        if len(value.encode("utf-8")) > 1024:
            raise ValueError("password is too large")
        return value


class RegisterRequest(PasswordPayload):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr


class LoginRequest(PasswordPayload):
    email: EmailStr


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=32, max_length=512)


class EmailRequest(BaseModel):
    email: EmailStr


class VerifyEmailRequest(BaseModel):
    token: str = Field(min_length=32, max_length=512)


class ResetPasswordConfirmRequest(PasswordPayload):
    token: str = Field(min_length=32, max_length=512)


class ChangePasswordRequest(PasswordPayload):
    current_password: str = Field(min_length=1, max_length=128)


class LogoutRequest(BaseModel):
    refresh_token: str | None = Field(default=None, min_length=32, max_length=512)


class UserRead(BaseModel):
    id: str
    email: EmailStr
    project_id: str
    role: Literal["admin", "user"]
    email_verified: bool
    is_active: bool
    created_at: datetime | None = None


class UserRoleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["admin", "user"]


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int


class LoginResponse(TokenResponse):
    user: UserRead


class ActionResponse(BaseModel):
    message: str
    verification_token: str | None = None
    reset_token: str | None = None


class VerifyEmailResponse(BaseModel):
    message: str
    user: UserRead


class MeResponse(BaseModel):
    user: UserRead
