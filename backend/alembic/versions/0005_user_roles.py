"""Add explicit administrator and user roles.

Revision ID: 0005_user_roles
Revises: 0004_stage_result_indexes
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision = "0005_user_roles"
down_revision: str | None = "0004_stage_result_indexes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.add_column(
            sa.Column(
                "role",
                sa.String(16),
                nullable=False,
                server_default=sa.text("'user'"),
            )
        )
        batch_op.create_check_constraint("ck_users_role", "role IN ('admin', 'user')")
        batch_op.create_index("ix_users_role", ["role"])


def downgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_index("ix_users_role")
        batch_op.drop_constraint("ck_users_role", type_="check")
        batch_op.drop_column("role")
