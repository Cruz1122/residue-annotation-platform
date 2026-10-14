"""Add stage result ownership indexes for model parity.

Revision ID: 0004_stage_result_indexes
Revises: 0003_worker_leases
"""

from collections.abc import Sequence

from alembic import op

revision = "0004_stage_result_indexes"
down_revision: str | None = "0003_worker_leases"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index("ix_stage_results_owner_id", "stage_results", ["owner_id"])
    op.create_index("ix_stage_results_project_id", "stage_results", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_stage_results_project_id", table_name="stage_results")
    op.drop_index("ix_stage_results_owner_id", table_name="stage_results")
