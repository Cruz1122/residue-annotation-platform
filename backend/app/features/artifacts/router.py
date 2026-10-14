from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import Principal, get_principal
from app.core.config import Settings, get_settings
from app.core.db import get_db
from app.features.artifacts.storage import ArtifactPathError, ArtifactStore
from app.features.runs.models import Artifact, Run, RunStage, StageResult
from app.features.runs.schemas import ArtifactRead

router = APIRouter(prefix="/artifacts", tags=["artifacts"])


def _get_artifact(session: Session, artifact_id: str, principal: Principal) -> Artifact:
    query = (
        select(Artifact)
        .join(StageResult, Artifact.stage_result_id == StageResult.id)
        .join(RunStage, RunStage.stage_result_id == StageResult.id)
        .join(Run, Run.id == RunStage.run_id)
        .where(Artifact.id == artifact_id)
    )
    if not principal.is_admin:
        query = query.where(
            (Run.owner_id == principal.user_id) | (Run.project_id == principal.project_id)
        )
    artifact = session.scalar(query)
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
    return ArtifactRead(
        id=artifact.id,
        artifact_type=artifact.artifact_type,
        media_type=artifact.media_type,
        size=artifact.size,
        sha256=artifact.sha256,
        download_url=f"/api/v1/artifacts/{artifact.id}/content",
    )


@router.get("/{artifact_id}/content")
def download_artifact(
    artifact_id: str,
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
        actual_size, actual_sha256 = store.metadata(artifact.storage_key)
    except (ArtifactPathError, FileNotFoundError, OSError) as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Artifact content unavailable"
        ) from exc
    if actual_size != artifact.size or actual_sha256 != artifact.sha256:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Artifact content does not match its record",
        )
    return StreamingResponse(
        store.iter_bytes(artifact.storage_key),
        media_type=artifact.media_type,
        headers={
            "Content-Length": str(artifact.size),
            "Content-Disposition": f'attachment; filename="{artifact.artifact_type}"',
        },
    )
