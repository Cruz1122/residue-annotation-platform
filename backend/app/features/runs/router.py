import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, sessionmaker

from app.core.auth import Principal, get_principal
from app.core.config import Settings, get_settings
from app.core.db import get_db
from app.features.runs.models import Run, RunStage, StageResult
from app.features.runs.schemas import AnnotationsResponse, RunCreate, RunRead, StageRead
from app.features.runs.service import (
    create_run,
    get_active_run,
    get_owned_run,
    request_cancel,
    serialize_run,
)

router = APIRouter(prefix="/runs", tags=["runs"])


@router.post("", response_model=RunRead, status_code=status.HTTP_201_CREATED)
def create_run_endpoint(
    payload: RunCreate,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    session: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
    settings: Settings = Depends(get_settings),
) -> RunRead:
    client_ip = request.client.host if request.client else None
    return serialize_run(
        create_run(
            session,
            payload,
            principal,
            client_ip=client_ip,
            idempotency_key=idempotency_key,
            settings=settings,
        )
    )


@router.get("", response_model=list[RunRead])
def list_runs(
    limit: int = Query(default=50, ge=1, le=200),
    session: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
) -> list[RunRead]:
    """Return the owner's run history without collapsing shared proteins."""

    from sqlalchemy import select
    from sqlalchemy.orm import selectinload

    runs = session.scalars(
        select(Run)
        .options(
            selectinload(Run.configuration),
            selectinload(Run.preparation),
            selectinload(Run.stages)
            .selectinload(RunStage.stage_result)
            .selectinload(StageResult.artifacts),
            selectinload(Run.uploads),
        )
        .where((Run.owner_id == principal.user_id) | (Run.project_id == principal.project_id))
        .order_by(Run.created_at.desc())
        .limit(limit)
    )
    return [serialize_run(run) for run in runs]


@router.get("/active", response_model=RunRead)
def read_active_run(
    session: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
) -> RunRead:
    return serialize_run(get_active_run(session, principal))


@router.get("/{run_id}", response_model=RunRead)
def read_run(
    run_id: str,
    session: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
) -> RunRead:
    return serialize_run(get_owned_run(session, run_id, principal))


@router.get("/{run_id}/stages", response_model=list[StageRead])
def read_run_stages(
    run_id: str,
    session: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
) -> list[StageRead]:
    return serialize_run(get_owned_run(session, run_id, principal)).stages


@router.post("/{run_id}/cancel", response_model=RunRead)
def cancel_run(
    run_id: str,
    request: Request,
    session: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
) -> RunRead:
    run = get_owned_run(session, run_id, principal)
    client_ip = request.client.host if request.client else None
    return serialize_run(
        request_cancel(
            session,
            run,
            actor_user_id=principal.user_id,
            client_ip=client_ip,
        )
    )


@router.get("/{run_id}/events")
async def run_events(
    run_id: str,
    principal: Principal = Depends(get_principal),
    session: Session = Depends(get_db),
) -> StreamingResponse:
    # Events are a transport for persisted state, not a second source of truth.
    initial_run = get_owned_run(session, run_id, principal)
    initial_payload = serialize_run(initial_run).model_dump(mode="json")
    # The dependency owns this session, but the stream below deliberately opens
    # short-lived sessions for every refresh so a long-lived SSE connection does
    # not pin one database connection while waiting for a state change. Derive
    # the factory from the injected session's bind so test/runtime overrides
    # and non-default database engines keep the same persistence boundary.
    refresh_session_factory = sessionmaker(
        bind=session.get_bind(),
        autoflush=False,
        expire_on_commit=False,
    )
    session.close()

    async def stream() -> AsyncIterator[str]:
        event_id = 0
        last_payload: str | None = None
        payload = initial_payload
        while True:
            encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            if encoded != last_payload:
                event_id += 1
                last_payload = encoded
                yield f"id: {event_id}\nevent: snapshot\ndata: {encoded}\n\n"
            if payload["status"] in {"success", "failed", "cancelled"}:
                return
            yield ": heartbeat\n\n"
            await asyncio.sleep(2)
            with refresh_session_factory() as refresh_session:
                try:
                    run = get_owned_run(refresh_session, run_id, principal)
                except HTTPException:
                    return
                payload = serialize_run(run).model_dump(mode="json")

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/{run_id}/annotations", response_model=AnnotationsResponse)
def read_annotations(
    run_id: str,
    limit: int | None = Query(default=None, ge=1, le=50_000),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
    settings: Settings = Depends(get_settings),
) -> AnnotationsResponse:
    from app.features.annotations.service import annotations_for_run

    run = get_owned_run(session, run_id, principal)
    effective_limit = limit if limit is not None else settings.annotations_default_limit
    return annotations_for_run(session, run, limit=effective_limit, offset=offset)
