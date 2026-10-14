"""Add exclusive, expiring claims for remote stage polling.

Revision ID: 0006_remote_poll_claims
Revises: 0005_user_roles
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision = "0006_remote_poll_claims"
down_revision: str | None = "0005_user_roles"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("run_stages") as batch:
        batch.add_column(sa.Column("poll_claim_token", sa.String(36), nullable=True))
        batch.add_column(
            sa.Column("poll_claim_expires_at", sa.DateTime(timezone=True), nullable=True)
        )
        batch.create_index(
            "ix_run_stages_remote_poll_claim",
            ["status", "poll_claim_expires_at"],
        )


def downgrade() -> None:
    with op.batch_alter_table("run_stages") as batch:
        batch.drop_index("ix_run_stages_remote_poll_claim")
        batch.drop_column("poll_claim_expires_at")
        batch.drop_column("poll_claim_token")
