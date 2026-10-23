"""Allow immutable artifacts to be attached directly to a run export."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision = "0012_run_artifacts"
down_revision: str | None = "0011_clinvar_annotation"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("artifacts") as batch:
        batch.alter_column("stage_result_id", existing_type=sa.String(36), nullable=True)
        batch.add_column(
            sa.Column(
                "run_id",
                sa.String(36),
                sa.ForeignKey(
                    "runs.id",
                    ondelete="CASCADE",
                    name="fk_artifacts_run_id_runs",
                ),
                nullable=True,
            )
        )
        batch.create_index("ix_artifacts_run_id", ["run_id"])


def downgrade() -> None:
    bind = op.get_bind()
    run_artifacts = bind.execute(
        sa.text("SELECT count(*) FROM artifacts WHERE run_id IS NOT NULL")
    ).scalar_one()
    if run_artifacts:
        raise RuntimeError(
            "cannot downgrade 0012_run_artifacts while run-level artifacts exist; "
            "export or remove them explicitly first"
        )
    with op.batch_alter_table("artifacts") as batch:
        batch.drop_index("ix_artifacts_run_id")
        batch.drop_column("run_id")
        batch.alter_column("stage_result_id", existing_type=sa.String(36), nullable=False)
