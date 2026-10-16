"""Allow projects to use globally deduplicated proteins independently.

Revision ID: 0009_shared_proteins
Revises: 0008_run_preparation
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision = "0009_shared_proteins"
down_revision: str | None = "0008_run_preparation"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "protein_project_access",
        sa.Column(
            "protein_id",
            sa.String(36),
            sa.ForeignKey("proteins.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("project_id", sa.String(128), nullable=False),
        sa.PrimaryKeyConstraint("protein_id", "project_id", name="pk_protein_project_access"),
    )
    op.create_index(
        "ix_protein_project_access_project_id", "protein_project_access", ["project_id"]
    )
    op.execute(
        sa.text(
            "INSERT INTO protein_project_access (protein_id, project_id) "
            "SELECT id, project_id FROM proteins"
        )
    )

    with op.batch_alter_table("stage_results") as batch:
        batch.drop_constraint("uq_stage_result_cache", type_="unique")
        batch.create_unique_constraint(
            "uq_stage_result_cache", ["protein_id", "stage_id", "cache_key", "project_id"]
        )


def downgrade() -> None:
    connection = op.get_bind()
    duplicate = connection.execute(
        sa.text(
            "SELECT protein_id, stage_id, cache_key FROM stage_results "
            "GROUP BY protein_id, stage_id, cache_key HAVING COUNT(*) > 1 LIMIT 1"
        )
    ).first()
    if duplicate is not None:
        raise RuntimeError(
            "Cannot downgrade shared protein results: project-scoped StageResult rows "
            "would violate the previous global cache uniqueness constraint."
        )

    with op.batch_alter_table("stage_results") as batch:
        batch.drop_constraint("uq_stage_result_cache", type_="unique")
        batch.create_unique_constraint(
            "uq_stage_result_cache", ["protein_id", "stage_id", "cache_key"]
        )

    op.drop_index("ix_protein_project_access_project_id", table_name="protein_project_access")
    op.drop_table("protein_project_access")
