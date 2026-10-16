"""Persist one remote Slurm job per scientific run.

Revision ID: 0010_run_remote_job
Revises: 0009_shared_proteins
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision = "0010_run_remote_job"
down_revision: str | None = "0009_shared_proteins"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("runs") as batch:
        batch.add_column(sa.Column("remote_job_id", sa.String(128), nullable=True))
        batch.add_column(sa.Column("remote_poll_claim_token", sa.String(36), nullable=True))
        batch.add_column(
            sa.Column("remote_poll_claim_expires_at", sa.DateTime(timezone=True), nullable=True)
        )
        batch.create_index("ix_runs_remote_job_id", ["remote_job_id"])


def downgrade() -> None:
    with op.batch_alter_table("runs") as batch:
        batch.drop_index("ix_runs_remote_job_id")
        batch.drop_column("remote_poll_claim_expires_at")
        batch.drop_column("remote_poll_claim_token")
        batch.drop_column("remote_job_id")
