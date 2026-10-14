"""Add worker leases and retry accounting to run stages.

Revision ID: 0003_worker_leases
Revises: 0002_auth_uploads
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision = "0003_worker_leases"
down_revision: str | None = "0002_auth_uploads"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("run_stages") as batch:
        batch.add_column(
            sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0")
        )
        batch.add_column(sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True))
        batch.create_index("ix_run_stages_status_lease", ["status", "lease_expires_at"])


def downgrade() -> None:
    with op.batch_alter_table("run_stages") as batch:
        batch.drop_index("ix_run_stages_status_lease")
        batch.drop_column("lease_expires_at")
        batch.drop_column("attempt_count")
