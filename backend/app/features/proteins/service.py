from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

from sqlalchemy import insert, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import Principal
from app.core.config import Settings
from app.features.proteins.models import Protein, ProteinIdentifier, ProteinProjectAccess
from app.features.proteins.schemas import ProteinAliasInput

AMINO_ACIDS = frozenset("ACDEFGHIKLMNPQRSTVWY")
FASTA_HEADER = re.compile(r"^>\s*(?P<header>.*)$")


class SequenceValidationError(ValueError):
    pass


class AliasConflictError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class NormalizedSequence:
    sequence: str
    sequence_sha256: str
    fasta_header: str | None


def normalize_sequence(raw: str, max_length: int = 100_000) -> NormalizedSequence:
    if not raw or not raw.strip():
        raise SequenceValidationError("sequence cannot be empty")

    lines = raw.splitlines()
    headers = [
        match.group("header").strip() for line in lines if (match := FASTA_HEADER.match(line))
    ]
    if len(headers) > 1:
        raise SequenceValidationError("multiple FASTA records are not supported")
    sequence_lines = [line.strip() for line in lines if not FASTA_HEADER.match(line)]
    sequence = re.sub(r"\s+", "", "".join(sequence_lines)).upper()
    if not sequence:
        raise SequenceValidationError("sequence cannot be empty")
    if len(sequence) > max_length:
        raise SequenceValidationError("sequence exceeds the configured maximum length")
    invalid = sorted(set(sequence) - AMINO_ACIDS)
    if invalid:
        raise SequenceValidationError(f"invalid amino-acid symbols: {', '.join(invalid)}")
    return NormalizedSequence(
        sequence=sequence,
        sequence_sha256=hashlib.sha256(sequence.encode("ascii")).hexdigest(),
        fasta_header=headers[0] if headers else None,
    )


def _serialize(protein: Protein) -> dict[str, object]:
    return {
        "id": protein.id,
        "sequence_sha256": protein.sequence_sha256,
        "sequence": protein.sequence,
        "length": protein.length,
        "aliases": [
            {"source": item.source, "identifier": item.identifier} for item in protein.identifiers
        ],
        "created_at": protein.created_at,
    }


def protein_accessible_to(session: Session, principal: Principal, protein: Protein) -> bool:
    """Return whether the principal owns, administers, or joined this Protein."""

    if principal.can_access(protein.owner_id, protein.project_id):
        return True
    return (
        session.scalar(
            select(ProteinProjectAccess.protein_id).where(
                ProteinProjectAccess.protein_id == protein.id,
                ProteinProjectAccess.project_id == principal.project_id,
            )
        )
        is not None
    )


def register_protein(
    session: Session,
    principal: Principal,
    raw_sequence: str,
    aliases: list[ProteinAliasInput],
    settings: Settings,
) -> tuple[Protein, bool]:
    normalized = normalize_sequence(raw_sequence, max_length=settings.max_sequence_length)
    protein = session.scalar(
        select(Protein).where(Protein.sequence_sha256 == normalized.sequence_sha256)
    )
    created = False
    if protein is None:
        protein = Protein(
            sequence_sha256=normalized.sequence_sha256,
            sequence=normalized.sequence,
            length=len(normalized.sequence),
            owner_id=principal.user_id,
            project_id=principal.project_id,
        )
        session.add(protein)
        try:
            session.flush()
        except IntegrityError:
            session.rollback()
            protein = session.scalar(
                select(Protein).where(Protein.sequence_sha256 == normalized.sequence_sha256)
            )
            if protein is None:
                raise
        else:
            created = True

    dialect = session.get_bind().dialect.name
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as dialect_insert

        access_statement = dialect_insert(ProteinProjectAccess)
    elif dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert as dialect_insert

        access_statement = dialect_insert(ProteinProjectAccess)
    else:
        access_statement = insert(ProteinProjectAccess)
    access_statement = access_statement.values(
        protein_id=protein.id,
        project_id=principal.project_id,
    )
    if dialect in {"postgresql", "sqlite"}:
        session.execute(
            access_statement.on_conflict_do_nothing(index_elements=["protein_id", "project_id"])
        )
    elif session.get(ProteinProjectAccess, (protein.id, principal.project_id)) is None:
        session.add(ProteinProjectAccess(protein_id=protein.id, project_id=principal.project_id))

    known_aliases = {(item.source, item.identifier) for item in protein.identifiers}
    candidate_aliases = list(aliases)
    if normalized.fasta_header:
        candidate_aliases.append(
            ProteinAliasInput(source="fasta_header", identifier=normalized.fasta_header)
        )
    for alias in candidate_aliases:
        if (alias.source, alias.identifier) not in known_aliases:
            protein.identifiers.append(
                ProteinIdentifier(source=alias.source, identifier=alias.identifier)
            )
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise AliasConflictError("alias is already attached to another protein") from exc
    session.refresh(protein)
    return protein, created


def serialize_protein(protein: Protein) -> dict[str, object]:
    return _serialize(protein)
