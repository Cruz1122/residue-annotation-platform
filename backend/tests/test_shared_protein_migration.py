from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config
from app.core.config import get_settings


def _alembic_config() -> Config:
    return Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))


def _set_database(
    monkeypatch: pytest.MonkeyPatch, database: Path, request: pytest.FixtureRequest
) -> None:
    get_settings.cache_clear()
    request.addfinalizer(get_settings.cache_clear)
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{database}")


def test_shared_protein_migration_backfills_access_and_round_trips_without_data_loss(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest
):
    database = tmp_path / "migration.db"
    _set_database(monkeypatch, database, request)
    config = _alembic_config()

    command.upgrade(config, "0008_run_preparation")
    engine = sa.create_engine(f"sqlite:///{database}")
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                "INSERT INTO proteins "
                "(id, sequence_sha256, sequence, length, owner_id, project_id) "
                "VALUES ('protein-a', :hash, 'ACDE', 4, 'owner-a', 'project-a')"
            ),
            {"hash": "a" * 64},
        )

    command.upgrade(config, "head")
    with engine.connect() as connection:
        membership = connection.execute(
            sa.text(
                "SELECT protein_id, project_id FROM protein_project_access WHERE protein_id = :id"
            ),
            {"id": "protein-a"},
        ).one()
        unique_constraints = sa.inspect(connection).get_unique_constraints("stage_results")
        assert membership == ("protein-a", "project-a")
        cache_constraint = next(
            constraint
            for constraint in unique_constraints
            if constraint["name"] == "uq_stage_result_cache"
        )
        assert cache_constraint["column_names"] == [
            "protein_id",
            "stage_id",
            "cache_key",
            "project_id",
        ]

    command.downgrade(config, "0008_run_preparation")
    with engine.connect() as connection:
        assert connection.execute(sa.text("SELECT COUNT(*) FROM proteins")).scalar_one() == 1
        assert (
            connection.execute(
                sa.text(
                    "SELECT COUNT(*) FROM alembic_version "
                    "WHERE version_num = '0008_run_preparation'"
                )
            ).scalar_one()
            == 1
        )
        assert not sa.inspect(connection).has_table("protein_project_access")

    engine.dispose()
    get_settings.cache_clear()


def test_shared_protein_migration_downgrade_refuses_cross_project_cache_data_loss(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest
):
    database = tmp_path / "migration-duplicate.db"
    _set_database(monkeypatch, database, request)
    config = _alembic_config()

    command.upgrade(config, "head")
    engine = sa.create_engine(f"sqlite:///{database}")
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                "INSERT INTO proteins "
                "(id, sequence_sha256, sequence, length, owner_id, project_id) "
                "VALUES ('protein-a', :hash, 'ACDE', 4, 'owner-a', 'project-a')"
            ),
            {"hash": "a" * 64},
        )
        connection.execute(
            sa.text(
                "INSERT INTO stage_results "
                "(id, protein_id, stage_id, cache_key, status, provenance, owner_id, project_id) "
                "VALUES ('result-a', 'protein-a', 'protein_identity', :key, 'success', '{}', "
                "'owner-a', 'project-a'), ('result-b', 'protein-a', 'protein_identity', :key, "
                "'success', '{}', 'owner-b', 'project-b')"
            ),
            {"key": "b" * 64},
        )

    with pytest.raises(RuntimeError, match="would violate the previous global cache uniqueness"):
        command.downgrade(config, "0008_run_preparation")

    with engine.connect() as connection:
        assert sa.inspect(connection).has_table("protein_project_access")
        assert connection.execute(sa.text("SELECT COUNT(*) FROM stage_results")).scalar_one() == 2

    engine.dispose()
    get_settings.cache_clear()
