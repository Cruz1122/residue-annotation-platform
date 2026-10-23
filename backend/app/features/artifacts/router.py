from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.responses import StreamingResponse
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.auth import Principal, get_principal
from app.core.config import Settings, get_settings
from app.core.db import get_db
from app.features.artifacts.presentation import (
    XLSX_MEDIA_TYPE,
    artifact_presentation,
    artifact_read_fields,
)
from app.features.artifacts.spreadsheet import SpreadsheetExportError, tabular_to_xlsx
from app.features.artifacts.storage import (
    ArtifactIntegrityError,
    ArtifactPathError,
    ArtifactStore,
)
from app.features.runs.models import Artifact, Run, RunStage, StageResult
from app.features.runs.schemas import ArtifactRead

router = APIRouter(prefix="/artifacts", tags=["artifacts"])


def _get_artifact(session: Session, artifact_id: str, principal: Principal) -> Artifact:
    query = (
        select(Artifact)
        .outerjoin(StageResult, Artifact.stage_result_id == StageResult.id)
        .outerjoin(RunStage, RunStage.stage_result_id == StageResult.id)
        .outerjoin(
            Run,
            or_(Run.id == RunStage.run_id, Run.id == Artifact.run_id),
        )
        .where(Artifact.id == artifact_id)
    )
    if not principal.is_admin:
        query = query.where(
            (Run.owner_id == principal.user_id) | (Run.project_id == principal.project_id)
        )
    artifact = session.scalars(query.distinct()).first()
    if artifact is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Artifact not found")
    return artifact


@router.get("/{artifact_id}", response_model=ArtifactRead)
def read_artifact(
    artifact_id: str,
    session: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
) -> ArtifactRead:
    artifact = _get_artifact(session, artifact_id, principal)
    return ArtifactRead(**artifact_read_fields(artifact))


@router.get("/{artifact_id}/content")
def download_artifact(
    artifact_id: str,
    format: str | None = Query(default=None, pattern="^(original|xlsx)$"),
    session: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    artifact = _get_artifact(session, artifact_id, principal)
    if artifact.storage_backend != "filesystem":
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Storage unavailable"
        )
    store = ArtifactStore(settings)
    try:
        stream = store.open_verified(
            artifact.storage_key,
            size=artifact.size,
            sha256=artifact.sha256,
        )
    except (ArtifactPathError, ArtifactIntegrityError, FileNotFoundError, OSError) as exc:
        raise HTTPException(
            status_code=(
                status.HTTP_409_CONFLICT
                if isinstance(exc, ArtifactIntegrityError)
                else status.HTTP_404_NOT_FOUND
            ),
            detail=(
                "Artifact content does not match its record"
                if isinstance(exc, ArtifactIntegrityError)
                else "Artifact content unavailable"
            ),
        ) from exc
    presentation = artifact_presentation(
        artifact.artifact_type, artifact.media_type, artifact.storage_key
    )
    requested_format = format or presentation.download_format
    if requested_format == "xlsx" and presentation.download_format != "xlsx":
        stream.close()
        raise HTTPException(
            status_code=status.HTTP_406_NOT_ACCEPTABLE,
            detail="Este artefacto debe descargarse en su formato científico original",
        )
    if requested_format == "xlsx":
        try:
            source = stream.read()
            stream.close()
            exported = tabular_to_xlsx(source, artifact.media_type)
        except SpreadsheetExportError as exc:
            stream.close()
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="No se pudo preparar la tabla para Excel",
            ) from exc
        return Response(
            content=exported,
            media_type=XLSX_MEDIA_TYPE,
            headers={
                "Content-Length": str(len(exported)),
                "Content-Disposition": f'attachment; filename="{presentation.download_filename}"',
            },
        )
    return StreamingResponse(
        store.iter_open(stream),
        media_type=artifact.media_type,
        headers={
            "Content-Length": str(artifact.size),
            "Content-Disposition": f'attachment; filename="{presentation.download_filename}"',
        },
    )
