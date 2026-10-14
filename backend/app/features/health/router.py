from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session
from starlette.responses import PlainTextResponse

from app.core.db import get_db
from app.core.observability import render_metrics

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    status: Literal["ok"]


@router.get("/health", response_model=HealthResponse)
def read_health() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get("/health/db", response_model=HealthResponse)
def read_database_health(session: Session = Depends(get_db)) -> HealthResponse:
    try:
        session.execute(text("SELECT 1"))
    except Exception as exc:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="database unavailable",
        ) from exc
    return HealthResponse(status="ok")


@router.get("/metrics", response_class=PlainTextResponse)
def read_metrics() -> PlainTextResponse:
    """Expose non-sensitive process counters for the deployment monitor."""

    return PlainTextResponse(render_metrics(), media_type="text/plain; version=0.0.4")
