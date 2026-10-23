"""Align persisted invariants used by historical imports and exports.

This revision is intentionally explicit about the columns and constraints it
owns. It also fails closed if existing data cannot satisfy the new invariants.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision = "0013_import_invariants"
down_revision: str | Sequence[str] | None = "0012_run_artifacts"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NON_NULL_TIMESTAMP_COLUMNS = (
    ("active_run_slots", "created_at"),
    ("artifacts", "created_at"),
    ("audit_events", "created_at"),
    ("auth_tokens", "created_at"),
    ("protein_identifiers", "created_at"),
    ("proteins", "created_at"),
    ("proteins", "updated_at"),
    ("rate_limit_buckets", "updated_at"),
    ("refresh_tokens", "created_at"),
    ("run_configurations", "confirmed_at"),
    ("run_idempotency_keys", "created_at"),
    ("run_stages", "created_at"),
    ("runs", "created_at"),
    ("stage_results", "created_at"),
    ("uploads", "created_at"),
    ("users", "password_changed_at"),
    ("users", "created_at"),
    ("users", "updated_at"),
)


def _assert_safe_to_upgrade() -> None:
    bind = op.get_bind()
    duplicate_job = bind.execute(
        sa.text(
            """
            SELECT count(*)
            FROM (
                SELECT owner_id, project_id, remote_job_id
                FROM runs
                WHERE remote_job_id IS NOT NULL
                GROUP BY owner_id, project_id, remote_job_id
                HAVING count(*) > 1
            ) duplicates
            """
        )
    ).scalar_one()
    if duplicate_job:
        raise RuntimeError(
            "cannot add historical run identity: duplicate owner/project/remote_job_id rows exist"
        )
    invalid_artifacts = bind.execute(
        sa.text(
            """
            SELECT count(*)
            FROM artifacts
            WHERE (run_id IS NULL) = (stage_result_id IS NULL)
            """
        )
    ).scalar_one()
    if invalid_artifacts:
        raise RuntimeError(
            "cannot add artifact ownership invariant: an artifact must reference exactly one owner"
        )
    for table_name, column_name in NON_NULL_TIMESTAMP_COLUMNS:
        null_count = bind.execute(
            sa.text(f"SELECT count(*) FROM {table_name} WHERE {column_name} IS NULL")
        ).scalar_one()
        if null_count:
            raise RuntimeError(f"cannot make {table_name}.{column_name} NOT NULL")


def upgrade() -> None:
    _assert_safe_to_upgrade()
    with op.batch_alter_table("runs") as batch:
        batch.create_unique_constraint(
            "uq_runs_owner_project_remote_job",
            ["owner_id", "project_id", "remote_job_id"],
        )
    with op.batch_alter_table("artifacts") as batch:
        batch.create_check_constraint(
            "ck_artifact_exactly_one_owner",
            "(run_id IS NULL) <> (stage_result_id IS NULL)",
        )
    _alter_timestamp_nullability(nullable=False)


def downgrade() -> None:
    _alter_timestamp_nullability(nullable=True)
    with op.batch_alter_table("artifacts") as batch:
        batch.drop_constraint("ck_artifact_exactly_one_owner", type_="check")
    with op.batch_alter_table("runs") as batch:
        batch.drop_constraint("uq_runs_owner_project_remote_job", type_="unique")


def _alter_timestamp_nullability(*, nullable: bool) -> None:
    by_table: dict[str, list[str]] = {}
    for table_name, column_name in NON_NULL_TIMESTAMP_COLUMNS:
        by_table.setdefault(table_name, []).append(column_name)
    for table_name, column_names in by_table.items():
        with op.batch_alter_table(table_name) as batch:
            for column_name in column_names:
                batch.alter_column(
                    column_name,
                    existing_type=sa.DateTime(timezone=True),
                    nullable=nullable,
                )
