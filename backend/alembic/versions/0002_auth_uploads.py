"""Add account security, uploads and active-run slots.

Revision ID: 0002_auth_uploads
Revises: 0001_initial
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision = "0002_auth_uploads"
down_revision: str | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("project_id", sa.String(128), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("password_changed_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("token_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("email", name="uq_users_email"),
    )
    op.create_index("ix_users_email", "users", ["email"])
    op.create_index("ix_users_project_id", "users", ["project_id"])

    op.create_table(
        "refresh_tokens",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("replaced_by_id", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("token_hash", name="uq_refresh_tokens_hash"),
    )
    for name, column in (
        ("ix_refresh_tokens_user_id", "user_id"),
        ("ix_refresh_tokens_token_hash", "token_hash"),
        ("ix_refresh_tokens_expires_at", "expires_at"),
        ("ix_refresh_tokens_revoked_at", "revoked_at"),
    ):
        op.create_index(name, "refresh_tokens", [column])

    op.create_table(
        "auth_tokens",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("purpose", sa.String(32), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("token_hash", name="uq_auth_tokens_hash"),
    )
    for name, column in (
        ("ix_auth_tokens_user_id", "user_id"),
        ("ix_auth_tokens_purpose", "purpose"),
        ("ix_auth_tokens_token_hash", "token_hash"),
        ("ix_auth_tokens_expires_at", "expires_at"),
        ("ix_auth_tokens_consumed_at", "consumed_at"),
    ):
        op.create_index(name, "auth_tokens", [column])

    op.create_table(
        "rate_limit_buckets",
        sa.Column("key", sa.String(255), primary_key=True),
        sa.Column("window_started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "audit_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "actor_user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("resource_type", sa.String(64), nullable=False),
        sa.Column("resource_id", sa.String(128), nullable=True),
        sa.Column("client_ip", sa.String(64), nullable=True),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_audit_events_actor_user_id", "audit_events", ["actor_user_id"])
    op.create_index("ix_audit_events_action", "audit_events", ["action"])

    op.create_table(
        "uploads",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "run_id", sa.String(36), sa.ForeignKey("runs.id", ondelete="CASCADE"), nullable=True
        ),
        sa.Column("owner_id", sa.String(128), nullable=False),
        sa.Column("project_id", sa.String(128), nullable=False),
        sa.Column("input_type", sa.String(32), nullable=False),
        sa.Column("original_filename", sa.String(256), nullable=False),
        sa.Column("storage_key", sa.String(1024), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("media_type", sa.String(256), nullable=False),
        sa.Column("transfer_status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("remote_path", sa.String(1024), nullable=True),
        sa.Column("transfer_error", sa.Text(), nullable=True),
        sa.Column("transferred_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("storage_key", name="uq_uploads_storage_key"),
        sa.UniqueConstraint("run_id", "input_type", name="uq_run_upload_type"),
    )
    for name, column in (
        ("ix_uploads_run_id", "run_id"),
        ("ix_uploads_owner_id", "owner_id"),
        ("ix_uploads_project_id", "project_id"),
        ("ix_uploads_input_type", "input_type"),
    ):
        op.create_index(name, "uploads", [column])

    op.create_table(
        "active_run_slots",
        sa.Column("owner_id", sa.String(128), primary_key=True),
        sa.Column(
            "run_id", sa.String(36), sa.ForeignKey("runs.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("run_id", name="uq_active_run_slots_run_id"),
    )
    op.create_index("ix_active_run_slots_run_id", "active_run_slots", ["run_id"])


def downgrade() -> None:
    op.drop_index("ix_active_run_slots_run_id", table_name="active_run_slots")
    op.drop_table("active_run_slots")
    for name in (
        "ix_uploads_input_type",
        "ix_uploads_project_id",
        "ix_uploads_owner_id",
        "ix_uploads_run_id",
    ):
        op.drop_index(name, table_name="uploads")
    op.drop_table("uploads")
    op.drop_index("ix_audit_events_action", table_name="audit_events")
    op.drop_index("ix_audit_events_actor_user_id", table_name="audit_events")
    op.drop_table("audit_events")
    op.drop_table("rate_limit_buckets")
    for name in (
        "ix_auth_tokens_consumed_at",
        "ix_auth_tokens_expires_at",
        "ix_auth_tokens_token_hash",
        "ix_auth_tokens_purpose",
        "ix_auth_tokens_user_id",
    ):
        op.drop_index(name, table_name="auth_tokens")
    op.drop_table("auth_tokens")
    for name in (
        "ix_refresh_tokens_revoked_at",
        "ix_refresh_tokens_expires_at",
        "ix_refresh_tokens_token_hash",
        "ix_refresh_tokens_user_id",
    ):
        op.drop_index(name, table_name="refresh_tokens")
    op.drop_table("refresh_tokens")
    op.drop_index("ix_users_project_id", table_name="users")
    op.drop_index("ix_users_email", table_name="users")
    op.drop_table("users")
