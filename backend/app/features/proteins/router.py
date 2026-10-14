from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.auth import Principal, get_principal
from app.core.config import Settings, get_settings
from app.core.db import get_db
from app.features.proteins.models import Protein
from app.features.proteins.schemas import ProteinCreate, ProteinCreateResponse
from app.features.proteins.service import (
    AliasConflictError,
    SequenceValidationError,
    register_protein,
    serialize_protein,
)

router = APIRouter(prefix="/proteins", tags=["proteins"])


@router.post("", response_model=ProteinCreateResponse)
def create_protein(
    payload: ProteinCreate,
    response: Response,
    session: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
    settings: Settings = Depends(get_settings),
) -> dict[str, object]:
    raw_sequence = payload.sequence or payload.fasta
    if raw_sequence is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="sequence or fasta is required",
        )
    try:
        protein, created = register_protein(
            session, principal, raw_sequence, payload.aliases, settings
        )
    except SequenceValidationError as exc:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from exc
    except PermissionError as exc:
        session.rollback()
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except AliasConflictError as exc:
        session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    return {**serialize_protein(protein), "created": created}


@router.get("/{protein_id}", response_model=ProteinCreateResponse)
def read_protein(
    protein_id: str,
    session: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
) -> dict[str, object]:
    protein = session.scalar(
        select(Protein).options(selectinload(Protein.identifiers)).where(Protein.id == protein_id)
    )
    if protein is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Protein not found")
    if not principal.can_access(protein.owner_id, protein.project_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Protein access denied")
    return {**serialize_protein(protein), "created": False}


@router.get("", response_model=list[ProteinCreateResponse])
def list_proteins(
    session: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
) -> list[dict[str, object]]:
    query = select(Protein).options(selectinload(Protein.identifiers))
    if not principal.is_admin:
        query = query.where(
            (Protein.owner_id == principal.user_id) | (Protein.project_id == principal.project_id)
        )
    proteins = session.scalars(query.order_by(Protein.created_at.desc()))
    return [{**serialize_protein(protein), "created": False} for protein in proteins]
