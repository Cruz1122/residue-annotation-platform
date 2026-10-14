"""PostgreSQL concurrency checks for the high-risk boundaries.

These tests are skipped unless ``POSTGRES_TEST_DATABASE_URL`` points at a
disposable PostgreSQL database. They verify behaviors that SQLite cannot:
transactional run-slot uniqueness, ``FOR UPDATE SKIP LOCKED`` claim, refresh
rotation races, the last-admin invariant, and the rate-limit bucket race.
"""

from __future__ import annotations

import hashlib
import os
import threading
import time
from collections.abc import Callable, Generator
from pathlib import Path

import pytest
from app.core.auth import Principal
from app.core.config import Settings
from app.core.db import Base
from app.features.annotations import models as _annotations  # noqa: F401
from app.features.auth import models as _auth  # noqa: F401
from app.features.auth.models import RateLimitBucket, RefreshToken, User, UserRole
from app.features.auth.service import (
    AuthTokenInvalid,
    LastAdminError,
    RateLimitExceeded,
    change_user_role,
    create_refresh_token,
    enforce_rate_limit,
    hash_password,
    revoke_refresh_tokens,
    rotate_refresh_token,
    utcnow,
)
from app.features.proteins import models as _proteins  # noqa: F401
from app.features.proteins.models import Protein
from app.features.runs import models as _runs  # noqa: F401
from app.features.runs.models import ActiveRunSlot, Run, RunStage
from app.features.runs.schemas import RunCreate
from app.features.runs.service import create_run, request_cancel, transition_stage
from app.features.runs.state import RunStageStatus
from app.features.runs.worker_service import (
    _claim_statement,
    claim_ready_stage,
    claim_remote_stage,
    finalize_run,
)
from fastapi import HTTPException
from sqlalchemy import create_engine, func, select
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import sessionmaker

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not POSTGRES_URL,
    reason="POSTGRES_TEST_DATABASE_URL is not configured",
)

engine = create_engine(POSTGRES_URL or "sqlite://", pool_pre_ping=True)
TestSession = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


@pytest.fixture(autouse=True)
def reset_database() -> Generator[None, None, None]:
    assert POSTGRES_URL is not None
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield


def _settings(tmp_path: Path) -> Settings:
    assert POSTGRES_URL is not None
    return Settings(
        app_env="test",
        database_url=POSTGRES_URL,
        artifact_root=tmp_path / "artifacts",
    )


def _protein(session, sequence: str = "ACDE") -> Protein:
    protein = Protein(
        sequence=sequence,
        length=len(sequence),
        sequence_sha256=hashlib.sha256(sequence.encode()).hexdigest(),
        owner_id="u1",
        project_id="p1",
    )
    session.add(protein)
    session.commit()
    return protein


def _join_two(worker: Callable[[], None]) -> None:
    threads = [threading.Thread(target=worker), threading.Thread(target=worker)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert not any(thread.is_alive() for thread in threads), "concurrent worker did not finish"


def test_concurrent_run_creation_keeps_one_slot():
    with TestSession() as session:
        protein_id = _protein(session).id

    barrier = threading.Barrier(2, timeout=30)
    results: list[tuple[str, object]] = []

    def worker() -> None:
        with TestSession() as session:
            try:
                barrier.wait()
                run = create_run(session, RunCreate(protein_id=protein_id), Principal("u1", "p1"))
                results.append(("ok", run.id))
            except HTTPException as exc:
                session.rollback()
                results.append(("http", exc.status_code))
            except Exception as exc:  # pragma: no cover - diagnostic only
                session.rollback()
                results.append(("error", repr(exc)))

    _join_two(worker)

    assert [item[0] for item in results].count("ok") == 1
    assert [item[1] for item in results if item[0] == "http"] == [409]
    with TestSession() as session:
        assert session.scalar(select(func.count()).select_from(Run)) == 1
        assert session.scalar(select(func.count()).select_from(ActiveRunSlot)) == 1


def test_concurrent_claim_has_single_winner(tmp_path: Path):
    with TestSession() as session:
        protein_id = _protein(session).id
        create_run(session, RunCreate(protein_id=protein_id), Principal("u1", "p1"))

    settings = _settings(tmp_path)
    barrier = threading.Barrier(2, timeout=30)
    claimed: list[str] = []
    errors: list[str] = []

    def worker() -> None:
        with TestSession() as session:
            try:
                barrier.wait()
                stage = claim_ready_stage(session, settings)
                if stage is not None:
                    claimed.append(stage.id)
            except Exception as exc:  # pragma: no cover - diagnostic only
                session.rollback()
                errors.append(repr(exc))

    _join_two(worker)

    assert errors == []
    assert len(claimed) == 1
    with TestSession() as session:
        statuses = [str(value) for value in session.scalars(select(RunStage.status))]
        assert statuses.count("queued") == 1
        assert statuses.count("ready") == 0


def test_concurrent_remote_poll_claim_has_single_winner(tmp_path: Path):
    with TestSession() as session:
        protein_id = _protein(session).id
        run = create_run(session, RunCreate(protein_id=protein_id), Principal("u1", "p1"))
        stage = session.scalar(
            select(RunStage)
            .where(RunStage.run_id == run.id)
            .where(RunStage.status == RunStageStatus.READY)
        )
        assert stage is not None
        stage.status = RunStageStatus.QUEUED
        stage.slurm_job_id = "remote-123"
        session.commit()

    settings = _settings(tmp_path)
    barrier = threading.Barrier(2, timeout=30)
    claimed: list[tuple[str, str]] = []
    errors: list[str] = []

    def worker() -> None:
        with TestSession() as session:
            try:
                barrier.wait()
                result = claim_remote_stage(session, settings)
                if result is not None:
                    claimed.append((result[0].id, result[1]))
            except Exception as exc:  # pragma: no cover - diagnostic only
                session.rollback()
                errors.append(repr(exc))

    _join_two(worker)

    assert errors == []
    assert len(claimed) == 1
    with TestSession() as session:
        persisted = session.get(RunStage, claimed[0][0])
        assert persisted is not None
        assert persisted.poll_claim_token == claimed[0][1]


def test_concurrent_refresh_rotation_has_single_winner(tmp_path: Path):
    settings = _settings(tmp_path)
    with TestSession() as session:
        user = User(
            email="race@example.com",
            password_hash=hash_password("correct horse battery staple"),
            project_id="p1",
            email_verified_at=utcnow(),
        )
        session.add(user)
        session.commit()
        raw_token = create_refresh_token(session, user, settings)
        session.commit()

    barrier = threading.Barrier(2, timeout=30)
    successes: list[str] = []
    failures: list[str] = []

    def worker() -> None:
        with TestSession() as session:
            try:
                barrier.wait()
                _, rotated = rotate_refresh_token(session, raw_token, settings)
                session.commit()
                successes.append(rotated)
            except AuthTokenInvalid as exc:
                # The service revokes the token family before raising; persist
                # it exactly like the HTTP endpoint does.
                session.commit()
                failures.append(str(exc))
            except Exception as exc:  # pragma: no cover - diagnostic only
                session.rollback()
                failures.append("error:" + repr(exc))

    _join_two(worker)

    assert len(successes) == 1
    assert failures == ["refresh token was already revoked"]
    with TestSession() as session:
        with pytest.raises(AuthTokenInvalid):
            rotate_refresh_token(session, successes[0], settings)
        with pytest.raises(AuthTokenInvalid):
            rotate_refresh_token(session, raw_token, settings)


def test_concurrent_rate_limit_bucket_has_single_winner(tmp_path: Path):
    settings = _settings(tmp_path)
    assert settings.database_url
    barrier = threading.Barrier(2, timeout=30)
    outcomes: list[str] = []
    errors: list[str] = []

    def worker() -> None:
        with TestSession() as session:
            try:
                barrier.wait()
                enforce_rate_limit(
                    session,
                    key="auth:login:race",
                    limit=1,
                    window_seconds=900,
                )
                outcomes.append("ok")
            except RateLimitExceeded:
                outcomes.append("limited")
            except Exception as exc:  # pragma: no cover - diagnostic only
                session.rollback()
                errors.append(repr(exc))

    _join_two(worker)

    assert errors == []
    assert sorted(outcomes) == ["limited", "ok"]
    with TestSession() as session:
        bucket = session.scalar(
            select(RateLimitBucket).where(RateLimitBucket.key == "auth:login:race")
        )
        assert bucket is not None
        assert bucket.count == 1


def test_concurrent_refresh_cannot_survive_logout(tmp_path: Path):
    settings = _settings(tmp_path)
    with TestSession() as session:
        user = User(
            email="logout-race@example.com",
            password_hash=hash_password("correct horse battery staple"),
            project_id="p1",
            email_verified_at=utcnow(),
        )
        session.add(user)
        session.commit()
        raw_token = create_refresh_token(session, user, settings)
        session.commit()
        user_id = user.id

    refresh_started = threading.Event()
    release_refresh = threading.Event()
    rotated: dict[str, str] = {}

    def refresh_worker() -> None:
        with TestSession() as session:
            _, new_token = rotate_refresh_token(session, raw_token, settings)
            rotated["token"] = new_token
            refresh_started.set()
            release_refresh.wait(10)
            session.commit()

    def logout_worker() -> None:
        with TestSession() as session:
            assert refresh_started.wait(10)
            # Blocks on the user lock held by the refresh transaction, then
            # must see the rotated token committed before it.
            revoke_refresh_tokens(session, user_id)
            session.commit()

    refresh_thread = threading.Thread(target=refresh_worker)
    logout_thread = threading.Thread(target=logout_worker)
    refresh_thread.start()
    logout_thread.start()
    assert refresh_started.wait(10)
    time.sleep(0.5)
    release_refresh.set()
    refresh_thread.join(timeout=30)
    logout_thread.join(timeout=30)
    assert not refresh_thread.is_alive() and not logout_thread.is_alive()

    with TestSession() as session:
        tokens = list(session.scalars(select(RefreshToken).where(RefreshToken.user_id == user_id)))
        alive = [token for token in tokens if token.revoked_at is None]
    assert len(tokens) == 2
    assert alive == []
    assert rotated["token"]


def test_cancelled_run_cannot_be_revived_by_stale_worker(tmp_path: Path):
    settings = _settings(tmp_path)
    with TestSession() as session:
        protein_id = _protein(session).id
        create_run(session, RunCreate(protein_id=protein_id), Principal("u1", "p1"))

    worker_session = TestSession()
    stage = claim_ready_stage(worker_session, settings)
    assert stage is not None
    stage_id, run_id = stage.id, stage.run_id

    cancel_session = TestSession()
    run_to_cancel = cancel_session.get(Run, run_id)
    assert run_to_cancel is not None
    request_cancel(cancel_session, run_to_cancel)

    # A stale worker tries to keep going; the persisted CANCELLED state wins.
    with pytest.raises(ValueError):
        transition_stage(worker_session, stage, RunStageStatus.RUNNING)
    worker_session.rollback()
    stale_run = worker_session.get(Run, run_id)
    assert stale_run is not None
    finalize_run(worker_session, stale_run)

    with TestSession() as session:
        cancelled_run = session.get(Run, run_id)
        cancelled_stage = session.get(RunStage, stage_id)
        assert cancelled_run is not None and cancelled_run.status == "cancelled"
        assert cancelled_stage is not None and cancelled_stage.status == "cancelled"

    worker_session.close()
    cancel_session.close()


def test_claim_statement_locks_a_single_row():
    compiled = str(_claim_statement().compile(dialect=postgresql.dialect())).upper()

    assert "LIMIT" in compiled
    assert "FOR UPDATE SKIP LOCKED" in compiled


def test_concurrent_demotions_preserve_one_administrator():
    with TestSession() as session:
        administrators = [
            User(
                email=f"admin-{index}@example.com",
                password_hash=hash_password("correct horse battery staple"),
                project_id=f"p{index}",
                role=UserRole.ADMIN.value,
                email_verified_at=utcnow(),
            )
            for index in range(2)
        ]
        session.add_all(administrators)
        session.commit()
        administrator_ids = [user.id for user in administrators]

    barrier = threading.Barrier(2, timeout=30)
    outcomes: list[str] = []

    def worker(user_id: str) -> None:
        with TestSession() as session:
            target = session.get(User, user_id)
            assert target is not None
            try:
                barrier.wait()
                change_user_role(session, target, UserRole.USER)
                session.commit()
                outcomes.append("demoted")
            except LastAdminError:
                session.rollback()
                outcomes.append("protected")
            except Exception as exc:  # pragma: no cover - diagnostic only
                session.rollback()
                outcomes.append("error:" + repr(exc))

    threads = [threading.Thread(target=worker, args=(user_id,)) for user_id in administrator_ids]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert not any(thread.is_alive() for thread in threads)
    assert sorted(outcomes) == ["demoted", "protected"]

    with TestSession() as session:
        remaining = session.scalar(
            select(func.count()).select_from(User).where(User.role == UserRole.ADMIN.value)
        )
    assert remaining == 1
