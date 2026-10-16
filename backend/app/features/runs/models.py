from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base
from app.features.proteins.models import Protein


def new_id() -> str:
    return str(uuid4())


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    protein_id: Mapped[str] = mapped_column(
        ForeignKey("proteins.id", ondelete="RESTRICT"), index=True
    )
    status: Mapped[str] = mapped_column(String(32), index=True, default="pending")
    owner_id: Mapped[str] = mapped_column(String(128), index=True)
    project_id: Mapped[str] = mapped_column(String(128), index=True)
    requested_variants: Mapped[list[dict[str, object]]] = mapped_column(JSON, default=list)
    # One Slurm allocation owns the complete scientific orchestration for a
    # run.  RunStage.slurm_job_id remains populated for compatibility with the
    # stage API and historical rows, but new remote submissions are keyed here.
    remote_job_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    remote_poll_claim_token: Mapped[str | None] = mapped_column(String(36), nullable=True)
    remote_poll_claim_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    error_code: Mapped[str | None] = mapped_column(String(128), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    protein: Mapped[Protein] = relationship()
    stages: Mapped[list[RunStage]] = relationship(
        back_populates="run", cascade="all, delete-orphan", order_by="RunStage.created_at"
    )
    configuration: Mapped[RunConfiguration | None] = relationship(
        back_populates="run",
        uselist=False,
        cascade="all, delete-orphan",
    )
    uploads: Mapped[list[Upload]] = relationship(
        back_populates="run", cascade="all, delete-orphan", order_by="Upload.created_at"
    )
    preparation: Mapped[RunPreparation | None] = relationship(
        back_populates="run",
        uselist=False,
        cascade="all, delete-orphan",
    )


class Upload(Base):
    __tablename__ = "uploads"
    __table_args__ = (UniqueConstraint("run_id", "input_type", name="uq_run_upload_type"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str | None] = mapped_column(
        ForeignKey("runs.id", ondelete="CASCADE"), nullable=True, index=True
    )
    owner_id: Mapped[str] = mapped_column(String(128), index=True)
    project_id: Mapped[str] = mapped_column(String(128), index=True)
    input_type: Mapped[str] = mapped_column(String(32), index=True)
    original_filename: Mapped[str] = mapped_column(String(256))
    storage_key: Mapped[str] = mapped_column(String(1024), unique=True)
    sha256: Mapped[str] = mapped_column(String(64))
    size: Mapped[int] = mapped_column(Integer)
    media_type: Mapped[str] = mapped_column(String(256))
    transfer_status: Mapped[str] = mapped_column(String(32), default="pending")
    remote_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    transfer_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    transferred_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    run: Mapped[Run | None] = relationship(back_populates="uploads")


class ActiveRunSlot(Base):
    __tablename__ = "active_run_slots"

    owner_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("runs.id", ondelete="CASCADE"), unique=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class RunConfiguration(Base):
    """Immutable scientific intent confirmed for one run.

    This table is the authoritative snapshot used by selection, cache
    planning, execution, and read APIs.
    """

    __tablename__ = "run_configurations"
    __table_args__ = (UniqueConstraint("run_id", name="uq_run_configuration_run_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    protein_id: Mapped[str] = mapped_column(
        ForeignKey("proteins.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    sequence_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    scientific_accession: Mapped[str | None] = mapped_column(String(32), nullable=True)
    fasta_upload_id: Mapped[str | None] = mapped_column(
        ForeignKey("uploads.id", ondelete="SET NULL"), nullable=True
    )
    fasta_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    structure_upload_id: Mapped[str | None] = mapped_column(
        ForeignKey("uploads.id", ondelete="SET NULL"), nullable=True
    )
    structure_source: Mapped[str] = mapped_column(String(32), nullable=False)
    structure_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    structure_chain: Mapped[str | None] = mapped_column(String(8), nullable=True)
    structure_mapping: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    normalized_variants: Mapped[list[dict[str, object]]] = mapped_column(JSON, default=list)
    selected_stage_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    omitted_stages: Mapped[list[dict[str, object]]] = mapped_column(JSON, default=list)
    scientific_parameters: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    prerequisites: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    versions: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    input_references: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    owner_id: Mapped[str] = mapped_column(String(128), index=True)
    project_id: Mapped[str] = mapped_column(String(128), index=True)
    confirmation_audit_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    confirmed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    run: Mapped[Run] = relationship(back_populates="configuration")


class RunPreparation(Base):
    """Durable state for preflight and external-cache preparation.

    Scientific configuration remains immutable in ``RunConfiguration``. This
    separate record captures operational progress and can safely be retried
    after a worker restart without changing the user's confirmed intent.
    """

    __tablename__ = "run_preparations"
    __table_args__ = (UniqueConstraint("run_id", name="uq_run_preparation_run_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    required_requirements: Mapped[list[str]] = mapped_column(JSON, default=list)
    satisfied_requirements: Mapped[list[str]] = mapped_column(JSON, default=list)
    snapshots: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    preparation_key: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    attempt_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    error_code: Mapped[str | None] = mapped_column(String(128), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    run: Mapped[Run] = relationship(back_populates="preparation")


class RunIdempotencyKey(Base):
    """Binds a client retry key to exactly one confirmed run."""

    __tablename__ = "run_idempotency_keys"
    __table_args__ = (
        UniqueConstraint(
            "owner_id",
            "project_id",
            "idempotency_key",
            name="uq_run_idempotency_owner_project_key",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(String(128), index=True)
    project_id: Mapped[str] = mapped_column(String(128), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(255), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("runs.id", ondelete="CASCADE"), nullable=False, unique=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StageResult(Base):
    __tablename__ = "stage_results"
    __table_args__ = (
        UniqueConstraint(
            "protein_id",
            "stage_id",
            "cache_key",
            "project_id",
            name="uq_stage_result_cache",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    protein_id: Mapped[str] = mapped_column(
        ForeignKey("proteins.id", ondelete="RESTRICT"), index=True
    )
    stage_id: Mapped[str] = mapped_column(String(64), index=True)
    cache_key: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(32), index=True)
    provenance: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    owner_id: Mapped[str] = mapped_column(String(128), index=True)
    project_id: Mapped[str] = mapped_column(String(128), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    artifacts: Mapped[list[Artifact]] = relationship(
        back_populates="stage_result", cascade="all, delete-orphan"
    )


class RunStage(Base):
    __tablename__ = "run_stages"
    __table_args__ = (
        UniqueConstraint("run_id", "stage_id", name="uq_run_stage"),
        Index("ix_run_stages_status_lease", "status", "lease_expires_at"),
        Index(
            "ix_run_stages_remote_poll_claim",
            "status",
            "poll_claim_expires_at",
        ),
        Index(
            "ix_run_stages_preflight_retry",
            "preflight_status",
            "preflight_retry_at",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    stage_id: Mapped[str] = mapped_column(String(64), index=True)
    stage_result_id: Mapped[str | None] = mapped_column(
        ForeignKey("stage_results.id", ondelete="SET NULL"), nullable=True, index=True
    )
    status: Mapped[str] = mapped_column(String(32), index=True, default="pending")
    slurm_job_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    attempt_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    cache_key: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    cache_factors: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    reuse_reason: Mapped[dict[str, object] | None] = mapped_column(JSON, nullable=True)
    omission_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    poll_claim_token: Mapped[str | None] = mapped_column(String(36), nullable=True)
    poll_claim_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    error_code: Mapped[str | None] = mapped_column(String(128), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    preflight_status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="pending", server_default="pending"
    )
    preflight_error_code: Mapped[str | None] = mapped_column(String(128), nullable=True)
    preflight_error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    preflight_details: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    preflight_checked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    preflight_retry_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    run: Mapped[Run] = relationship(back_populates="stages")
    stage_result: Mapped[StageResult | None] = relationship()


class Artifact(Base):
    __tablename__ = "artifacts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    stage_result_id: Mapped[str] = mapped_column(
        ForeignKey("stage_results.id", ondelete="CASCADE"), index=True
    )
    artifact_type: Mapped[str] = mapped_column(String(64))
    storage_backend: Mapped[str] = mapped_column(String(32))
    storage_key: Mapped[str] = mapped_column(String(1024), unique=True)
    sha256: Mapped[str] = mapped_column(String(64))
    size: Mapped[int] = mapped_column(Integer)
    media_type: Mapped[str] = mapped_column(String(256), default="application/octet-stream")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    stage_result: Mapped[StageResult] = relationship(back_populates="artifacts")
