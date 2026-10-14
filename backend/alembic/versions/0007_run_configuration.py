"""Persist confirmed run configuration and retry identity.

Revision ID: 0007_run_configuration
Revises: 0006_remote_poll_claims
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision = "0007_run_configuration"
down_revision: str | None = "0006_remote_poll_claims"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "run_configurations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "run_id",
            sa.String(36),
            sa.ForeignKey("runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "protein_id",
            sa.String(36),
            sa.ForeignKey("proteins.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("sequence_sha256", sa.String(64), nullable=False),
        sa.Column("scientific_accession", sa.String(32), nullable=True),
        sa.Column(
            "fasta_upload_id",
            sa.String(36),
            sa.ForeignKey("uploads.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("fasta_sha256", sa.String(64), nullable=True),
        sa.Column(
            "structure_upload_id",
            sa.String(36),
            sa.ForeignKey("uploads.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("structure_source", sa.String(32), nullable=False),
        sa.Column("structure_sha256", sa.String(64), nullable=True),
        sa.Column("structure_chain", sa.String(8), nullable=True),
        sa.Column("structure_mapping", sa.JSON(), nullable=False),
        sa.Column("normalized_variants", sa.JSON(), nullable=False),
        sa.Column("selected_stage_ids", sa.JSON(), nullable=False),
        sa.Column("omitted_stages", sa.JSON(), nullable=False),
        sa.Column("scientific_parameters", sa.JSON(), nullable=False),
        sa.Column("prerequisites", sa.JSON(), nullable=False),
        sa.Column("versions", sa.JSON(), nullable=False),
        sa.Column("input_references", sa.JSON(), nullable=False),
        sa.Column("owner_id", sa.String(128), nullable=False),
        sa.Column("project_id", sa.String(128), nullable=False),
        sa.Column("confirmation_audit_id", sa.String(36), nullable=True),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("run_id", name="uq_run_configuration_run_id"),
    )
    for name, column in (
        ("ix_run_configurations_run_id", "run_id"),
        ("ix_run_configurations_protein_id", "protein_id"),
        ("ix_run_configurations_owner_id", "owner_id"),
        ("ix_run_configurations_project_id", "project_id"),
    ):
        op.create_index(name, "run_configurations", [column])

    op.create_table(
        "run_idempotency_keys",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(128), nullable=False),
        sa.Column("project_id", sa.String(128), nullable=False),
        sa.Column("idempotency_key", sa.String(255), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column(
            "run_id",
            sa.String(36),
            sa.ForeignKey("runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint(
            "owner_id",
            "project_id",
            "idempotency_key",
            name="uq_run_idempotency_owner_project_key",
        ),
        sa.UniqueConstraint("run_id", name="uq_run_idempotency_run_id"),
    )
    for name, column in (
        ("ix_run_idempotency_keys_owner_id", "owner_id"),
        ("ix_run_idempotency_keys_project_id", "project_id"),
        ("ix_run_idempotency_keys_run_id", "run_id"),
    ):
        op.create_index(name, "run_idempotency_keys", [column])

    with op.batch_alter_table("run_stages") as batch:
        batch.add_column(sa.Column("cache_key", sa.String(64), nullable=True))
        batch.add_column(sa.Column("cache_factors", sa.JSON(), nullable=False, server_default="{}"))
        batch.add_column(sa.Column("reuse_reason", sa.JSON(), nullable=True))
        batch.add_column(sa.Column("omission_reason", sa.String(255), nullable=True))
        batch.create_index("ix_run_stages_cache_key", ["cache_key"])


def downgrade() -> None:
    with op.batch_alter_table("run_stages") as batch:
        batch.drop_index("ix_run_stages_cache_key")
        batch.drop_column("omission_reason")
        batch.drop_column("reuse_reason")
        batch.drop_column("cache_factors")
        batch.drop_column("cache_key")

    for name in (
        "ix_run_idempotency_keys_run_id",
        "ix_run_idempotency_keys_project_id",
        "ix_run_idempotency_keys_owner_id",
    ):
        op.drop_index(name, table_name="run_idempotency_keys")
    op.drop_table("run_idempotency_keys")

    for name in (
        "ix_run_configurations_project_id",
        "ix_run_configurations_owner_id",
        "ix_run_configurations_protein_id",
        "ix_run_configurations_run_id",
    ):
        op.drop_index(name, table_name="run_configurations")
    op.drop_table("run_configurations")
