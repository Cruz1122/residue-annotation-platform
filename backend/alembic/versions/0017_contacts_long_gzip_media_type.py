"""Restore the gzip media type for compressed Arpeggio contact tables."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision = "0017_contacts_gzip_type"
down_revision: str | Sequence[str] | None = "0016_external_pub_cursor"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE artifacts "
            "SET media_type = 'application/gzip' "
            "WHERE artifact_type = 'contacts_long' "
            "AND lower(storage_key) LIKE '%/contacts_long.tsv.gz' "
            "AND media_type <> 'application/gzip'"
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE artifacts "
            "SET media_type = 'text/tab-separated-values' "
            "WHERE artifact_type = 'contacts_long' "
            "AND lower(storage_key) LIKE '%/contacts_long.tsv.gz' "
            "AND media_type = 'application/gzip'"
        )
    )
