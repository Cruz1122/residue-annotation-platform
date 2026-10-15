"""Persist preflight and external-cache preparation state.

Revision ID: 0008_run_preparation
Revises: 0007_run_configuration
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision = "0008_run_preparation"
down_revision: str | None = "0007_run_configuration"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "run_preparations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "run_id",
            sa.String(36),
            sa.ForeignKey("runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("required_requirements", sa.JSON(), nullable=False),
        sa.Column("satisfied_requirements", sa.JSON(), nullable=False),
        sa.Column("snapshots", sa.JSON(), nullable=False),
        sa.Column("preparation_key", sa.String(64), nullable=True),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error_code", sa.String(128), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("run_id", name="uq_run_preparation_run_id"),
    )
    op.create_index("ix_run_preparations_run_id", "run_preparations", ["run_id"])
    op.create_index(
        "ix_run_preparations_preparation_key",
        "run_preparations",
        ["preparation_key"],
    )

    with op.batch_alter_table("run_stages") as batch:
        batch.add_column(
            sa.Column("preflight_status", sa.String(32), nullable=False, server_default="pending")
        )
        batch.add_column(sa.Column("preflight_error_code", sa.String(128), nullable=True))
        batch.add_column(sa.Column("preflight_error_message", sa.Text(), nullable=True))
        batch.add_column(
            sa.Column("preflight_details", sa.JSON(), nullable=False, server_default="{}")
        )
        batch.add_column(
            sa.Column("preflight_checked_at", sa.DateTime(timezone=True), nullable=True)
        )
        batch.add_column(sa.Column("preflight_retry_at", sa.DateTime(timezone=True), nullable=True))
        batch.create_index(
            "ix_run_stages_preflight_retry", ["preflight_status", "preflight_retry_at"]
        )


def downgrade() -> None:
    with op.batch_alter_table("run_stages") as batch:
        batch.drop_index("ix_run_stages_preflight_retry")
        batch.drop_column("preflight_retry_at")
        batch.drop_column("preflight_checked_at")
        batch.drop_column("preflight_details")
        batch.drop_column("preflight_error_message")
        batch.drop_column("preflight_error_code")
        batch.drop_column("preflight_status")

    op.drop_index("ix_run_preparations_preparation_key", table_name="run_preparations")
    op.drop_index("ix_run_preparations_run_id", table_name="run_preparations")
    op.drop_table("run_preparations")
