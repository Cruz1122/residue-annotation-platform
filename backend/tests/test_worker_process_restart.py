from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.core.db import Base
from app.features.proteins.models import Protein
from app.features.runs.models import ActiveRunSlot, Run, RunConfiguration, RunStage
from app.features.runs.state import RunStageStatus, RunStatus
from app.features.stages.registry import STAGE_DEFINITIONS
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker


def _seed_database(database_path: Path) -> tuple[object, str, str]:
    engine = create_engine(
        f"sqlite:///{database_path}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(bind=engine)
    sessions = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with sessions() as session:
        protein = Protein(
            sequence_sha256="a" * 64,
            sequence="ACDE",
            length=4,
            owner_id="restart-user",
            project_id="restart-project",
        )
        session.add(protein)
        session.flush()
        run = Run(
            protein=protein,
            owner_id="restart-user",
            project_id="restart-project",
            status=RunStatus.PENDING,
            requested_variants=[],
        )
        run.configuration = RunConfiguration(
            protein_id=protein.id,
            sequence_sha256=protein.sequence_sha256,
            structure_source="alphafold3",
            structure_mapping={},
            normalized_variants=[],
            selected_stage_ids=[definition.id for definition in STAGE_DEFINITIONS],
            omitted_stages=[],
            scientific_parameters={},
            prerequisites={},
            versions={"contract_version": "run-configuration-v1"},
            input_references={"protein": {"protein_id": protein.id}},
            owner_id=run.owner_id,
            project_id=run.project_id,
        )
        run.stages.extend(
            RunStage(
                stage_id=definition.id,
                status=(
                    RunStageStatus.READY if not definition.dependencies else RunStageStatus.PENDING
                ),
            )
            for definition in STAGE_DEFINITIONS
        )
        session.add(run)
        session.flush()
        session.add(ActiveRunSlot(owner_id=run.owner_id, run_id=run.id))
        session.commit()
        root_stage_id = next(
            stage.id for stage in run.stages if stage.stage_id == "protein_identity"
        )
        return engine, run.id, root_stage_id


def test_worker_entrypoint_restart_reconciles_abandoned_stage(tmp_path: Path):
    database_path = tmp_path / "worker-restart.sqlite"
    signal_path = tmp_path / "claimed.signal"
    engine, run_id, stage_id = _seed_database(database_path)
    engine.dispose()

    child_code = """
import os
import signal
from pathlib import Path

import app.worker as worker
from app.core.db import SessionLocal
from app.features.runs.worker_service import process_one as real_process_one


class CrashExecutor:
    def execute(self, stage_id: str, run_id: str) -> None:
        Path(os.environ["WORKER_TEST_SIGNAL"]).write_text("claimed", encoding="utf-8")
        os.kill(os.getpid(), signal.SIGKILL)


def process_with_crash(session):
    return real_process_one(session, CrashExecutor())


worker.process_one = process_with_crash
worker.run_forever()
"""
    environment = os.environ.copy()
    environment.update(
        {
            "APP_ENV": "test",
            "DATABASE_URL": f"sqlite:///{database_path}",
            "DATABASE_AUTO_CREATE": "false",
            "ARTIFACT_ROOT": str(tmp_path / "artifacts"),
            "HPC_EXECUTION_MODE": "disabled",
            "RUN_WORKER_LEASE_SECONDS": "30",
            "WORKER_TEST_SIGNAL": str(signal_path),
            "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
        }
    )
    process = subprocess.Popen(
        [sys.executable, "-c", child_code],
        cwd=Path(__file__).resolve().parents[1],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    deadline = time.monotonic() + 10
    while not signal_path.exists() and process.poll() is None:
        if time.monotonic() >= deadline:
            process.kill()
            stdout, stderr = process.communicate()
            raise AssertionError(f"worker did not claim the stage: {stdout}\n{stderr}")
        time.sleep(0.05)

    return_code = process.wait(timeout=10)
    stdout, stderr = process.communicate()
    assert return_code == -signal.SIGKILL, f"worker output: {stdout}\n{stderr}"

    engine = create_engine(
        f"sqlite:///{database_path}",
        connect_args={"check_same_thread": False},
    )
    sessions = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with sessions() as session:
        stage = session.get(RunStage, stage_id)
        assert stage is not None
        assert stage.status == RunStageStatus.RUNNING
        assert stage.attempt_count == 1

        stage.lease_expires_at = datetime.now(UTC) - timedelta(seconds=1)
        session.commit()
    # The second process uses the actual production entrypoint. It recovers
    # the expired lease, claims it once, and fails honestly in offline mode.
    restarted = subprocess.Popen(
        [sys.executable, "-m", "app.worker"],
        cwd=Path(__file__).resolve().parents[1],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    deadline = time.monotonic() + 10
    terminal = False
    while time.monotonic() < deadline:
        with sessions() as session:
            run = session.get(Run, run_id)
            stage = session.get(RunStage, stage_id)
            terminal = (
                run is not None
                and stage is not None
                and run.status == RunStatus.FAILED
                and stage.status == RunStageStatus.FAILED
            )
            if terminal:
                assert stage.attempt_count == 2
                assert (
                    session.scalar(select(ActiveRunSlot).where(ActiveRunSlot.run_id == run_id))
                    is None
                )
                break
        time.sleep(0.05)
    if not terminal:
        restarted.terminate()
        stdout, stderr = restarted.communicate(timeout=10)
        raise AssertionError(f"restarted worker did not reconcile the stage: {stdout}\n{stderr}")
    restarted.terminate()
    restarted.communicate(timeout=10)
    engine.dispose()
