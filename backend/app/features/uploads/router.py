from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import Principal, get_principal
from app.core.config import Settings, get_settings
from app.core.db import get_db
from app.features.artifacts.storage import ArtifactPathError, ArtifactStore
from app.features.runs.models import Upload
from app.features.runs.schemas import UploadRead
from app.features.uploads.service import UploadValidationError, write_upload

router = APIRouter(prefix="/uploads", tags=["uploads"])


def _serialize(upload: Upload) -> UploadRead:
    return UploadRead(
        id=upload.id,
        input_type=upload.input_type,
        original_filename=upload.original_filename,
        sha256=upload.sha256,
        size=upload.size,
        media_type=upload.media_type,
        transfer_status=upload.transfer_status,
    )


@router.post("", response_model=UploadRead, status_code=status.HTTP_201_CREATED)
async def create_upload(
    file: UploadFile = File(...),
    input_type: Literal["fasta", "structure"] = Form(...),
    session: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
    settings: Settings = Depends(get_settings),
) -> UploadRead:
    filename = Path(file.filename or "").name
    if not filename or filename in {".", ".."}:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="filename is required"
        )
    data = bytearray()
    while chunk := await file.read(min(1024 * 1024, settings.max_upload_bytes + 1)):
        data.extend(chunk)
        if len(data) > settings.max_upload_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail="upload exceeds the configured size limit",
            )
    try:
        storage_key, size, sha256 = write_upload(settings, bytes(data), filename, input_type)
    except UploadValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from exc
    upload = Upload(
        owner_id=principal.user_id,
        project_id=principal.project_id,
        input_type=input_type,
        original_filename=filename[:256],
        storage_key=storage_key,
        sha256=sha256,
        size=size,
        media_type=file.content_type or "application/octet-stream",
    )
    session.add(upload)
    try:
        session.commit()
    except Exception:
        session.rollback()
        try:
            (settings.artifact_root / storage_key).unlink(missing_ok=True)
        except OSError:
            pass
        raise
    session.refresh(upload)
    return _serialize(upload)


def _attachment_filename(filename: str) -> str:
    cleaned = Path(filename).name.replace('"', "").replace("\\", "")
    cleaned = "".join(char for char in cleaned if char.isprintable() and char not in "\r\n")
    return cleaned or "upload"


def _owned_upload(session: Session, upload_id: str, principal: Principal) -> Upload:
    query = select(Upload).where(Upload.id == upload_id)
    if not principal.is_admin:
        query = query.where(
            (Upload.owner_id == principal.user_id) | (Upload.project_id == principal.project_id)
        )
    upload = session.scalar(query)
    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found")
    return upload


@router.get("/{upload_id}", response_model=UploadRead)
def read_upload(
    upload_id: str,
    session: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
) -> UploadRead:
    return _serialize(_owned_upload(session, upload_id, principal))


@router.get("/{upload_id}/content")
def download_upload(
    upload_id: str,
    session: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    upload = _owned_upload(session, upload_id, principal)
    store = ArtifactStore(settings)
    try:
        path = store.resolve(upload.storage_key)
        stat = path.stat()
        if not path.is_file():
            raise FileNotFoundError(path)
    except (ArtifactPathError, FileNotFoundError, OSError) as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Upload content unavailable"
        ) from exc
    if stat.st_size != upload.size:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Upload content does not match its record",
        )
    filename = _attachment_filename(upload.original_filename)
    return StreamingResponse(
        store.iter_bytes(upload.storage_key),
        media_type=upload.media_type,
        headers={
            "Content-Length": str(upload.size),
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )
