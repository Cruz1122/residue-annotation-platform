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
    error_code: Mapped[str | None] = mapped_column(String(128), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    protein: Mapped[Protein] = relationship()
    stages: Mapped[list[RunStage]] = relationship(
        back_populates="run", cascade="all, delete-orphan", order_by="RunStage.created_at"
    )
    uploads: Mapped[list[Upload]] = relationship(
        back_populates="run", cascade="all, delete-orphan", order_by="Upload.created_at"
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


class StageResult(Base):
    __tablename__ = "stage_results"
    __table_args__ = (
        UniqueConstraint("protein_id", "stage_id", "cache_key", name="uq_stage_result_cache"),
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
    lease_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    poll_claim_token: Mapped[str | None] = mapped_column(String(36), nullable=True)
    poll_claim_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    error_code: Mapped[str | None] = mapped_column(String(128), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
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
