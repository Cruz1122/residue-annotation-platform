import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from app.core.config import get_settings
from app.core.db import create_all_tables
from app.features.artifacts.router import router as artifacts_router
from app.features.auth.router import router as auth_router
from app.features.health.router import router as health_router
from app.features.proteins.router import router as proteins_router
from app.features.runs.router import router as runs_router
from app.features.stages.router import router as stages_router
from app.features.uploads.router import router as uploads_router

settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.database_auto_create:
        create_all_tables()
    yield


app = FastAPI(title=settings.app_name, lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_: Request, exc: RequestValidationError) -> Response:
    # ensure_ascii escapes lone surrogates so malformed Unicode input returns a
    # structured 422 instead of a 500 while encoding the error payload.
    payload = json.dumps({"detail": exc.errors()}, ensure_ascii=True, default=str)
    return Response(content=payload, media_type="application/json", status_code=422)


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
    allow_headers=["*"],
)

app.include_router(health_router, prefix="/api/v1")
app.include_router(auth_router, prefix="/api/v1")
app.include_router(proteins_router, prefix="/api/v1")
app.include_router(runs_router, prefix="/api/v1")
app.include_router(stages_router, prefix="/api/v1")
app.include_router(artifacts_router, prefix="/api/v1")
app.include_router(uploads_router, prefix="/api/v1")
