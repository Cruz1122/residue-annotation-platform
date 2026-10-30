"""Track fair rotation across pending external stage publications."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision = "0016_external_pub_cursor"
down_revision: str | Sequence[str] | None = "0015_external_tracking_cache"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("external_run_tracking")}
    if "publication_cursor" not in columns:
        op.add_column(
            "external_run_tracking",
            sa.Column("publication_cursor", sa.Integer(), nullable=False, server_default="0"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("external_run_tracking")}
    if "publication_cursor" in columns:
        op.drop_column("external_run_tracking", "publication_cursor")
