from collections.abc import Generator
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import get_settings


class Base(DeclarativeBase):
    pass


def _create_engine():
    settings = get_settings()
    if settings.database_url.startswith("sqlite"):
        Path("./data").mkdir(parents=True, exist_ok=True)
        return create_engine(
            settings.database_url,
            connect_args={"check_same_thread": False},
            pool_pre_ping=True,
        )
    return create_engine(settings.database_url, pool_pre_ping=True)


engine = _create_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def create_all_tables() -> None:
    # Imports register every feature table before metadata is materialized.
    from app.features.annotations import models as _annotations  # noqa: F401
    from app.features.auth import models as _auth  # noqa: F401
    from app.features.proteins import models as _proteins  # noqa: F401
    from app.features.runs import models as _runs  # noqa: F401

    Base.metadata.create_all(bind=engine)
