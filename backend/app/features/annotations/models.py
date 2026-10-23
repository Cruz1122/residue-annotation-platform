from sqlalchemy import JSON, Column, ForeignKey, Integer, String, Table, Text

from app.core.db import Base
from app.features.stages.registry import STAGE_DEFINITIONS

# Scientific stages have different columns. Keeping one physical table per
# stage avoids an EAV table and lets adapters validate each stage independently.
ANNOTATION_TABLES: dict[str, Table] = {}
for definition in STAGE_DEFINITIONS:
    ANNOTATION_TABLES[definition.id] = Table(
        f"annotation_{definition.id}",
        Base.metadata,
        Column("id", String(36), primary_key=True),
        Column(
            "stage_result_id",
            String(36),
            ForeignKey("stage_results.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        Column("aa_position", Integer, nullable=False),
        Column("aa_ref", String(1), nullable=False),
        Column("values", JSON, nullable=False),
        Column("units", JSON, nullable=False, default=dict),
        Column("qc_status", String(64), nullable=False, default="unverified"),
        Column("source_row", Text, nullable=True),
        extend_existing=True,
    )
