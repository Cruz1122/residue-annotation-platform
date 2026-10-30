"""Add read-only tracking for external MN5 executions."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision = "0014_mn5_external_runs"
down_revision: str | Sequence[str] | None = "0013_import_invariants"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "runs",
        sa.Column("is_external_import", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_runs_is_external_import", "runs", ["is_external_import"])
    op.create_table(
        "external_run_tracking",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("remote_run_id", sa.String(length=256), nullable=False),
        sa.Column("remote_path", sa.String(length=1024), nullable=False),
        sa.Column("run_type", sa.String(length=16), nullable=False),
        sa.Column("base_protein_id", sa.String(length=36), nullable=False),
        sa.Column("accession", sa.String(length=32), nullable=False),
        sa.Column("variant", sa.String(length=16), nullable=True),
        sa.Column("display_name", sa.String(length=64), nullable=False),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "connection_status",
            sa.String(length=16),
            nullable=False,
            server_default="connected",
        ),
        sa.Column("sync_error_code", sa.String(length=64), nullable=True),
        sa.Column("next_sync_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("claim_token", sa.String(length=36), nullable=True),
        sa.Column("claim_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["base_protein_id"], ["proteins.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["run_id"], ["runs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_id", name="uq_external_run_tracking_run_id"),
        sa.UniqueConstraint("source", "remote_run_id", name="uq_external_run_tracking_remote"),
        sa.CheckConstraint("run_type IN ('ddg', 'mutant', 'base')", name="ck_external_run_type"),
        sa.CheckConstraint(
            "connection_status IN ('connected', 'unavailable')",
            name="ck_external_run_connection_status",
        ),
    )
    op.create_index("ix_external_run_tracking_run_id", "external_run_tracking", ["run_id"])
    op.create_index(
        "ix_external_run_tracking_base_protein_id",
        "external_run_tracking",
        ["base_protein_id"],
    )
    op.create_index("ix_external_run_tracking_accession", "external_run_tracking", ["accession"])
    op.create_index(
        "ix_external_run_tracking_next_sync_at",
        "external_run_tracking",
        ["next_sync_at"],
    )
    op.create_index(
        "ix_external_run_tracking_due",
        "external_run_tracking",
        ["next_sync_at", "claim_expires_at"],
    )


def downgrade() -> None:
    bind = op.get_bind()
    count = bind.execute(sa.text("SELECT count(*) FROM external_run_tracking")).scalar_one()
    if count:
        raise RuntimeError("cannot remove MN5 tracking while imported external runs exist")
    op.drop_index("ix_external_run_tracking_due", table_name="external_run_tracking")
    op.drop_index("ix_external_run_tracking_next_sync_at", table_name="external_run_tracking")
    op.drop_index("ix_external_run_tracking_accession", table_name="external_run_tracking")
    op.drop_index("ix_external_run_tracking_base_protein_id", table_name="external_run_tracking")
    op.drop_index("ix_external_run_tracking_run_id", table_name="external_run_tracking")
    op.drop_table("external_run_tracking")
    op.drop_index("ix_runs_is_external_import", table_name="runs")
    op.drop_column("runs", "is_external_import")
