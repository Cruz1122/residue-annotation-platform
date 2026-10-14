import os
from collections.abc import Generator
from pathlib import Path

os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("DATABASE_URL", "sqlite://")
os.environ.setdefault("CORS_ORIGINS", "http://localhost:4742")

import pytest
from app.core.config import Settings, get_settings
from app.core.db import Base, get_db
from app.features.annotations import models as _annotations  # noqa: F401, E402

# Import all model modules before creating metadata, including per-stage tables.
from app.features.auth import models as _auth  # noqa: F401, E402
from app.features.proteins import models as _proteins  # noqa: F401, E402
from app.features.runs import models as _runs  # noqa: F401, E402
from app.main import app
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

TEST_ENGINE = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=TEST_ENGINE, autoflush=False, expire_on_commit=False)


def override_get_db() -> Generator[Session, None, None]:
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()


app.dependency_overrides[get_db] = override_get_db


@pytest.fixture(autouse=True)
def reset_database(tmp_path: Path) -> Generator[None, None, None]:
    Base.metadata.drop_all(bind=TEST_ENGINE)
    Base.metadata.create_all(bind=TEST_ENGINE)
    app.dependency_overrides[get_settings] = lambda: Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
    )
    yield
    app.dependency_overrides.pop(get_settings, None)


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def session() -> Generator[Session, None, None]:
    database_session = TestingSessionLocal()
    try:
        yield database_session
    finally:
        database_session.close()
