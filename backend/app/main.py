from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.features.health.router import router as health_router

app = FastAPI(title="residue-annotation-platform")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4742"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

app.include_router(health_router, prefix="/api/v1")
