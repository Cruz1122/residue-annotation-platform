from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration shared by the web process and the worker."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    app_name: str = "residue-annotation-platform"
    app_env: Literal["development", "test", "staging", "production"] = "development"
    cors_origins: str = "http://localhost:4742"
    database_url: str = "sqlite:///./data/residue_annotation.db"
    database_auto_create: bool = False
    artifact_root: Path = Path("./data/artifacts")
    max_sequence_length: int = Field(default=100_000, ge=1)
    max_upload_bytes: int = Field(default=5 * 1024 * 1024, ge=1)
    dev_user_id: str = "local-user"
    dev_project_id: str = "local-project"
    auth_jwt_secret: str = "development-only-change-this-secret-before-production"
    auth_access_token_minutes: int = Field(default=15, ge=5, le=60)
    auth_refresh_token_days: int = Field(default=30, ge=1, le=90)
    auth_verification_token_hours: int = Field(default=24, ge=1, le=168)
    auth_reset_token_minutes: int = Field(default=30, ge=5, le=120)
    auth_password_min_length: int = Field(default=12, ge=12, le=128)
    auth_trusted_headers_enabled: bool = False
    auth_rate_limit_window_seconds: int = Field(default=900, ge=60, le=86_400)
    auth_rate_limit_register: int = Field(default=5, ge=1, le=100)
    auth_rate_limit_login: int = Field(default=10, ge=1, le=100)
    auth_rate_limit_refresh: int = Field(default=20, ge=1, le=200)
    auth_rate_limit_reset: int = Field(default=5, ge=1, le=100)
    auth_rate_limit_verify: int = Field(default=10, ge=1, le=100)
    auth_rate_limit_ip: int = Field(default=50, ge=1, le=10_000)
    email_provider: Literal["disabled", "resend"] = "disabled"
    resend_api_key: str | None = None
    email_from: str = "Residue Annotation <onboarding@resend.dev>"
    frontend_base_url: str = "http://localhost:4742"
    worker_poll_interval_seconds: float = Field(default=2.0, gt=0)
    worker_id: str = "local-worker"
    run_worker_lease_seconds: int = Field(default=900, ge=30, le=86_400)
    run_worker_max_attempts: int = Field(default=3, ge=1, le=10)
    annotations_default_limit: int = Field(default=20_000, ge=1)

    hpc_execution_mode: Literal["disabled", "mock", "ssh", "native"] = "disabled"
    hpc_ssh_host: str | None = None
    hpc_ssh_port: int = Field(default=22, ge=1, le=65535)
    hpc_ssh_username: str | None = None
    hpc_ssh_password_file: Path | None = None
    hpc_known_hosts_file: Path | None = None
    hpc_remote_root: str = "/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion"
    hpc_remote_workdir: str | None = None
    hpc_command_timeout_seconds: float = Field(default=30.0, gt=0)
    hpc_input_transfer_enabled: bool = False
    hpc_input_remote_subdir: str = "uploads"
    hpc_slurm_account: str | None = None
    hpc_slurm_partition: str | None = None
    hpc_slurm_qos: str | None = None
    hpc_slurm_time: str = "00:30:00"
    hpc_pipeline_python: str = "python"
    hpc_pipeline_main: str = "main.py"
    hpc_pipeline_max_parallel: int = Field(default=1, ge=1, le=64)
    hpc_pipeline_cpu_budget: int = Field(default=1, ge=1, le=256)
    hpc_max_result_bytes: int = Field(default=256 * 1024 * 1024, ge=1)
    hpc_max_inflight_stages: int = Field(default=1, ge=1, le=64)

    mn5_inspection_mode: Literal["disabled", "mock", "ssh_sftp", "native"] = "disabled"
    mn5_inspection_enabled: bool = False
    mn5_root: str = "/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion"
    mn5_max_preview_bytes: int = Field(default=64_000, ge=1)

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @model_validator(mode="after")
    def validate_email_delivery(self) -> "Settings":
        if self.is_production and self.email_provider != "resend":
            raise ValueError("EMAIL_PROVIDER=resend is required in production")
        if self.email_provider == "resend" and not self.resend_api_key:
            raise ValueError("RESEND_API_KEY is required when EMAIL_PROVIDER=resend")
        if (
            self.is_production
            and self.email_provider == "resend"
            and "@resend.dev" in self.email_from
        ):
            raise ValueError("EMAIL_FROM must use a verified sending domain in production")
        if not self.frontend_base_url.startswith(("http://", "https://")):
            raise ValueError("FRONTEND_BASE_URL must be an absolute HTTP(S) URL")
        if self.is_production and not self.frontend_base_url.startswith("https://"):
            raise ValueError("FRONTEND_BASE_URL must use HTTPS in production")
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
