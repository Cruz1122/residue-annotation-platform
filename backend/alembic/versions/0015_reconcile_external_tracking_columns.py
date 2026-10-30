"""Reconcile the external tracking cache snapshot column."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision = "0015_external_tracking_cache"
down_revision: str | Sequence[str] | None = "0014_mn5_external_runs"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("external_run_tracking")}
    if "published_cache_keys" not in columns:
        op.add_column(
            "external_run_tracking",
            sa.Column(
                "published_cache_keys",
                sa.JSON(),
                nullable=False,
                server_default=sa.text("'{}'"),
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("external_run_tracking")}
    if "published_cache_keys" not in columns:
        return
    empty_object = (
        "published_cache_keys::jsonb <> '{}'::jsonb"
        if bind.dialect.name == "postgresql"
        else "published_cache_keys <> '{}'"
    )
    populated = bind.execute(
        sa.text(f"SELECT count(*) FROM external_run_tracking WHERE {empty_object}")
    ).scalar_one()
    if populated:
        raise RuntimeError("cannot remove populated external tracking cache snapshots")
    op.drop_column("external_run_tracking", "published_cache_keys")
