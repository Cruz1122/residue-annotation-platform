"""Add the ClinVar annotation table to installations created before P21.

The initial migration builds annotation tables from the current registry. The
guard keeps a fresh installation (where 0001 already sees ClinVar) and an
existing 0010 installation (where it does not) on the same migration path.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision = "0011_clinvar_annotation"
down_revision: str | None = "0010_run_remote_job"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    if sa.inspect(bind).has_table("annotation_clinvar"):
        return
    op.create_table(
        "annotation_clinvar",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "stage_result_id",
            sa.String(36),
            sa.ForeignKey("stage_results.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("aa_position", sa.Integer(), nullable=False),
        sa.Column("aa_ref", sa.String(1), nullable=False),
        sa.Column("values", sa.JSON(), nullable=False),
        sa.Column("units", sa.JSON(), nullable=False),
        sa.Column("qc_status", sa.String(64), nullable=False),
        sa.Column("source_row", sa.Text(), nullable=True),
    )
    op.create_index(
        "ix_annotation_clinvar_stage_result_id",
        "annotation_clinvar",
        ["stage_result_id"],
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("annotation_clinvar"):
        return
    op.drop_index(
        "ix_annotation_clinvar_stage_result_id",
        table_name="annotation_clinvar",
    )
    op.drop_table("annotation_clinvar")
