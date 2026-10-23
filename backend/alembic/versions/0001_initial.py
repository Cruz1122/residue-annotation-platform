"""Create protein, run, artifact and stage annotation tables.

Revision ID: 0001_initial
Revises:
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision = "0001_initial"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# This is deliberately frozen. Alembic revisions must describe the schema at
# their own point in history, not whatever the live stage registry contains
# years later. ClinVar was added by 0011_clinvar_annotation.
INITIAL_ANNOTATION_STAGE_IDS = (
    "protein_identity",
    "variant_predictors",
    "pharmacogenomics",
    "uniprot_features",
    "conformational_ensemble",
    "sequence_frustration",
    "evolutionary_conservation",
    "functional_region_evidence",
    "experimental_variant_evidence",
    "membrane_topology",
    "ensemble_frustration",
    "structure_modeling",
    "structural_regime",
    "protein_relaxation_energy",
    "physicochemical_context",
    "variant_ddg",
    "structural_frustration",
    "structural_contacts",
)


def upgrade() -> None:
    op.create_table(
        "proteins",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("sequence_sha256", sa.String(64), nullable=False),
        sa.Column("sequence", sa.Text(), nullable=False),
        sa.Column("length", sa.Integer(), nullable=False),
        sa.Column("owner_id", sa.String(128), nullable=False),
        sa.Column("project_id", sa.String(128), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("sequence_sha256", name="uq_proteins_sequence_sha256"),
    )
    op.create_index("ix_proteins_sequence_sha256", "proteins", ["sequence_sha256"])
    op.create_index("ix_proteins_owner_id", "proteins", ["owner_id"])
    op.create_index("ix_proteins_project_id", "proteins", ["project_id"])

    op.create_table(
        "protein_identifiers",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "protein_id",
            sa.String(36),
            sa.ForeignKey("proteins.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source", sa.String(64), nullable=False),
        sa.Column("identifier", sa.String(256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("source", "identifier", name="uq_protein_identifier"),
    )
    op.create_index("ix_protein_identifiers_protein_id", "protein_identifiers", ["protein_id"])

    op.create_table(
        "runs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "protein_id",
            sa.String(36),
            sa.ForeignKey("proteins.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("owner_id", sa.String(128), nullable=False),
        sa.Column("project_id", sa.String(128), nullable=False),
        sa.Column("requested_variants", sa.JSON(), nullable=False),
        sa.Column("error_code", sa.String(128), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_runs_protein_id", "runs", ["protein_id"])
    op.create_index("ix_runs_status", "runs", ["status"])
    op.create_index("ix_runs_owner_id", "runs", ["owner_id"])
    op.create_index("ix_runs_project_id", "runs", ["project_id"])

    op.create_table(
        "stage_results",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "protein_id",
            sa.String(36),
            sa.ForeignKey("proteins.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("stage_id", sa.String(64), nullable=False),
        sa.Column("cache_key", sa.String(64), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("provenance", sa.JSON(), nullable=False),
        sa.Column("owner_id", sa.String(128), nullable=False),
        sa.Column("project_id", sa.String(128), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("protein_id", "stage_id", "cache_key", name="uq_stage_result_cache"),
    )
    op.create_index("ix_stage_results_protein_id", "stage_results", ["protein_id"])
    op.create_index("ix_stage_results_stage_id", "stage_results", ["stage_id"])
    op.create_index("ix_stage_results_cache_key", "stage_results", ["cache_key"])
    op.create_index("ix_stage_results_status", "stage_results", ["status"])

    op.create_table(
        "run_stages",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "run_id", sa.String(36), sa.ForeignKey("runs.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("stage_id", sa.String(64), nullable=False),
        sa.Column(
            "stage_result_id",
            sa.String(36),
            sa.ForeignKey("stage_results.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("slurm_job_id", sa.String(128), nullable=True),
        sa.Column("error_code", sa.String(128), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("run_id", "stage_id", name="uq_run_stage"),
    )
    op.create_index("ix_run_stages_run_id", "run_stages", ["run_id"])
    op.create_index("ix_run_stages_stage_id", "run_stages", ["stage_id"])
    op.create_index("ix_run_stages_stage_result_id", "run_stages", ["stage_result_id"])
    op.create_index("ix_run_stages_status", "run_stages", ["status"])

    op.create_table(
        "artifacts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "stage_result_id",
            sa.String(36),
            sa.ForeignKey("stage_results.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("artifact_type", sa.String(64), nullable=False),
        sa.Column("storage_backend", sa.String(32), nullable=False),
        sa.Column("storage_key", sa.String(1024), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("media_type", sa.String(256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("storage_key", name="uq_artifact_storage_key"),
    )
    op.create_index("ix_artifacts_stage_result_id", "artifacts", ["stage_result_id"])

    for stage_id in INITIAL_ANNOTATION_STAGE_IDS:
        table_name = f"annotation_{stage_id}"
        op.create_table(
            table_name,
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
        op.create_index(f"ix_{table_name}_stage_result_id", table_name, ["stage_result_id"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for stage_id in reversed(INITIAL_ANNOTATION_STAGE_IDS):
        table_name = f"annotation_{stage_id}"
        if inspector.has_table(table_name):
            op.drop_index(f"ix_{table_name}_stage_result_id", table_name=table_name)
            op.drop_table(table_name)
    op.drop_index("ix_artifacts_stage_result_id", table_name="artifacts")
    op.drop_table("artifacts")
    for index_name in (
        "ix_run_stages_status",
        "ix_run_stages_stage_result_id",
        "ix_run_stages_stage_id",
        "ix_run_stages_run_id",
    ):
        op.drop_index(index_name, table_name="run_stages")
    op.drop_table("run_stages")
    for index_name in (
        "ix_stage_results_status",
        "ix_stage_results_cache_key",
        "ix_stage_results_stage_id",
        "ix_stage_results_protein_id",
    ):
        op.drop_index(index_name, table_name="stage_results")
    op.drop_table("stage_results")
    for index_name in (
        "ix_runs_project_id",
        "ix_runs_owner_id",
        "ix_runs_status",
        "ix_runs_protein_id",
    ):
        op.drop_index(index_name, table_name="runs")
    op.drop_table("runs")
    op.drop_index("ix_protein_identifiers_protein_id", table_name="protein_identifiers")
    op.drop_table("protein_identifiers")
    for index_name in (
        "ix_proteins_project_id",
        "ix_proteins_owner_id",
        "ix_proteins_sequence_sha256",
    ):
        op.drop_index(index_name, table_name="proteins")
    op.drop_table("proteins")
