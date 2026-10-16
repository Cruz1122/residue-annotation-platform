from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    PrimaryKeyConstraint,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base


def new_id() -> str:
    return str(uuid4())


class Protein(Base):
    __tablename__ = "proteins"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    sequence_sha256: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    sequence: Mapped[str] = mapped_column(Text)
    length: Mapped[int] = mapped_column(Integer)
    owner_id: Mapped[str] = mapped_column(String(128), index=True)
    project_id: Mapped[str] = mapped_column(String(128), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    identifiers: Mapped[list["ProteinIdentifier"]] = relationship(
        back_populates="protein", cascade="all, delete-orphan"
    )
    project_access: Mapped[list["ProteinProjectAccess"]] = relationship(
        back_populates="protein", cascade="all, delete-orphan"
    )


class ProteinProjectAccess(Base):
    """Projects that have registered and may use a shared Protein identity."""

    __tablename__ = "protein_project_access"
    __table_args__ = (
        PrimaryKeyConstraint("protein_id", "project_id", name="pk_protein_project_access"),
    )

    protein_id: Mapped[str] = mapped_column(ForeignKey("proteins.id", ondelete="CASCADE"))
    project_id: Mapped[str] = mapped_column(String(128), index=True)

    protein: Mapped[Protein] = relationship(back_populates="project_access")


class ProteinIdentifier(Base):
    __tablename__ = "protein_identifiers"
    __table_args__ = (UniqueConstraint("source", "identifier", name="uq_protein_identifier"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    protein_id: Mapped[str] = mapped_column(
        ForeignKey("proteins.id", ondelete="CASCADE"), index=True
    )
    source: Mapped[str] = mapped_column(String(64))
    identifier: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    protein: Mapped[Protein] = relationship(back_populates="identifiers")
