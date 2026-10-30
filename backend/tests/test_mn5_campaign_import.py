from __future__ import annotations

import gzip
import hashlib
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from app.core.config import Settings
from app.features.annotations.models import ANNOTATION_TABLES
from app.features.artifacts.storage import ArtifactStore
from app.features.auth.models import User
from app.features.proteins.models import Protein, ProteinIdentifier
from app.features.runs import mn5_campaign_import as campaign
from app.features.runs import mn5_tracking as tracking_module
from app.features.runs import worker_service as worker_service_module
from app.features.runs.manifest import ManifestError
from app.features.runs.mn5_campaign_import import CampaignInventory, Candidate
from app.features.runs.mn5_tracking import (
    _aggregate_lineage_snapshot,
    _apply_snapshot,
    _decode_context,
    _ensure_stage_result,
    _has_missing_selected_stage_status,
    _has_pending_result_publications,
    _is_reference_sequence_context,
    _load_claimed_tracking,
    _manifest_artifact_path,
    _manifest_artifact_specs,
    _manifest_path_for,
    _persist_artifact,
    _published_stage_jobs,
    _remote_stage_ids,
    _remote_stage_result,
    _remote_stage_statuses,
    _run_status,
    _should_continue_external_sync,
    _verified_lineage_result_contexts,
)
from app.features.runs.models import (
    Artifact,
    ExternalRunTracking,
    Run,
    RunConfiguration,
    RunStage,
    StageResult,
)
from app.features.runs.state import RunStageStatus, RunStatus
from app.features.runs.worker_service import (
    claim_ready_run,
    claim_ready_stage,
    process_one,
    recover_stale_stages,
)
from app.infrastructure.hpc.readonly import InMemoryReadOnlyInspector
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker


def _context(
    run_id: str,
    reference: str,
    query: str,
    stage_status: dict[str, str],
    *,
    variant: tuple[str, int, str] | None = None,
) -> dict[str, object]:
    context: dict[str, object] = {
        "run_id": run_id,
        "uniprot_accession": "P11712",
        "reference_sequence": reference,
        "query_sequence": query,
        "reference_sequence_sha256": hashlib.sha256(reference.encode("ascii")).hexdigest(),
        "query_sequence_sha256": hashlib.sha256(query.encode("ascii")).hexdigest(),
        "input_state": {"run_status": "success", "stage_status": stage_status},
        "stage_results": {stage_id: {"status": state} for stage_id, state in stage_status.items()},
    }
    if variant:
        context.update(
            {
                "variant_ref": variant[0],
                "variant_position": variant[1],
                "variant_alt": variant[2],
            }
        )
    return context


def test_ddg_success_does_not_finish_run_while_later_stage_is_running():
    class RunLike:
        configuration = type(
            "Configuration",
            (),
            {"selected_stage_ids": ["variant_ddg", "protein_relaxation_energy"]},
        )()

    statuses = {
        "variant_ddg": RunStageStatus.SUCCESS,
        "protein_relaxation_energy": RunStageStatus.RUNNING,
    }

    assert _run_status(RunLike(), statuses) == RunStatus.RUNNING


def test_external_fetch_renews_claim_while_sftp_group_is_still_running(monkeypatch):
    real_wait = tracking_module.wait
    wait_calls = 0
    heartbeats = 0

    def return_pending_twice(futures, *, timeout, return_when):
        nonlocal wait_calls
        wait_calls += 1
        if wait_calls < 3:
            return set(), futures
        return real_wait(futures, timeout=timeout, return_when=return_when)

    def fetch_group(_settings, items, _limit=None):
        return {path: b"snapshot" for _, path in items}, None

    def renew():
        nonlocal heartbeats
        heartbeats += 1

    monkeypatch.setattr(tracking_module, "wait", return_pending_twice)
    monkeypatch.setattr(tracking_module, "_fetch_group", fetch_group)
    settings = Settings(app_env="test", mn5_external_sync_parallelism=1)

    fetched, failed = tracking_module._fetch_many(
        settings,
        ["runs/example/run_context.json"],
        on_progress=renew,
    )

    assert fetched == {"runs/example/run_context.json": b"snapshot"}
    assert failed == set()
    assert heartbeats >= 4


def test_campaign_import_marks_cancelled_stage_sets_cancelled_not_success():
    assert (
        campaign._overall_status(
            {"protein_identity": RunStageStatus.CANCELLED}, ["protein_identity"]
        )
        == RunStatus.CANCELLED
    )
    assert (
        campaign._overall_status(
            {
                "protein_identity": RunStageStatus.CANCELLED,
                "variant_ddg": RunStageStatus.RUNNING,
            },
            ["protein_identity", "variant_ddg"],
        )
        == RunStatus.RUNNING
    )


def test_campaign_import_keeps_global_run_active_after_observed_stages_finish():
    stage_statuses = {
        "protein_identity": RunStageStatus.SUCCESS,
        "variant_ddg": RunStageStatus.SUCCESS,
    }

    assert (
        campaign._overall_status(
            stage_statuses,
            ["protein_identity", "variant_ddg"],
            remote_status="running",
        )
        == RunStatus.RUNNING
    )


def test_external_snapshot_preserves_last_sync_on_invalid_payload():
    old_sync = datetime(2026, 10, 25, tzinfo=UTC)
    tracking = SimpleNamespace(remote_run_id="expected-run", last_synced_at=old_sync)
    stage = SimpleNamespace(stage_id="variant_ddg", status=RunStageStatus.SUCCESS)
    run = SimpleNamespace(stages=[stage], configuration=None)

    with pytest.raises(ValueError, match="identity changed"):
        _apply_snapshot(
            tracking,
            run,
            {"run_id": "another-run", "input_state": {"stage_status": {}}},
            now=datetime.now(UTC),
            interval_seconds=15,
        )

    assert tracking.last_synced_at == old_sync
    assert stage.status == RunStageStatus.SUCCESS


def test_external_snapshot_merges_status_sources_and_declared_stage_ids():
    context = {
        "stage_status": {
            "protein_identity": "success",
            "uniprot_features": "running",
        },
        "input_state": {
            "stage_status": {"protein_identity": "running"},
            "stage_ids": ["membrane_topology"],
        },
        "stage_ids": ["structure_modeling"],
        "stage_results": {"structural_regime": {"status": "success"}},
    }

    statuses = _remote_stage_statuses(context)

    assert statuses == {
        "protein_identity": RunStageStatus.RUNNING,
        "uniprot_features": RunStageStatus.RUNNING,
        "structural_regime": RunStageStatus.SUCCESS,
    }
    assert _remote_stage_ids(context) == (
        "protein_identity",
        "uniprot_features",
        "membrane_topology",
        "structure_modeling",
        "structural_regime",
    )


def test_external_snapshot_adds_newly_observed_stages_and_keeps_live_progress():
    now = datetime.now(UTC)
    tracking = SimpleNamespace(
        remote_run_id="expected-run",
        published_cache_keys={},
        next_sync_at=None,
        last_synced_at=None,
        last_attempt_at=None,
        connection_status="unavailable",
        sync_error_code="mn5_unavailable",
    )
    configuration = SimpleNamespace(selected_stage_ids=["protein_identity"])
    existing = SimpleNamespace(
        stage_id="protein_identity",
        status=RunStageStatus.SUCCESS,
        cache_key=None,
        error_code=None,
        error_message=None,
        started_at=now,
        finished_at=now,
    )
    run = SimpleNamespace(
        id="run-id",
        configuration=configuration,
        stages=[existing],
        status=RunStatus.SUCCESS,
        error_code=None,
        error_message=None,
        started_at=now,
        finished_at=now,
    )
    context = {
        "run_id": "expected-run",
        "input_state": {"stage_status": {"protein_identity": "running"}},
        "stage_status": {"protein_relaxation_energy": "success"},
        "stage_ids": ["protein_identity", "protein_relaxation_energy"],
        "stage_results": {},
    }

    _apply_snapshot(
        tracking,
        run,
        context,
        now=now + timedelta(seconds=1),
        interval_seconds=15,
    )

    assert configuration.selected_stage_ids == [
        "protein_identity",
        "protein_relaxation_energy",
    ]
    assert existing.status == RunStageStatus.RUNNING
    assert existing.started_at is None
    assert existing.finished_at is None
    relaxation = next(
        stage for stage in run.stages if stage.stage_id == "protein_relaxation_energy"
    )
    assert relaxation.status == RunStageStatus.SUCCESS
    assert relaxation.started_at is None
    assert relaxation.finished_at is None
    assert run.status == RunStatus.RUNNING
    assert run.started_at is None
    assert run.finished_at is None
    assert tracking.next_sync_at is not None


def test_base_lineage_snapshot_uses_latest_explicit_states_and_ignores_variant_runs():
    lineage = "P11712_3f891626b668"
    base = "ACDEFGHIK"
    primary_id = f"{lineage}_20261026T010203000001Z"
    sibling_id = f"{lineage}_20261027T010203000001Z"
    variant_id = f"{lineage}_20261028T010203000001Z"
    primary = _context(
        primary_id,
        base,
        base,
        {"protein_identity": "success", "structural_frustration": "failed"},
    )
    primary["stage_results"]["structural_frustration"]["cache_key"] = "a" * 64
    sibling = _context(
        sibling_id,
        base,
        base,
        {"structural_frustration": "success", "sequence_frustration": "success"},
    )
    variant = _context(
        variant_id,
        base,
        base,
        {"structural_frustration": "failed", "variant_ddg": "success"},
        variant=("A", 1, "V"),
    )
    tracking = SimpleNamespace(
        run_type="base",
        accession="P11712",
        remote_run_id=primary_id,
    )

    aggregate = _aggregate_lineage_snapshot(tracking, primary, [sibling, variant])

    assert _remote_stage_statuses(aggregate) == {
        "protein_identity": RunStageStatus.SUCCESS,
        "structural_frustration": RunStageStatus.SUCCESS,
        "sequence_frustration": RunStageStatus.SUCCESS,
    }
    assert aggregate["_lineage_stage_sources"]["structural_frustration"] == sibling_id
    assert "variant_ddg" not in _remote_stage_ids(aggregate)
    assert aggregate["input_state"]["run_status"] == "success"

    stage = SimpleNamespace(
        stage_id="structural_frustration",
        status=RunStageStatus.FAILED,
        cache_key="a" * 64,
        stage_result_id="stale-result",
        error_code="external_stage_failed",
        error_message=None,
        started_at=None,
        finished_at=None,
    )
    run = SimpleNamespace(
        configuration=SimpleNamespace(
            selected_stage_ids=[
                "protein_identity",
                "structural_frustration",
                "sequence_frustration",
            ]
        ),
        stages=[stage],
        status=RunStatus.FAILED,
        error_code="external_stage_failed",
        error_message=None,
        started_at=None,
        finished_at=None,
    )
    tracking.published_cache_keys = {}
    tracking.next_sync_at = None
    tracking.last_synced_at = None
    tracking.last_attempt_at = None
    tracking.connection_status = "connected"
    tracking.sync_error_code = None

    _apply_snapshot(
        tracking,
        run,
        aggregate,
        now=datetime.now(UTC),
        interval_seconds=15,
    )

    assert stage.status == RunStageStatus.SUCCESS
    assert stage.cache_key is None
    assert stage.stage_result_id is None
    assert run.status == RunStatus.SUCCESS


def test_base_lineage_snapshot_carries_verified_successful_sibling_result_metadata():
    lineage = "P11712_3f891626b668"
    sequence = "ACDEFGHIK"
    primary_id = f"{lineage}_20261026T010203000001Z"
    sibling_id = f"{lineage}_20261027T010203000001Z"
    primary = _context(
        primary_id,
        sequence,
        sequence,
        {"protein_identity": "success", "structural_frustration": "failed"},
    )
    sibling = _context(
        sibling_id,
        sequence,
        sequence,
        {"structural_frustration": "success"},
    )
    cache_key = "b" * 64
    sibling["stage_results"]["structural_frustration"].update(
        cache_key=cache_key,
        result_dir=f"runs/{sibling_id}/results/structural_frustration/{cache_key}",
    )
    tracking = SimpleNamespace(
        id="tracking-id",
        run_type="base",
        accession="P11712",
        remote_run_id=primary_id,
        published_cache_keys={},
    )

    aggregate = _aggregate_lineage_snapshot(tracking, primary, [sibling])

    assert _remote_stage_statuses(aggregate)["structural_frustration"] == RunStageStatus.SUCCESS
    assert _remote_stage_result(aggregate, "structural_frustration")["cache_key"] == cache_key
    assert aggregate["_lineage_stage_result_sources"]["structural_frustration"] == sibling_id

    publication_run = SimpleNamespace(
        configuration=SimpleNamespace(selected_stage_ids=["structural_frustration"])
    )
    jobs, invalid_stages = _published_stage_jobs(
        tracking,
        publication_run,
        aggregate,
        Settings(app_env="test"),
        result_contexts=_verified_lineage_result_contexts(
            aggregate,
            {primary_id: primary, sibling_id: sibling},
        ),
    )
    assert invalid_stages == set()
    assert len(jobs) == 1
    assert jobs[0]["remote_run_id"] == sibling_id
    assert jobs[0]["result_dir"].startswith(f"runs/{sibling_id}/")

    stage = SimpleNamespace(
        stage_id="structural_frustration",
        status=RunStageStatus.FAILED,
        cache_key="a" * 64,
        stage_result_id="stale-result",
        error_code="external_stage_failed",
        error_message=None,
        started_at=None,
        finished_at=None,
    )
    run = SimpleNamespace(
        configuration=SimpleNamespace(selected_stage_ids=["structural_frustration"]),
        stages=[stage],
        status=RunStatus.FAILED,
        error_code="external_stage_failed",
        error_message=None,
        started_at=None,
        finished_at=None,
    )
    tracking.published_cache_keys = {}
    tracking.next_sync_at = None
    tracking.last_synced_at = None
    tracking.last_attempt_at = None
    tracking.connection_status = "connected"
    tracking.sync_error_code = None

    _apply_snapshot(
        tracking,
        run,
        aggregate,
        now=datetime.now(UTC),
        interval_seconds=15,
    )

    assert stage.status == RunStageStatus.SUCCESS
    assert stage.cache_key == cache_key
    assert stage.stage_result_id is None
    assert run.status == RunStatus.SUCCESS


def test_remote_lineage_metadata_cannot_publish_a_rejected_variant_sibling():
    lineage = "P11712_3f891626b668"
    sequence = "ACDEFGHIK"
    primary_id = f"{lineage}_20261026T010203000001Z"
    sibling_id = f"{lineage}_20261027T010203000001Z"
    cache_key = "b" * 64
    primary = _context(
        primary_id,
        sequence,
        sequence,
        {"structural_frustration": "success"},
        variant=("A", 1, "V"),
    )
    primary["stage_results"]["structural_frustration"].update(
        cache_key=cache_key,
        result_dir=f"runs/{primary_id}/results/structural_frustration/{cache_key}",
    )
    primary["_lineage_stage_result_sources"] = {"structural_frustration": sibling_id}
    sibling = _context(
        sibling_id,
        sequence,
        sequence,
        {"structural_frustration": "success"},
        variant=("A", 1, "V"),
    )
    sibling["stage_results"]["structural_frustration"].update(
        cache_key=cache_key,
        result_dir=f"runs/{sibling_id}/results/structural_frustration/{cache_key}",
    )
    tracking = SimpleNamespace(
        id="tracking-id",
        run_type="base",
        accession="P11712",
        remote_run_id=primary_id,
        published_cache_keys={},
    )

    aggregate = _aggregate_lineage_snapshot(tracking, primary, [sibling])
    verified_contexts = _verified_lineage_result_contexts(
        aggregate,
        {primary_id: primary, sibling_id: sibling},
    )
    run = SimpleNamespace(
        configuration=SimpleNamespace(selected_stage_ids=["structural_frustration"])
    )

    jobs, invalid_stages = _published_stage_jobs(
        tracking,
        run,
        aggregate,
        Settings(app_env="test"),
        result_contexts=verified_contexts,
    )

    assert aggregate["_lineage_context_rejected"] is True
    assert "_lineage_stage_result_sources" not in aggregate
    assert verified_contexts == {}
    assert jobs == []
    assert invalid_stages == {"structural_frustration"}


def test_base_lineage_snapshot_does_not_pair_latest_status_with_older_result():
    lineage = "P11712_3f891626b668"
    sequence = "ACDEFGHIK"
    primary_id = f"{lineage}_20261026T010203000001Z"
    older_result_id = f"{lineage}_20261025T010203000001Z"
    latest_status_id = f"{lineage}_20261027T010203000001Z"
    primary = _context(
        primary_id,
        sequence,
        sequence,
        {"structural_frustration": "failed"},
    )
    older_result = _context(
        older_result_id,
        sequence,
        sequence,
        {"structural_frustration": "success"},
    )
    older_result["stage_results"]["structural_frustration"].update(
        cache_key="b" * 64,
        result_dir=f"results/structural_frustration/{'b' * 64}",
    )
    latest_status = _context(
        latest_status_id,
        sequence,
        sequence,
        {"structural_frustration": "success"},
    )
    tracking = SimpleNamespace(
        run_type="base",
        accession="P11712",
        remote_run_id=primary_id,
    )

    aggregate = _aggregate_lineage_snapshot(
        tracking,
        primary,
        [older_result, latest_status],
    )

    assert _remote_stage_statuses(aggregate)["structural_frustration"] == (RunStageStatus.SUCCESS)
    assert aggregate["_lineage_stage_sources"]["structural_frustration"] == latest_status_id
    assert _remote_stage_result(aggregate, "structural_frustration") is None
    assert aggregate["_lineage_stage_result_sources"] == {}


def test_deeply_nested_remote_json_is_rejected_without_recursing_forever():
    nested = b"{" * 80 + b'"value":1' + b"}" * 80
    payload = b'{"run_id":"remote-run","nested":' + nested + b"}"

    assert _decode_context(payload) is None


def test_remote_context_cannot_supply_reserved_lineage_metadata():
    payload = json.dumps(
        {
            "run_id": "remote-run",
            "_lineage_stage_result_sources": {"structural_frustration": "sibling-run"},
        }
    ).encode()

    assert _decode_context(payload) == {"run_id": "remote-run"}


def test_ddg_export_requires_a_finite_numeric_measurement():
    tracking = SimpleNamespace(run_type="ddg", accession="P11712", variant="A1V")
    header = b"protein_id\taa_position\taa_ref\taa_alt\tddg_value\n"

    assert tracking_module._verify_ddg_variant_export(
        tracking, header + b"P11712\t1\tA\tV\t-2.75\n"
    )
    assert not tracking_module._verify_ddg_variant_export(
        tracking, header + b"P11712\t1\tA\tV\tNA\n"
    )
    assert not tracking_module._verify_ddg_variant_export(
        tracking, b"protein_id\taa_position\taa_ref\taa_alt\nP11712\t1\tA\tV\n"
    )


def test_external_manifest_artifacts_are_bound_to_the_run_or_shared_stage_cache():
    cache_key = "a" * 64
    result_dir = f"results/variant_ddg/{cache_key}"
    remote_run_id = "P11712_run_20261025T010203000001Z"
    run_scoped_output = (
        f"runs/{remote_run_id}/orchestration/genomic_mapping/missense_substitutions.tsv"
    )

    assert (
        _manifest_artifact_path(
            f"{result_dir}/ddg_replicates.tsv",
            external=True,
            stage_id="variant_ddg",
            cache_key=cache_key,
            result_dir=result_dir,
        )
        == f"{result_dir}/ddg_replicates.tsv"
    )
    assert (
        _manifest_artifact_path(
            f"cache/variant_ddg/{cache_key}/ddg_replicates.tsv",
            external=True,
            stage_id="variant_ddg",
            cache_key=cache_key,
            result_dir=result_dir,
        )
        == f"cache/variant_ddg/{cache_key}/ddg_replicates.tsv"
    )
    assert (
        _manifest_artifact_path(
            run_scoped_output,
            external=True,
            stage_id="variant_ddg",
            cache_key=cache_key,
            result_dir=result_dir,
            remote_run_id=remote_run_id,
            artifact_type="genomic_substitutions",
        )
        == run_scoped_output
    )
    with pytest.raises(ManifestError, match="outside the run or its shared stage cache"):
        _manifest_artifact_path(
            run_scoped_output,
            external=True,
            stage_id="variant_ddg",
            cache_key=cache_key,
            result_dir=result_dir,
            remote_run_id="P11712_other_20261025T010204000001Z",
            artifact_type="genomic_substitutions",
        )
    with pytest.raises(ManifestError, match="outside the run or its shared stage cache"):
        _manifest_artifact_path(
            "results/other_run/other_stage/secret.tsv",
            external=True,
            stage_id="variant_ddg",
            cache_key=cache_key,
            result_dir=result_dir,
        )


def test_external_genomic_mapping_may_use_its_dedicated_shared_cache():
    cache_key = "a" * 64
    result_dir = f"results/pharmacogenomics/{cache_key}"
    shared_mapping = "cache/genomic_mapping/00c7d9183c85a557/residue_genomic_mapping.tsv"

    assert (
        _manifest_artifact_path(
            shared_mapping,
            external=True,
            stage_id="pharmacogenomics",
            cache_key=cache_key,
            result_dir=result_dir,
            artifact_type="genomic_mapping",
        )
        == shared_mapping
    )

    with pytest.raises(ManifestError, match="outside the run or its shared stage cache"):
        _manifest_artifact_path(
            "cache/genomic_mapping/00c7d9183c85a557/secret.tsv",
            external=True,
            stage_id="pharmacogenomics",
            cache_key=cache_key,
            result_dir=result_dir,
            artifact_type="genomic_mapping",
        )

    with pytest.raises(ManifestError, match="outside the run or its shared stage cache"):
        _manifest_artifact_path(
            shared_mapping,
            external=True,
            stage_id="pharmacogenomics",
            cache_key=cache_key,
            result_dir=result_dir,
            artifact_type="metadata",
        )


def test_declared_result_directory_cannot_point_to_another_run():
    cache_key = "a" * 64
    context = {
        "run_id": "P11712_run_20261025T010203000001Z",
        "stage_results": {
            "protein_identity": {"result_dir": "runs/P11712_other_20261025T010204000001Z/results"}
        },
    }

    with pytest.raises(ValueError, match="not scoped to this run or stage cache"):
        _manifest_path_for(
            context,
            "protein_identity",
            cache_key,
            Settings(app_env="test"),
        )


def test_external_sync_preserves_last_snapshot_during_outage_and_recovers(session, monkeypatch):
    sequence = "ACDEFGHIK"
    user = User(email="tracking@example.test", password_hash="test-hash", project_id="project-one")
    protein = Protein(
        sequence_sha256=hashlib.sha256(sequence.encode("ascii")).hexdigest(),
        sequence=sequence,
        length=len(sequence),
        owner_id="tracking-user",
        project_id="project-one",
    )
    session.add_all([user, protein])
    session.flush()
    run = Run(
        protein_id=protein.id,
        owner_id=protein.owner_id,
        project_id=protein.project_id,
        status=RunStatus.PENDING,
        is_external_import=True,
    )
    run.configuration = RunConfiguration(
        protein_id=protein.id,
        sequence_sha256=protein.sequence_sha256,
        structure_source="alphafold3",
        structure_mapping={},
        normalized_variants=[],
        selected_stage_ids=["protein_identity"],
        omitted_stages=[],
        scientific_parameters={},
        prerequisites={},
        versions={},
        input_references={},
        owner_id=run.owner_id,
        project_id=run.project_id,
    )
    run.stages.append(RunStage(stage_id="protein_identity", status=RunStageStatus.PENDING))
    session.add(run)
    session.flush()
    old_sync = datetime.now(UTC) - timedelta(minutes=2)
    tracking = ExternalRunTracking(
        run_id=run.id,
        source="mn5",
        remote_run_id="P11712_tracking_20261025T010203000001Z",
        remote_path="runs/P11712_tracking_20261025T010203000001Z",
        run_type="mutant",
        base_protein_id=protein.id,
        accession="P11712",
        variant="A1V",
        display_name="P11712-A1V",
        last_synced_at=old_sync,
        next_sync_at=datetime.now(UTC) - timedelta(seconds=1),
    )
    run.external_tracking = tracking
    session.commit()
    settings = Settings(
        app_env="test",
        mn5_external_sync_interval_seconds=15,
        mn5_external_sync_batch_size=10,
        mn5_external_sync_parallelism=2,
    )

    def fetch_unavailable(
        _settings, paths, *, on_progress=None, on_group_result=None, group_size=1
    ):
        if on_progress is not None:
            on_progress()
        return ({}, set(paths)) if paths else ({}, set())

    monkeypatch.setattr(tracking_module, "_fetch_many", fetch_unavailable)
    assert tracking_module.sync_due_external_runs(session, settings) == 1
    assert tracking.last_synced_at.replace(tzinfo=UTC) == old_sync
    assert tracking.connection_status == "unavailable"
    assert tracking.sync_error_code == "mn5_unavailable"
    assert run.status == RunStatus.PENDING
    assert run.stages[0].status == RunStageStatus.PENDING

    session.refresh(tracking)
    assert tracking.claim_token is None
    assert tracking.claim_expires_at is None
    tracking.next_sync_at = datetime.now(UTC) - timedelta(seconds=1)
    session.commit()
    context = {
        "run_id": tracking.remote_run_id,
        "input_state": {"stage_status": {"protein_identity": "running"}},
        "stage_results": {},
    }
    progress_visible_before_manifest_fetch = False
    observer_factory = sessionmaker(bind=session.get_bind(), expire_on_commit=False)

    def replace_claim_before_returning_stale_context(
        _settings, paths, *, on_progress=None, on_group_result=None, group_size=1
    ):
        if on_progress is not None:
            on_progress()
        if not paths:
            return {}, set()
        with observer_factory() as observer:
            newer_claim = observer.get(ExternalRunTracking, tracking.id)
            newer_claim.claim_token = "newer-worker-token"
            newer_claim.claim_expires_at = datetime.now(UTC) + timedelta(minutes=1)
            observer.commit()
        return {paths[0]: json.dumps(context).encode()}, set()

    monkeypatch.setattr(
        tracking_module,
        "_fetch_many",
        replace_claim_before_returning_stale_context,
    )
    assert tracking_module.sync_due_external_runs(session, settings) == 1
    with observer_factory() as observer:
        persisted_run = observer.get(Run, run.id)
        persisted_tracking = observer.get(ExternalRunTracking, tracking.id)
        assert persisted_run.status == RunStatus.PENDING
        assert persisted_run.stages[0].status == RunStageStatus.PENDING
        assert persisted_tracking.claim_token == "newer-worker-token"

    session.refresh(tracking)
    tracking.claim_token = None
    tracking.claim_expires_at = None
    tracking.next_sync_at = datetime.now(UTC) - timedelta(seconds=1)
    session.commit()

    def fetch_snapshot_then_check_progress(
        _settings, paths, *, on_progress=None, on_group_result=None, group_size=1
    ):
        nonlocal progress_visible_before_manifest_fetch
        if on_progress is not None:
            on_progress()
        if paths:
            return {paths[0]: json.dumps(context).encode()}, set()
        with observer_factory() as observer:
            persisted_run = observer.get(Run, run.id)
            persisted_tracking = observer.get(ExternalRunTracking, tracking.id)
            assert persisted_run.status == RunStatus.RUNNING
            assert persisted_run.stages[0].status == RunStageStatus.RUNNING
            assert persisted_tracking.last_synced_at.replace(tzinfo=UTC) > old_sync
            persisted_tracking.claim_expires_at = datetime.now(UTC) + timedelta(seconds=5)
            observer.commit()
        if on_progress is not None:
            on_progress()
        with observer_factory() as observer:
            persisted_tracking = observer.get(ExternalRunTracking, tracking.id)
            assert persisted_tracking.claim_expires_at.replace(tzinfo=UTC) > (
                datetime.now(UTC) + timedelta(seconds=30)
            )
        progress_visible_before_manifest_fetch = True
        return {}, set()

    monkeypatch.setattr(tracking_module, "_fetch_many", fetch_snapshot_then_check_progress)

    assert tracking_module.sync_due_external_runs(session, settings) == 1
    assert progress_visible_before_manifest_fetch
    assert tracking.last_synced_at.replace(tzinfo=UTC) > old_sync
    assert tracking.connection_status == "connected"
    assert tracking.sync_error_code is None
    assert run.status == RunStatus.RUNNING
    assert run.stages[0].status == RunStageStatus.RUNNING

    session.refresh(tracking)
    assert tracking.claim_token is None
    assert tracking.claim_expires_at is None
    tracking.next_sync_at = datetime.now(UTC) - timedelta(seconds=1)
    session.commit()
    invalid_publication_context = {
        "run_id": tracking.remote_run_id,
        "input_state": {"stage_status": {"protein_identity": "success"}},
        "stage_results": {
            "protein_identity": {
                "status": "success",
                "cache_key": "a" * 64,
                "result_dir": "runs/unrelated-run/results",
            }
        },
    }
    progress_visible_with_invalid_publication = False

    def fetch_invalid_publication(
        _settings, paths, *, on_progress=None, on_group_result=None, group_size=1
    ):
        nonlocal progress_visible_with_invalid_publication
        if on_progress is not None:
            on_progress()
        if paths:
            return {paths[0]: json.dumps(invalid_publication_context).encode()}, set()
        with observer_factory() as observer:
            persisted_run = observer.get(Run, run.id)
            assert persisted_run.status == RunStatus.SUCCESS
            assert persisted_run.stages[0].status == RunStageStatus.SUCCESS
        progress_visible_with_invalid_publication = True
        return {}, set()

    monkeypatch.setattr(tracking_module, "_fetch_many", fetch_invalid_publication)
    assert tracking_module.sync_due_external_runs(session, settings) == 1
    assert progress_visible_with_invalid_publication
    assert run.status == RunStatus.SUCCESS
    assert run.stages[0].status == RunStageStatus.SUCCESS
    assert tracking.connection_status == "connected"
    assert tracking.sync_error_code == "result_publication_pending"

    session.refresh(tracking)
    tracking.next_sync_at = datetime.now(UTC) - timedelta(seconds=1)
    cache_key = "a" * 64
    completed_context = {
        "run_id": tracking.remote_run_id,
        "input_state": {"stage_status": {"protein_identity": "success"}},
        "stage_results": {"protein_identity": {"cache_key": cache_key}},
    }
    deeply_nested_manifest: object = {}
    for _ in range(80):
        deeply_nested_manifest = {"nested": deeply_nested_manifest}
    manifest_payload = json.dumps(deeply_nested_manifest).encode()

    def fetch_completed_snapshot(
        _settings, paths, *, on_progress=None, on_group_result=None, group_size=1
    ):
        if on_progress is not None:
            on_progress()
        fetched = {}
        for path in paths:
            if path.endswith("/run_context.json"):
                fetched[path] = json.dumps(completed_context).encode()
            elif path.endswith("/result_manifest.json"):
                fetched[path] = manifest_payload
        return fetched, set()

    session.commit()
    monkeypatch.setattr(tracking_module, "_fetch_many", fetch_completed_snapshot)

    assert tracking_module.sync_due_external_runs(session, settings) == 1
    assert tracking.connection_status == "connected"
    assert tracking.sync_error_code == "result_publication_pending"
    assert run.status == RunStatus.SUCCESS
    assert run.stages[0].status == RunStageStatus.SUCCESS


def test_external_snapshot_worker_persists_stage_progress_without_fetching_publications(
    session,
    monkeypatch,
):
    sequence = "ACDEFGHIK"
    remote_run_id = "P11712_snapshot_20261025T010203000001Z"
    user = User(email="snapshot@example.test", password_hash="test-hash", project_id="project-one")
    protein = Protein(
        sequence_sha256=hashlib.sha256(sequence.encode("ascii")).hexdigest(),
        sequence=sequence,
        length=len(sequence),
        owner_id="snapshot-user",
        project_id="project-one",
    )
    session.add_all([user, protein])
    session.flush()
    run = Run(
        protein_id=protein.id,
        owner_id=protein.owner_id,
        project_id=protein.project_id,
        status=RunStatus.PENDING,
        is_external_import=True,
    )
    run.configuration = RunConfiguration(
        protein_id=protein.id,
        sequence_sha256=protein.sequence_sha256,
        structure_source="alphafold3",
        structure_mapping={},
        normalized_variants=[],
        selected_stage_ids=["variant_ddg", "protein_relaxation_energy"],
        omitted_stages=[],
        scientific_parameters={},
        prerequisites={},
        versions={},
        input_references={},
        owner_id=run.owner_id,
        project_id=run.project_id,
    )
    run.stages.extend(
        [
            RunStage(stage_id="variant_ddg", status=RunStageStatus.PENDING),
            RunStage(stage_id="protein_relaxation_energy", status=RunStageStatus.PENDING),
        ]
    )
    tracking = ExternalRunTracking(
        run_id=run.id,
        source="mn5",
        remote_run_id=remote_run_id,
        remote_path=f"runs/{remote_run_id}",
        run_type="ddg",
        base_protein_id=protein.id,
        accession="P11712",
        variant="A1V",
        display_name="DDG · P11712 · A1V",
        next_sync_at=datetime.now(UTC) - timedelta(seconds=1),
    )
    publication_due_at = tracking.next_sync_at
    run.external_tracking = tracking
    session.add(run)
    session.commit()

    context = _context(
        remote_run_id,
        sequence,
        sequence,
        {"variant_ddg": "success", "protein_relaxation_energy": "running"},
        variant=("A", 1, "V"),
    )
    context["stage_results"]["variant_ddg"].update(
        cache_key="a" * 64,
        result_dir=f"runs/{remote_run_id}/results",
    )
    observed_paths: list[str] = []

    def fetch_contexts(
        settings,
        paths,
        *,
        on_progress=None,
        on_group_result=None,
        group_size=1,
    ):
        observed_paths.extend(paths)
        assert group_size == tracking_module._LINEAGE_CONTEXT_FETCH_GROUP_SIZE
        assert all(path.endswith("/run_context.json") for path in paths)
        if on_progress is not None:
            on_progress()
        fetched = {path: json.dumps(context).encode("utf-8") for path in paths}
        if on_group_result is not None:
            on_group_result(fetched, set())
        return fetched, set()

    monkeypatch.setattr(tracking_module, "_fetch_many", fetch_contexts)
    settings = Settings(
        app_env="test",
        mn5_external_sync_interval_seconds=15,
        mn5_external_sync_batch_size=10,
    )

    assert tracking_module.sync_due_external_snapshots(session, settings) == 1

    session.refresh(run)
    session.refresh(tracking)
    stages = {stage.stage_id: stage for stage in run.stages}
    assert observed_paths == [f"runs/{remote_run_id}/run_context.json"]
    assert run.status == RunStatus.RUNNING
    assert stages["variant_ddg"].status == RunStageStatus.SUCCESS
    assert stages["protein_relaxation_energy"].status == RunStageStatus.RUNNING
    assert tracking.connection_status == "connected"
    assert tracking.sync_error_code == "result_publication_pending"
    assert tracking.next_sync_at.replace(tzinfo=UTC) > publication_due_at
    assert tracking.next_sync_at.replace(tzinfo=UTC) > datetime.now(UTC)
    assert tracking.last_synced_at is not None
    assert tracking.claim_token is None
    assert session.query(StageResult).filter_by(protein_id=protein.id).count() == 0
    assert tracking_module.sync_due_external_snapshots(session, settings) == 0
    assert observed_paths == [f"runs/{remote_run_id}/run_context.json"]


def test_external_snapshot_worker_reads_verified_sibling_lineage_contexts(
    session,
    monkeypatch,
    tmp_path,
):
    sequence = "ACDEFGHIK"
    lineage = "P11712_3f891626b668"
    primary_id = f"{lineage}_20261026T010203000001Z"
    sibling_id = f"{lineage}_20261027T010203000001Z"
    user = User(email="lineage@example.test", password_hash="test-hash", project_id="project-one")
    protein = Protein(
        sequence_sha256=hashlib.sha256(sequence.encode("ascii")).hexdigest(),
        sequence=sequence,
        length=len(sequence),
        owner_id="lineage-user",
        project_id="project-one",
    )
    session.add_all([user, protein])
    session.flush()
    run = Run(
        protein_id=protein.id,
        owner_id=protein.owner_id,
        project_id=protein.project_id,
        status=RunStatus.PENDING,
        is_external_import=True,
    )
    run.configuration = RunConfiguration(
        protein_id=protein.id,
        sequence_sha256=protein.sequence_sha256,
        structure_source="alphafold3",
        structure_mapping={},
        normalized_variants=[],
        selected_stage_ids=[
            "protein_identity",
            "structure_modeling",
            "structural_frustration",
        ],
        omitted_stages=[],
        scientific_parameters={},
        prerequisites={},
        versions={},
        input_references={},
        owner_id=run.owner_id,
        project_id=run.project_id,
    )
    run.stages.extend(
        [
            RunStage(stage_id="protein_identity", status=RunStageStatus.PENDING),
            RunStage(stage_id="structure_modeling", status=RunStageStatus.PENDING),
            RunStage(stage_id="structural_frustration", status=RunStageStatus.PENDING),
        ]
    )
    tracking = ExternalRunTracking(
        run_id=run.id,
        source="mn5",
        remote_run_id=primary_id,
        remote_path=f"runs/{primary_id}",
        run_type="base",
        base_protein_id=protein.id,
        accession="P11712",
        variant=None,
        display_name="P11712",
        published_cache_keys={"structure_modeling": "a" * 64},
        next_sync_at=datetime.now(UTC) - timedelta(seconds=1),
    )
    run.external_tracking = tracking
    session.add(run)
    model_result = StageResult(
        protein_id=protein.id,
        stage_id="structure_modeling",
        cache_key="a" * 64,
        status=RunStageStatus.SUCCESS,
        provenance={"source": "MN5", "external_run_id": primary_id},
        owner_id=run.owner_id,
        project_id=run.project_id,
    )
    Artifact(
        stage_result=model_result,
        artifact_type="model_cif",
        storage_backend="filesystem",
        storage_key=f"external/mn5/{protein.id}/structure_modeling/{'a' * 64}/model_cif/model.cif",
        sha256="c" * 64,
        size=1,
        media_type="chemical/x-mmcif",
    )
    session.add(model_result)
    session.commit()

    primary = _context(
        primary_id,
        sequence,
        sequence,
        {
            "protein_identity": "success",
            "structure_modeling": "success",
            "structural_frustration": "failed",
        },
    )
    primary["input_state"]["run_status"] = "failed"
    primary["stage_results"]["structure_modeling"].update(
        cache_key="a" * 64,
        result_dir=f"results/structure_modeling/{'a' * 64}",
    )
    sibling = _context(
        sibling_id,
        sequence,
        sequence,
        {"structural_frustration": "success", "sequence_frustration": "success"},
    )
    frustration_cache_key = "b" * 64
    frustration_result_dir = f"results/structural_frustration/{frustration_cache_key}"
    sibling["stage_results"]["structural_frustration"].update(
        cache_key=frustration_cache_key,
        result_dir=frustration_result_dir,
    )
    test_snapshot = _aggregate_lineage_snapshot(tracking, primary, [sibling])
    assert _remote_stage_result(test_snapshot, "structure_modeling")["cache_key"] == "a" * 64
    assert (
        session.scalar(
            select(StageResult.id).where(
                StageResult.protein_id == protein.id,
                StageResult.stage_id == "structure_modeling",
                StageResult.cache_key == "a" * 64,
                StageResult.project_id == run.project_id,
            )
        )
        == model_result.id
    )
    frustration_columns = list(
        tracking_module.STAGE_BY_ID["structural_frustration"].produced_annotations
    )
    frustration_values = {
        column: "-1.2" if column == "structural_frustration_fi_singleresidue" else "0"
        for column in frustration_columns
    }
    frustration_values["structural_frustration_status"] = "success"
    annotation_fields = ["protein_id", "aa_position", "aa_ref", *frustration_columns]
    frustration_annotations = (
        "\t".join(annotation_fields)
        + "\n"
        + "\t".join(
            [
                "P11712",
                "1",
                sequence[0],
                *(frustration_values[field] for field in frustration_columns),
            ]
        )
        + "\n"
    ).encode()
    frustration_per_residue = b"residue_number\tvalue\n1\t-1.2\n"
    structure_index = b'{"residues": []}\n'
    frustration_provenance = b"{}\n"

    def artifact_entry(path, payload):
        return {
            "path": path,
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        }

    frustration_manifest = {
        "schema": "stage-result-v1",
        "stage_id": "structural_frustration",
        "status": "success",
        "partial": False,
        "cache_key": frustration_cache_key,
        "annotations": "annotations.tsv",
        "artifacts": {
            "frustration_per_residue": artifact_entry(
                "frustration_per_residue.tsv", frustration_per_residue
            ),
            "structure_index": artifact_entry("structure_index.json", structure_index),
            "provenance": artifact_entry("provenance.json", frustration_provenance),
            "native_output_dir": {"path": "native_output"},
        },
        "file_integrity": {
            "provenance.json": artifact_entry("provenance.json", frustration_provenance),
            "annotations": artifact_entry("annotations.tsv", frustration_annotations),
        },
    }
    manifest_path = f"{frustration_result_dir}/result_manifest.json"
    files = {
        f"runs/{primary_id}/run_context.json": json.dumps(primary).encode(),
        f"runs/{sibling_id}/run_context.json": json.dumps(sibling).encode(),
        manifest_path: json.dumps(frustration_manifest).encode(),
        f"{frustration_result_dir}/annotations.tsv": frustration_annotations,
        f"{frustration_result_dir}/frustration_per_residue.tsv": frustration_per_residue,
        f"{frustration_result_dir}/structure_index.json": structure_index,
        f"{frustration_result_dir}/provenance.json": frustration_provenance,
    }

    def inspector_factory(settings):
        return InMemoryReadOnlyInspector(
            files,
            max_entries=settings.mn5_max_entries,
            max_preview_bytes=max(settings.mn5_max_preview_bytes, settings.mn5_max_artifact_bytes),
        )

    monkeypatch.setattr(tracking_module, "build_read_only_inspector", inspector_factory)
    settings = Settings(
        app_env="test",
        mn5_external_sync_interval_seconds=15,
        mn5_external_sync_batch_size=10,
        mn5_external_sync_parallelism=2,
        mn5_max_entries=20,
        mn5_max_preview_bytes=64_000,
        mn5_max_artifact_bytes=1024 * 1024,
        artifact_root=tmp_path / "artifacts",
    )

    assert tracking_module.sync_due_external_snapshots(session, settings) == 1

    session.refresh(run)
    session.refresh(tracking)
    stages = {stage.stage_id: stage for stage in run.stages}
    assert set(run.configuration.selected_stage_ids) == {
        "protein_identity",
        "structure_modeling",
        "structural_frustration",
        "sequence_frustration",
    }
    assert stages["protein_identity"].status == RunStageStatus.SUCCESS
    assert stages["structure_modeling"].status == RunStageStatus.SUCCESS
    assert stages["structure_modeling"].cache_key == "a" * 64
    assert stages["structure_modeling"].stage_result_id == model_result.id
    assert session.query(Artifact).filter_by(stage_result_id=model_result.id).count() == 1
    assert stages["structural_frustration"].status == RunStageStatus.SUCCESS
    assert stages["sequence_frustration"].status == RunStageStatus.SUCCESS
    assert run.status == RunStatus.SUCCESS
    assert tracking.connection_status == "connected"
    assert tracking.sync_error_code == "result_publication_pending"
    assert tracking.next_sync_at is not None

    tracking.next_sync_at = datetime.now(UTC) - timedelta(seconds=1)
    tracking.last_attempt_at = None
    session.commit()
    assert tracking_module.sync_due_external_runs(session, settings) == 1
    session.refresh(run)
    session.refresh(tracking)
    stages = {stage.stage_id: stage for stage in run.stages}
    assert stages["structural_frustration"].status == RunStageStatus.SUCCESS
    assert stages["sequence_frustration"].status == RunStageStatus.SUCCESS
    assert run.status == RunStatus.SUCCESS
    assert tracking.connection_status == "connected"
    assert tracking.published_cache_keys["structural_frustration"] == frustration_cache_key
    frustration_result = session.get(StageResult, stages["structural_frustration"].stage_result_id)
    assert frustration_result is not None
    assert {artifact.artifact_type for artifact in frustration_result.artifacts} >= {
        "annotations",
        "frustration_per_residue",
        "structure_index",
    }
    frustration_rows = session.execute(
        select(ANNOTATION_TABLES["structural_frustration"].c["values"]).where(
            ANNOTATION_TABLES["structural_frustration"].c.stage_result_id == frustration_result.id
        )
    ).all()
    assert (
        frustration_rows[0]._mapping["values"]["structural_frustration_fi_singleresidue"] == "-1.2"
    )


def test_snapshot_only_worker_never_claims_or_submits_scientific_stages(session, monkeypatch):
    called = False

    def sync_snapshots(_session, _settings):
        nonlocal called
        called = True
        return 1

    monkeypatch.setattr(
        worker_service_module,
        "get_settings",
        lambda: Settings(app_env="test", mn5_external_snapshot_only=True),
    )
    monkeypatch.setattr(tracking_module, "sync_due_external_snapshots", sync_snapshots)

    class ForbiddenExecutor:
        def execute(self, *_args):
            raise AssertionError("snapshot-only worker attempted scientific execution")

    assert process_one(session, ForbiddenExecutor()) is True
    assert called


def test_snapshot_rechecks_terminal_run_without_consuming_publication_turn(
    session,
    monkeypatch,
):
    sequence = "ACDEFGHIK"
    protein = Protein(
        sequence_sha256=hashlib.sha256(sequence.encode("ascii")).hexdigest(),
        sequence=sequence,
        length=len(sequence),
        owner_id="terminal-snapshot-user",
        project_id="project-one",
    )
    session.add(protein)
    session.flush()
    run = Run(
        protein_id=protein.id,
        owner_id=protein.owner_id,
        project_id=protein.project_id,
        status=RunStatus.SUCCESS,
        is_external_import=True,
    )
    run.configuration = RunConfiguration(
        protein_id=protein.id,
        sequence_sha256=protein.sequence_sha256,
        structure_source="alphafold3",
        structure_mapping={},
        normalized_variants=[],
        selected_stage_ids=["protein_identity"],
        omitted_stages=[],
        scientific_parameters={},
        prerequisites={},
        versions={},
        input_references={},
        owner_id=run.owner_id,
        project_id=run.project_id,
    )
    run.stages.append(RunStage(stage_id="protein_identity", status=RunStageStatus.SUCCESS))
    tracking = ExternalRunTracking(
        run_id=run.id,
        source="mn5",
        remote_run_id="P11712_terminal_snapshot_20261025T010203000001Z",
        remote_path="runs/P11712_terminal_snapshot_20261025T010203000001Z",
        run_type="mutant",
        base_protein_id=protein.id,
        accession="P11712",
        variant="A1V",
        display_name="P11712-A1V",
        next_sync_at=datetime.now(UTC) - timedelta(seconds=1),
    )
    run.external_tracking = tracking
    session.add(run)
    session.commit()
    publication_due_at = tracking.next_sync_at
    context = {
        "run_id": tracking.remote_run_id,
        "input_state": {
            "run_status": "running",
            "stage_status": {"protein_identity": "success"},
        },
        "stage_results": {"protein_identity": {"status": "success"}},
    }
    observed_paths: list[str] = []

    def fetch_contexts(_settings, paths, *, on_progress=None, on_group_result=None, group_size=1):
        observed_paths.extend(paths)
        assert group_size == tracking_module._LINEAGE_CONTEXT_FETCH_GROUP_SIZE
        assert all(path.endswith("/run_context.json") for path in paths)
        if on_progress is not None:
            on_progress()
        fetched = {path: json.dumps(context).encode("utf-8") for path in paths}
        if on_group_result is not None:
            on_group_result(fetched, set())
        return fetched, set()

    monkeypatch.setattr(tracking_module, "_fetch_many", fetch_contexts)

    assert (
        tracking_module.sync_due_external_snapshots(
            session,
            Settings(app_env="test", mn5_external_sync_interval_seconds=15),
        )
        == 1
    )

    session.refresh(run)
    session.refresh(tracking)
    assert observed_paths == [f"{tracking.remote_path}/run_context.json"]
    assert run.status == RunStatus.RUNNING
    assert tracking.claim_token is None
    assert tracking.next_sync_at.replace(tzinfo=UTC) > publication_due_at
    assert tracking.last_synced_at is not None
    assert session.query(StageResult).filter_by(protein_id=protein.id).count() == 0

    run.status = RunStatus.SUCCESS
    tracking.last_attempt_at = datetime.now(UTC) - timedelta(seconds=60)
    tracking.next_sync_at = datetime.now(UTC) - timedelta(seconds=60)
    session.commit()
    assert (
        tracking_module.sync_due_external_snapshots(
            session,
            Settings(app_env="test", mn5_external_sync_interval_seconds=15),
        )
        == 1
    )
    session.refresh(run)
    assert observed_paths == [
        f"{tracking.remote_path}/run_context.json",
        f"{tracking.remote_path}/run_context.json",
    ]
    assert run.status == RunStatus.RUNNING


def test_external_sync_publishes_valid_stage_when_sibling_result_path_is_invalid(
    session,
    monkeypatch,
    tmp_path,
):
    sequence = "V"
    user = User(
        email="publication@example.test", password_hash="test-hash", project_id="project-one"
    )
    protein = Protein(
        sequence_sha256=hashlib.sha256(sequence.encode("ascii")).hexdigest(),
        sequence=sequence,
        length=len(sequence),
        owner_id="publication-user",
        project_id="project-one",
    )
    session.add_all([user, protein])
    session.flush()
    run = Run(
        protein_id=protein.id,
        owner_id=protein.owner_id,
        project_id=protein.project_id,
        status=RunStatus.RUNNING,
        is_external_import=True,
    )
    run.configuration = RunConfiguration(
        protein_id=protein.id,
        sequence_sha256=protein.sequence_sha256,
        structure_source="alphafold3",
        structure_mapping={},
        normalized_variants=[],
        selected_stage_ids=["protein_identity", "protein_relaxation_energy"],
        omitted_stages=[],
        scientific_parameters={},
        prerequisites={},
        versions={},
        input_references={},
        owner_id=run.owner_id,
        project_id=run.project_id,
    )
    run.stages.extend(
        [
            RunStage(stage_id="protein_identity", status=RunStageStatus.PENDING),
            RunStage(stage_id="protein_relaxation_energy", status=RunStageStatus.PENDING),
        ]
    )
    session.add(run)
    session.flush()
    tracking = ExternalRunTracking(
        run_id=run.id,
        source="mn5",
        remote_run_id="P11712_publication_20261025T010203000001Z",
        remote_path="runs/P11712_publication_20261025T010203000001Z",
        run_type="mutant",
        base_protein_id=protein.id,
        accession="P11712",
        variant="A1V",
        display_name="P11712-A1V",
        next_sync_at=datetime.now(UTC) - timedelta(seconds=1),
    )
    run.external_tracking = tracking
    session.commit()

    cache_key = "b" * 64
    result_dir = f"results/protein_relaxation_energy/{cache_key}"
    annotations = (
        b"protein_id\taa_position\taa_ref\trosetta_relaxation_status\t"
        b"foldx_relaxation_status\trosetta_energy_value\tfoldx_energy_value\n"
        b"P11712\t1\tV\tsuccess\tsuccess\t-1.2\t-3.4\n"
    )
    remote_payloads = {
        f"{result_dir}/annotations.tsv": annotations,
        f"{result_dir}/structure_mapping.tsv": b"mapping\n",
        f"{result_dir}/selected_reference.pdb": b"ATOM reference\n",
        f"{result_dir}/selected_reference.json": b"{}\n",
        f"{result_dir}/provenance.json": b"{}\n",
        f"{result_dir}/foldx/relaxed.pdb": b"ATOM relaxed\n",
    }

    def artifact_entry(path, payload):
        return {
            "path": path,
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        }

    manifest = {
        "schema": "stage-result-v1",
        "stage_id": "protein_relaxation_energy",
        "status": "success",
        "partial": True,
        "cache_key": cache_key,
        "annotations": "annotations.tsv",
        "artifacts": {
            "selected_reference_pdb": artifact_entry("selected_reference.pdb", b"ATOM reference\n"),
            "selected_reference_json": artifact_entry("selected_reference.json", b"{}\n"),
            "provenance": artifact_entry("provenance.json", b"{}\n"),
            "foldx_relaxed_pdb": artifact_entry("foldx/relaxed.pdb", b"ATOM relaxed\n"),
        },
        "file_integrity": {
            "provenance.json": artifact_entry("provenance.json", b"{}\n"),
            "annotations": artifact_entry("annotations.tsv", annotations),
        },
    }
    context = {
        "run_id": tracking.remote_run_id,
        "input_state": {
            "stage_status": {
                "protein_identity": "success",
                "protein_relaxation_energy": "success",
            }
        },
        "stage_results": {
            "protein_identity": {
                "status": "success",
                "cache_key": "a" * 64,
                "result_dir": "runs/unrelated-run/results",
            },
            "protein_relaxation_energy": {
                "status": "success",
                "cache_key": cache_key,
                "result_dir": result_dir,
            },
        },
    }
    manifest_path = f"{result_dir}/result_manifest.json"
    observer_factory = sessionmaker(bind=session.get_bind(), expire_on_commit=False)
    relaxed_visible_before_all_files_finish = False

    def fetch_campaign_group(_settings, items, _limit=None):
        fetched = {}
        for _, path in items:
            if path.endswith("/run_context.json"):
                fetched[path] = json.dumps(context).encode()
            elif path == manifest_path:
                fetched[path] = json.dumps(manifest).encode()
            elif path in remote_payloads:
                fetched[path] = remote_payloads[path]
        return fetched, None

    real_fetch_many = tracking_module._fetch_many

    def fetch_many_with_artifact_observer(
        fetch_settings,
        paths,
        *,
        limit=None,
        on_progress=None,
        on_group_result=None,
        group_size=1,
    ):
        def observe_group(fetched, failed):
            nonlocal relaxed_visible_before_all_files_finish
            if on_group_result is not None:
                on_group_result(fetched, failed)
            if not any(path.endswith("foldx/relaxed.pdb") for path in fetched):
                return
            with observer_factory() as observer:
                relaxed_artifact = (
                    observer.query(Artifact).filter_by(artifact_type="foldx_relaxed_pdb").first()
                )
                assert relaxed_artifact is not None
            relaxed_visible_before_all_files_finish = True

        return real_fetch_many(
            fetch_settings,
            paths,
            limit=limit,
            on_progress=on_progress,
            on_group_result=observe_group if on_group_result is not None else None,
            group_size=group_size,
        )

    monkeypatch.setattr(tracking_module, "_fetch_group", fetch_campaign_group)
    monkeypatch.setattr(tracking_module, "_fetch_many", fetch_many_with_artifact_observer)
    settings = Settings(
        app_env="test",
        artifact_root=tmp_path / "artifacts",
        mn5_max_preview_bytes=2_097_152,
        mn5_external_sync_parallelism=2,
    )

    assert tracking_module.sync_due_external_runs(session, settings) == 1

    assert run.status == RunStatus.SUCCESS
    assert {stage.stage_id: stage.status for stage in run.stages} == {
        "protein_identity": RunStageStatus.SUCCESS,
        "protein_relaxation_energy": RunStageStatus.SUCCESS,
    }
    assert relaxed_visible_before_all_files_finish
    assert tracking.published_cache_keys == {}
    assert tracking.sync_error_code == "result_publication_pending"
    relaxed_stage = next(
        stage for stage in run.stages if stage.stage_id == "protein_relaxation_energy"
    )
    artifacts = (
        session.query(Artifact).filter_by(stage_result_id=relaxed_stage.stage_result_id).all()
    )
    assert {artifact.artifact_type for artifact in artifacts} >= {
        "selected_reference_pdb",
        "foldx_relaxed_pdb",
    }


def test_external_publication_cursor_reaches_third_stage_when_first_two_are_incomplete(
    session,
    monkeypatch,
    tmp_path,
):
    sequence = "A"
    user = User(email="rotation@example.test", password_hash="test-hash", project_id="project-one")
    protein = Protein(
        sequence_sha256=hashlib.sha256(sequence.encode("ascii")).hexdigest(),
        sequence=sequence,
        length=len(sequence),
        owner_id="rotation-user",
        project_id="project-one",
    )
    session.add_all([user, protein])
    session.flush()
    run = Run(
        protein_id=protein.id,
        owner_id=protein.owner_id,
        project_id=protein.project_id,
        status=RunStatus.PENDING,
        is_external_import=True,
    )
    run.configuration = RunConfiguration(
        protein_id=protein.id,
        sequence_sha256=protein.sequence_sha256,
        structure_source="alphafold3",
        structure_mapping={},
        normalized_variants=[],
        selected_stage_ids=[
            "protein_relaxation_energy",
            "structure_modeling",
            "variant_ddg",
        ],
        omitted_stages=[],
        scientific_parameters={},
        prerequisites={},
        versions={},
        input_references={},
        owner_id=run.owner_id,
        project_id=run.project_id,
    )
    run.stages.extend(
        [
            RunStage(stage_id="protein_relaxation_energy", status=RunStageStatus.PENDING),
            RunStage(stage_id="structure_modeling", status=RunStageStatus.PENDING),
            RunStage(stage_id="variant_ddg", status=RunStageStatus.PENDING),
        ]
    )
    session.add(run)
    session.flush()
    tracking = ExternalRunTracking(
        run_id=run.id,
        source="mn5",
        remote_run_id="P11712_rotation_20261025T010203000001Z",
        remote_path="runs/P11712_rotation_20261025T010203000001Z",
        run_type="ddg",
        base_protein_id=protein.id,
        accession="P11712",
        variant="A1V",
        display_name="P11712-DDG-A1V",
        next_sync_at=datetime.now(UTC) - timedelta(seconds=1),
    )
    run.external_tracking = tracking
    session.commit()

    relax_key = "a" * 64
    model_key = "b" * 64
    ddg_key = "c" * 64
    result_dirs = {
        "protein_relaxation_energy": f"results/protein_relaxation_energy/{relax_key}",
        "structure_modeling": f"results/structure_modeling/{model_key}",
        "variant_ddg": f"results/variant_ddg/{ddg_key}",
    }
    context = {
        "run_id": tracking.remote_run_id,
        "input_state": {
            "stage_status": {
                "protein_relaxation_energy": "success",
                "structure_modeling": "success",
                "variant_ddg": "success",
            }
        },
        "stage_results": {
            "protein_relaxation_energy": {
                "status": "success",
                "cache_key": relax_key,
                "result_dir": result_dirs["protein_relaxation_energy"],
            },
            "structure_modeling": {
                "status": "success",
                "cache_key": model_key,
                "result_dir": result_dirs["structure_modeling"],
            },
            "variant_ddg": {
                "status": "success",
                "cache_key": ddg_key,
                "result_dir": result_dirs["variant_ddg"],
            },
        },
    }
    incomplete_manifest = json.dumps({"schema": "incomplete"}).encode()
    annotation_payload = (
        b"protein_id\taa_position\taa_ref\tddg_variant_evaluated\nP11712\t1\tA\ttrue\n"
    )
    variant_payload = (
        b"protein_id\taa_position\taa_ref\taa_alt\tddg_value\nP11712\t1\tA\tV\t-1.25\n"
    )
    ddg_payloads = {
        f"{result_dirs['variant_ddg']}/annotations.tsv": annotation_payload,
        f"{result_dirs['variant_ddg']}/variant_annotations.tsv": variant_payload,
        f"{result_dirs['variant_ddg']}/ddg_replicates.tsv": b"replicate\tddg\n1\t-1.2\n",
        f"{result_dirs['variant_ddg']}/provenance.json": b"{}\n",
        f"{result_dirs['variant_ddg']}/rosetta_metadata.json": b"{}\n",
        f"{result_dirs['variant_ddg']}/variant_set.json": b"{}\n",
    }

    def entry(relative_path, payload):
        return {
            "path": relative_path,
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        }

    ddg_manifest = {
        "schema": "stage-result-v1",
        "stage_id": "variant_ddg",
        "status": "success",
        "partial": False,
        "cache_key": ddg_key,
        "annotations": "annotations.tsv",
        "artifacts": {
            "variant_annotations": entry(
                "variant_annotations.tsv",
                ddg_payloads[f"{result_dirs['variant_ddg']}/variant_annotations.tsv"],
            ),
            "ddg_replicates": entry(
                "ddg_replicates.tsv",
                ddg_payloads[f"{result_dirs['variant_ddg']}/ddg_replicates.tsv"],
            ),
            "provenance": entry("provenance.json", b"{}\n"),
            "variant_dir": {"path": "variants", "size": None, "sha256": None},
            "rosetta_metadata": entry("rosetta_metadata.json", b"{}\n"),
            "variant_set": entry("variant_set.json", b"{}\n"),
        },
        "file_integrity": {
            "provenance.json": entry("provenance.json", b"{}\n"),
            "annotations": entry("annotations.tsv", annotation_payload),
        },
    }
    manifest_paths = {
        stage_id: f"{result_dir}/result_manifest.json"
        for stage_id, result_dir in result_dirs.items()
    }

    def fetch_rotating_publications(
        _settings, paths, *, limit=None, on_progress=None, on_group_result=None, group_size=1
    ):
        if on_progress is not None:
            on_progress()
        fetched = {}
        for path in paths:
            if path.endswith("/run_context.json"):
                fetched[path] = json.dumps(context).encode()
            elif path == manifest_paths["variant_ddg"]:
                fetched[path] = json.dumps(ddg_manifest).encode()
            elif path in {
                manifest_paths["protein_relaxation_energy"],
                manifest_paths["structure_modeling"],
            }:
                fetched[path] = incomplete_manifest
            elif path in ddg_payloads:
                fetched[path] = ddg_payloads[path]
        return fetched, set()

    monkeypatch.setattr(tracking_module, "_fetch_many", fetch_rotating_publications)
    settings = Settings(
        app_env="test",
        artifact_root=tmp_path / "artifacts",
        mn5_max_preview_bytes=2_097_152,
        mn5_external_sync_parallelism=2,
    )

    assert tracking_module.sync_due_external_runs(session, settings) == 1
    assert tracking.publication_cursor == 1
    assert tracking.published_cache_keys == {}

    session.refresh(tracking)
    tracking.next_sync_at = datetime.now(UTC) - timedelta(seconds=1)
    session.commit()
    assert tracking_module.sync_due_external_runs(session, settings) == 1

    assert tracking.publication_cursor == 2
    assert tracking.published_cache_keys == {"variant_ddg": ddg_key}
    assert tracking.sync_error_code == "result_publication_pending"
    ddg_stage = next(stage for stage in run.stages if stage.stage_id == "variant_ddg")
    artifacts = session.query(Artifact).filter_by(stage_result_id=ddg_stage.stage_result_id).all()
    assert "variant_annotations" in {artifact.artifact_type for artifact in artifacts}


def test_external_snapshot_keeps_ddg_results_active_while_later_stage_runs():
    now = datetime.now(UTC)
    tracking = SimpleNamespace(
        remote_run_id="expected-run",
        published_cache_keys={},
        next_sync_at=None,
        last_synced_at=None,
        last_attempt_at=None,
        connection_status="unavailable",
        sync_error_code="mn5_unavailable",
    )
    configuration = SimpleNamespace(selected_stage_ids=["variant_ddg", "protein_relaxation_energy"])
    ddg = SimpleNamespace(
        stage_id="variant_ddg",
        status=RunStageStatus.RUNNING,
        cache_key=None,
        error_code=None,
        error_message=None,
        started_at=None,
        finished_at=None,
    )
    later = SimpleNamespace(
        stage_id="protein_relaxation_energy",
        status=RunStageStatus.RUNNING,
        cache_key=None,
        error_code=None,
        error_message=None,
        started_at=now,
        finished_at=None,
    )
    run = SimpleNamespace(
        configuration=configuration,
        stages=[ddg, later],
        status=RunStatus.RUNNING,
        error_code=None,
        error_message=None,
        started_at=now,
        finished_at=None,
    )

    _apply_snapshot(
        tracking,
        run,
        {
            "run_id": "expected-run",
            "input_state": {
                "stage_status": {
                    "variant_ddg": "success",
                    "protein_relaxation_energy": "running",
                }
            },
            "stage_results": {"variant_ddg": {"status": "success", "cache_key": "a" * 64}},
        },
        now=now,
        interval_seconds=15,
    )

    assert ddg.status == RunStageStatus.SUCCESS
    assert ddg.cache_key == "a" * 64
    assert run.status == RunStatus.RUNNING
    assert tracking.next_sync_at == now + timedelta(seconds=15)
    assert tracking.connection_status == "connected"


def test_external_snapshot_preserves_remote_running_state_after_observed_stages_finish():
    now = datetime.now(UTC)
    selected = ["protein_identity", "uniprot_features"]
    tracking = SimpleNamespace(
        remote_run_id="expected-run",
        published_cache_keys={},
        next_sync_at=None,
        last_synced_at=None,
        last_attempt_at=None,
        connection_status="connected",
        sync_error_code=None,
    )
    stages = [
        SimpleNamespace(
            stage_id=stage_id,
            status=RunStageStatus.SUCCESS,
            cache_key=None,
            error_code=None,
            error_message=None,
            started_at=now,
            finished_at=now,
        )
        for stage_id in selected
    ]
    run = SimpleNamespace(
        configuration=SimpleNamespace(selected_stage_ids=selected.copy()),
        stages=stages,
        status=RunStatus.SUCCESS,
        error_code=None,
        error_message=None,
        started_at=now,
        finished_at=now,
    )

    _apply_snapshot(
        tracking,
        run,
        {
            "run_id": "expected-run",
            "input_state": {
                "run_status": "running",
                "stage_status": {stage_id: "success" for stage_id in selected},
            },
            "stage_results": {},
        },
        now=now,
        interval_seconds=15,
    )

    assert all(stage.status == RunStageStatus.SUCCESS for stage in stages)
    assert run.status == RunStatus.RUNNING
    assert run.finished_at is None
    assert tracking.next_sync_at == now + timedelta(seconds=15)


def test_terminal_external_snapshot_missing_selected_stage_keeps_tracking_active():
    now = datetime.now(UTC)
    tracking = SimpleNamespace(
        remote_run_id="expected-run",
        published_cache_keys={},
        next_sync_at=None,
        last_synced_at=None,
        last_attempt_at=None,
        connection_status="connected",
        sync_error_code=None,
    )
    configuration = SimpleNamespace(selected_stage_ids=["protein_identity", "structure_modeling"])
    stages = [
        SimpleNamespace(
            stage_id=stage_id,
            status=RunStageStatus.SUCCESS,
            cache_key=None,
            error_code=None,
            error_message=None,
            started_at=now,
            finished_at=now,
        )
        for stage_id in configuration.selected_stage_ids
    ]
    run = SimpleNamespace(
        configuration=configuration,
        stages=stages,
        status=RunStatus.SUCCESS,
        error_code=None,
        error_message=None,
        started_at=now,
        finished_at=now,
    )
    context = {
        "run_id": "expected-run",
        "input_state": {"stage_status": {"protein_identity": "success"}},
        "stage_results": {},
    }

    _apply_snapshot(tracking, run, context, now=now, interval_seconds=15)

    assert _has_missing_selected_stage_status(run, context)
    assert _should_continue_external_sync(run, context, pending_publications=False)
    assert run.status == RunStatus.PENDING
    assert stages[1].status == RunStageStatus.SUCCESS
    assert tracking.next_sync_at == now + timedelta(seconds=15)


def test_terminal_external_run_waits_for_a_late_stage_cache_key():
    tracking = SimpleNamespace(published_cache_keys={})
    run = SimpleNamespace(
        configuration=SimpleNamespace(selected_stage_ids=["variant_ddg"]),
    )
    context = {
        "input_state": {"stage_status": {"variant_ddg": "success"}},
        "stage_results": {},
    }

    assert _has_pending_result_publications(tracking, run, context)


def test_terminal_external_snapshot_keeps_pending_result_publication_visible():
    now = datetime(2026, 10, 27, 12, 0, tzinfo=UTC)
    cache_key = "a" * 64
    tracking = SimpleNamespace(
        remote_run_id="expected-run",
        published_cache_keys={},
        next_sync_at=None,
        last_synced_at=None,
        last_attempt_at=None,
        connection_status="connected",
        sync_error_code=None,
    )
    stage = SimpleNamespace(
        stage_id="variant_ddg",
        status=RunStageStatus.PENDING,
        cache_key=None,
        error_code=None,
        error_message=None,
        started_at=None,
        finished_at=None,
    )
    run = SimpleNamespace(
        configuration=SimpleNamespace(selected_stage_ids=["variant_ddg"]),
        stages=[stage],
        status=RunStatus.PENDING,
        error_code=None,
        error_message=None,
        started_at=None,
        finished_at=None,
    )
    context = {
        "run_id": "expected-run",
        "input_state": {
            "run_status": "success",
            "stage_status": {"variant_ddg": "success"},
        },
        "stage_results": {"variant_ddg": {"status": "success", "cache_key": cache_key}},
    }

    _apply_snapshot(run=run, tracking=tracking, context=context, now=now, interval_seconds=15)

    assert run.status == RunStatus.SUCCESS
    assert tracking.next_sync_at == now + timedelta(seconds=15)
    assert tracking.sync_error_code == "result_publication_pending"

    tracking.published_cache_keys = {"variant_ddg": cache_key}
    _apply_snapshot(
        run=run,
        tracking=tracking,
        context=context,
        now=now + timedelta(seconds=15),
        interval_seconds=15,
    )

    assert tracking.next_sync_at is None
    assert tracking.sync_error_code is None


def test_expired_worker_claim_cannot_apply_after_another_worker_reclaimed(session):
    sequence = "ACDEFGHIK"
    protein = Protein(
        sequence_sha256=hashlib.sha256(sequence.encode("ascii")).hexdigest(),
        sequence=sequence,
        length=len(sequence),
        owner_id="owner-one",
        project_id="project-one",
    )
    session.add(protein)
    session.flush()
    run = Run(
        protein_id=protein.id,
        owner_id=protein.owner_id,
        project_id=protein.project_id,
        is_external_import=True,
    )
    session.add(run)
    session.flush()
    tracking = ExternalRunTracking(
        run_id=run.id,
        source="mn5",
        remote_run_id="remote-run",
        remote_path="runs/remote-run",
        run_type="mutant",
        base_protein_id=protein.id,
        accession="P11712",
        variant="A1V",
        display_name="P11712-A1V",
        claim_token="new-claim",
        claim_expires_at=datetime.now(UTC) + timedelta(minutes=1),
    )
    session.add(tracking)
    session.flush()

    assert _load_claimed_tracking(session, tracking.id, "old-claim") is None
    assert _load_claimed_tracking(session, tracking.id, "new-claim") is tracking


def test_campaign_inventory_validates_mutant_sequence_and_expected_variant_sets(monkeypatch):
    monkeypatch.setattr(campaign, "CAMPAIGN_SPECS", {"P11712": ("CYP2C9", 1)})
    base = "ACDEFGHIK"
    mutant = "VCDEFGHIK"
    ddg_id = "P11712_abc123_20261025T010203000001Z"
    mutant_id = "P11712_def456_20261025T010204000001Z"
    ddg = _context(
        ddg_id,
        base,
        "VCDEFGHIK",
        {"variant_ddg": "success"},
        variant=("A", 1, "V"),
    )
    mutant_context = _context(
        mutant_id,
        base,
        mutant,
        {"protein_identity": "success", "uniprot_features": "success"},
        variant=("A", 1, "V"),
    )
    ddg_cache_key = "a" * 64
    ddg_result_dir = f"results/variant_ddg/{ddg_cache_key}"
    ddg_payload = b"protein_id\taa_position\taa_ref\taa_alt\tddg_value\nP11712\t1\tA\tV\t-1.25\n"
    ddg["stage_results"]["variant_ddg"].update(
        cache_key=ddg_cache_key,
        result_dir=ddg_result_dir,
    )
    manifest = {
        "schema": "stage-result-v1",
        "stage_id": "variant_ddg",
        "status": "success",
        "partial": False,
        "cache_key": ddg_cache_key,
        "annotations": "annotations.tsv",
        "artifacts": {
            "variant_annotations": {
                "path": "variant_annotations.tsv",
                "size": len(ddg_payload),
                "sha256": hashlib.sha256(ddg_payload).hexdigest(),
            }
        },
        "file_integrity": {
            "provenance.json": {"size": 1, "sha256": "b" * 64},
            "annotations": {"size": 1, "sha256": "c" * 64},
        },
    }
    files = {
        f"runs/{ddg_id}/run_context.json": json.dumps(ddg).encode(),
        f"runs/{mutant_id}/run_context.json": json.dumps(mutant_context).encode(),
        f"{ddg_result_dir}/result_manifest.json": json.dumps(manifest).encode(),
        f"{ddg_result_dir}/variant_annotations.tsv": ddg_payload,
    }
    settings = Settings(
        app_env="test",
        mn5_max_entries=10,
        mn5_max_preview_bytes=64_000,
        mn5_external_sync_parallelism=2,
    )
    inventory = campaign.scan_campaign_inventory(
        settings,
        inspector_factory=lambda _: InMemoryReadOnlyInspector(
            files, max_entries=10, max_preview_bytes=64_000
        ),
    )

    assert inventory.ready
    assert {item.run_type for item in inventory.selected} == {"ddg", "mutant"}
    assert next(item for item in inventory.selected if item.run_type == "mutant").sequence == mutant
    assert inventory.report["actual_type_counts"]["ddg"] == 1
    assert inventory.report["actual_type_counts"]["mutant"] == 1
    assert next(item for item in inventory.selected if item.run_type == "ddg").sequence == base
    assert inventory.report["runs"][0]["ddg_result_verified"]


def test_variant_ddg_manifest_exposes_only_integrity_verified_exports():
    cache_key = "a" * 64
    settings = Settings(app_env="test", mn5_max_preview_bytes=64_000)
    manifest = {
        "schema": "stage-result-v1",
        "stage_id": "variant_ddg",
        "status": "success",
        "partial": False,
        "cache_key": cache_key,
        "annotations": "annotations.tsv",
        "artifacts": {
            "variant_annotations": {
                "path": "variant_annotations.tsv",
                "size": 3,
                "sha256": "b" * 64,
            },
            "ddg_replicates": {
                "path": "ddg_replicates.tsv",
                "size": 4,
                "sha256": "c" * 64,
            },
            "provenance": {"path": "provenance.json", "size": 5, "sha256": "d" * 64},
            "variant_dir": {"path": "variants", "size": None, "sha256": None},
            "rosetta_metadata": {
                "path": "rosetta_metadata.json",
                "size": 6,
                "sha256": "7" * 64,
            },
            "variant_set": {"path": "variant_set.json", "size": 7, "sha256": "8" * 64},
        },
        "file_integrity": {
            "provenance.json": {"size": 5, "sha256": "e" * 64},
            "annotations": {"size": 6, "sha256": "f" * 64},
        },
    }

    specs, complete = _manifest_artifact_specs(
        manifest,
        stage_id="variant_ddg",
        cache_key=cache_key,
        result_dir=f"results/variant_ddg/{cache_key}",
        settings=settings,
    )

    assert complete
    assert {spec["artifact_type"] for spec in specs} == {
        "annotations",
        "provenance",
        "rosetta_metadata",
        "variant_annotations",
        "variant_set",
        "ddg_replicates",
    }
    assert all(
        str(spec["remote_path"]).startswith(f"results/variant_ddg/{cache_key}/") for spec in specs
    )


def test_external_structure_manifest_exposes_model_and_relaxed_pdb_artifacts():
    cache_key = "a" * 64
    settings = Settings(app_env="test", mn5_max_preview_bytes=2_097_152)
    artifacts = {
        "selected_reference_pdb": ("selected_reference.pdb", 971_086, "b" * 64),
        "rosettamp_relaxed_pdb": ("rosettamp/relaxed.pdb", 971_086, "c" * 64),
        "foldx_relaxed_pdb": ("foldx/relaxed.pdb", 349_097, "d" * 64),
        "selected_reference_json": ("selected_reference.json", 1_150, "e" * 64),
        "structure_mapping": ("structure_mapping.tsv", 18_431, "f" * 64),
        "provenance": ("provenance.json", 9_416, "1" * 64),
    }
    manifest = {
        "schema": "stage-result-v1",
        "stage_id": "protein_relaxation_energy",
        "status": "success",
        "partial": False,
        "cache_key": cache_key,
        "annotations": "annotations.tsv",
        "artifacts": {
            name: {"path": path, "size": size, "sha256": digest}
            for name, (path, size, digest) in artifacts.items()
        },
        "file_integrity": {
            "provenance.json": {"size": 9_416, "sha256": "2" * 64},
            "annotations": {"size": 20, "sha256": "3" * 64},
        },
    }

    specs, complete = _manifest_artifact_specs(
        manifest,
        stage_id="protein_relaxation_energy",
        cache_key=cache_key,
        result_dir=f"results/protein_relaxation_energy/{cache_key}",
        settings=settings,
    )

    assert complete
    assert {spec["artifact_type"] for spec in specs} == {
        "annotations",
        "selected_reference_pdb",
        "rosettamp_relaxed_pdb",
        "foldx_relaxed_pdb",
        "selected_reference_json",
        "structure_mapping",
        "provenance",
    }
    assert max(spec["size"] for spec in specs) == 971_086

    manifest["artifacts"]["variant_annotations"] = {
        "path": "variant_annotations.tsv",
        "size": 8,
        "sha256": "9" * 64,
    }
    with pytest.raises(ManifestError, match="assigned to another stage"):
        _manifest_artifact_specs(
            manifest,
            stage_id="protein_relaxation_energy",
            cache_key=cache_key,
            result_dir=f"results/protein_relaxation_energy/{cache_key}",
            settings=settings,
        )

    manifest["artifacts"].pop("variant_annotations")
    manifest["artifacts"]["annotations"] = {
        "path": "annotations.tsv",
        "size": 8,
        "sha256": "9" * 64,
    }
    with pytest.raises(ManifestError, match="separate manifest annotations field"):
        _manifest_artifact_specs(
            manifest,
            stage_id="protein_relaxation_energy",
            cache_key=cache_key,
            result_dir=f"results/protein_relaxation_energy/{cache_key}",
            settings=settings,
        )


def test_arpeggio_manifest_accepts_a_bounded_file_larger_than_the_preview_limit():
    cache_key = "a" * 64
    settings = Settings(
        app_env="test",
        mn5_max_preview_bytes=2_097_152,
        mn5_max_artifact_bytes=32 * 1024 * 1024,
    )
    artifacts = {
        "contact_residue_summary": ("contacts.tsv", 37_740, "b" * 64),
        "contacts_long": ("contacts_long.tsv", 189_863, "c" * 64),
        "structure_index": ("structure_index.tsv", 1_295, "d" * 64),
        "provenance": ("provenance.json", 8_350, "e" * 64),
        "arpeggio_json": ("arpeggio.json", 12_589_498, "f" * 64),
        "arpeggio_log": ("arpeggio.log", 1_921, "1" * 64),
    }
    manifest = {
        "schema": "stage-result-v1",
        "stage_id": "structural_contacts",
        "status": "success",
        "partial": False,
        "cache_key": cache_key,
        "annotations": "annotations.tsv",
        "artifacts": {
            name: {"path": path, "size": size, "sha256": digest}
            for name, (path, size, digest) in artifacts.items()
        },
        "file_integrity": {
            "provenance.json": {"size": 8_350, "sha256": "2" * 64},
            "annotations": {"size": 23_207, "sha256": "3" * 64},
        },
    }

    specs, complete = _manifest_artifact_specs(
        manifest,
        stage_id="structural_contacts",
        cache_key=cache_key,
        result_dir=f"results/structural_contacts/{cache_key}",
        settings=settings,
    )

    assert complete
    arpeggio = next(spec for spec in specs if spec["artifact_type"] == "arpeggio_json")
    assert arpeggio["size"] == 12_589_498

    manifest["artifacts"]["arpeggio_json"].pop("sha256")
    specs, complete = _manifest_artifact_specs(
        manifest,
        stage_id="structural_contacts",
        cache_key=cache_key,
        result_dir=f"results/structural_contacts/{cache_key}",
        settings=settings,
    )

    assert complete
    arpeggio = next(spec for spec in specs if spec["artifact_type"] == "arpeggio_json")
    assert arpeggio["sha256"] is None

    settings.mn5_max_artifact_bytes = 8 * 1024 * 1024
    specs, complete = _manifest_artifact_specs(
        manifest,
        stage_id="structural_contacts",
        cache_key=cache_key,
        result_dir=f"results/structural_contacts/{cache_key}",
        settings=settings,
    )

    assert not complete
    assert "arpeggio_json" not in {spec["artifact_type"] for spec in specs}


def test_external_manifest_stays_incomplete_when_a_required_stage_artifact_is_missing():
    cache_key = "a" * 64
    settings = Settings(app_env="test", mn5_max_preview_bytes=2_097_152)
    manifest = {
        "schema": "stage-result-v1",
        "stage_id": "structure_modeling",
        "status": "success",
        "partial": False,
        "cache_key": cache_key,
        "annotations": "annotations.tsv",
        "artifacts": {
            "model_cif": {"path": "model.cif", "size": 3, "sha256": "b" * 64},
        },
        "file_integrity": {
            "provenance.json": {"size": 1, "sha256": "c" * 64},
            "annotations": {"size": 1, "sha256": "d" * 64},
        },
    }

    _, complete = _manifest_artifact_specs(
        manifest,
        stage_id="structure_modeling",
        cache_key=cache_key,
        result_dir=f"results/structure_modeling/{cache_key}",
        settings=settings,
    )

    assert not complete


def test_campaign_inventory_rejects_equal_counts_with_different_variant_sets(monkeypatch):
    monkeypatch.setattr(campaign, "CAMPAIGN_SPECS", {"P11712": ("CYP2C9", 1)})
    base = "ACDEFGHIK"
    ddg_id = "P11712_abc123_20261025T010203000001Z"
    mutant_id = "P11712_def456_20261025T010204000001Z"
    ddg = _context(ddg_id, base, base, {"variant_ddg": "success"}, variant=("A", 1, "V"))
    mutant = _context(
        mutant_id,
        base,
        "AVDEFGHIK",
        {"protein_identity": "success", "uniprot_features": "success"},
        variant=("C", 2, "V"),
    )
    files = {
        f"runs/{ddg_id}/run_context.json": json.dumps(ddg).encode(),
        f"runs/{mutant_id}/run_context.json": json.dumps(mutant).encode(),
    }
    settings = Settings(
        app_env="test",
        mn5_max_entries=10,
        mn5_max_preview_bytes=64_000,
        mn5_external_sync_parallelism=2,
    )
    inventory = campaign.scan_campaign_inventory(
        settings,
        inspector_factory=lambda _: InMemoryReadOnlyInspector(
            files, max_entries=10, max_preview_bytes=64_000
        ),
    )

    assert inventory.report["actual_by_accession"]["P11712"]["ddg"] == 1
    assert inventory.report["actual_by_accession"]["P11712"]["mutant"] == 1
    assert not inventory.ready
    assert inventory.report["variant_set_mismatches"] == [
        {
            "accession": "P11712",
            "ddg_without_mutant": ["A1V"],
            "mutant_without_ddg": ["C2V"],
        }
    ]


def test_campaign_inventory_classifies_only_unexecuted_context_matching_selected_variant(
    monkeypatch,
):
    monkeypatch.setattr(campaign, "CAMPAIGN_SPECS", {"P11712": ("CYP2C9", 1)})
    base = "ACDEFGHIK"
    ddg_id = "P11712_ddg001_20261025T010203000001Z"
    mutant_id = "P11712_mut001_20261025T010204000001Z"
    context_id = "P11712_ctx001_20261025T010205000001Z"
    ddg = _context(ddg_id, base, base, {"variant_ddg": "running"}, variant=("A", 1, "V"))
    mutant = _context(
        mutant_id,
        base,
        "VCDEFGHIK",
        {"protein_identity": "running"},
        variant=("A", 1, "V"),
    )
    context_without_snapshot = _context(
        context_id,
        base,
        "VCDEFGHIK",
        {},
        variant=("A", 1, "V"),
    )
    context_without_snapshot["input_state"]["run_status"] = None
    context_without_snapshot["stage_results"] = {}
    settings = Settings(app_env="test", mn5_max_entries=10, mn5_max_preview_bytes=64_000)
    context_without_snapshot["input_references"] = {
        "fasta_path": f"{settings.mn5_root}/uploads/Q8NBP7__A1V.fasta",
        "resource_path": f"{settings.mn5_root}/cache/identity/protein.fasta",
    }
    files = {
        f"runs/{ddg_id}/run_context.json": json.dumps(ddg).encode(),
        f"runs/{mutant_id}/run_context.json": json.dumps(mutant).encode(),
        f"runs/{context_id}/run_context.json": json.dumps(context_without_snapshot).encode(),
    }

    inventory = campaign.scan_campaign_inventory(
        settings,
        inspector_factory=lambda _: InMemoryReadOnlyInspector(
            files, max_entries=10, max_preview_bytes=64_000
        ),
    )

    assert inventory.ready
    assert inventory.report["actual_type_counts"]["ddg"] == 1
    assert inventory.report["actual_type_counts"]["mutant"] == 1
    assert inventory.report["unexecuted_context_count"] == 1
    issue = next(
        issue
        for issue in inventory.report["issues"]
        if issue["code"] == "stage_snapshot_unavailable"
    )
    assert issue["classification"] == "same_variant_context_without_execution_snapshot"
    assert issue["duplicate_of_remote_run_id"] == mutant_id
    assert issue["remote_job_ids"] == []
    assert issue["stage_result_ids"] == []
    assert issue["published_paths"] == []


def test_published_result_paths_excludes_input_and_preparation_references():
    root = "/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion"
    context = {
        "input_references": {"path": f"{root}/uploads/input.fasta"},
        "preparation": {"resource_path": f"{root}/cache/reference.fasta"},
        "stage_results": {
            "protein_identity": {"result_dir": f"{root}/results/protein_identity/{'a' * 64}"}
        },
    }

    assert campaign._published_result_paths(context, root) == {
        f"results/protein_identity/{'a' * 64}"
    }


def test_campaign_inventory_blocks_unmatched_or_executed_context_without_snapshot(monkeypatch):
    monkeypatch.setattr(campaign, "CAMPAIGN_SPECS", {"P11712": ("CYP2C9", 1)})
    base = "ACDEFGHIK"
    ddg_id = "P11712_ddg001_20261025T010203000001Z"
    mutant_id = "P11712_mut001_20261025T010204000001Z"
    extra_id = "P11712_extra1_20261025T010205000001Z"
    ddg = _context(ddg_id, base, base, {"variant_ddg": "running"}, variant=("A", 1, "V"))
    mutant = _context(
        mutant_id,
        base,
        "VCDEFGHIK",
        {"protein_identity": "running"},
        variant=("A", 1, "V"),
    )
    unmatched = _context(extra_id, base, "AVDEFGHIK", {}, variant=("C", 2, "V"))
    unmatched["input_state"]["run_status"] = None
    unmatched["stage_results"] = {}
    files = {
        f"runs/{ddg_id}/run_context.json": json.dumps(ddg).encode(),
        f"runs/{mutant_id}/run_context.json": json.dumps(mutant).encode(),
        f"runs/{extra_id}/run_context.json": json.dumps(unmatched).encode(),
    }
    inventory = campaign.scan_campaign_inventory(
        Settings(app_env="test", mn5_max_entries=10, mn5_max_preview_bytes=64_000),
        inspector_factory=lambda _: InMemoryReadOnlyInspector(
            files, max_entries=10, max_preview_bytes=64_000
        ),
    )

    assert not inventory.ready
    issue = next(
        issue
        for issue in inventory.report["issues"]
        if issue["code"] == "stage_snapshot_unavailable"
    )
    assert issue["variant"] == "C2V"
    assert "classification" not in issue

    executed_context = _context(extra_id, base, "VCDEFGHIK", {}, variant=("A", 1, "V"))
    executed_context["input_state"]["run_status"] = None
    executed_context["slurm_job_id"] = "not-a-numeric-id"
    executed_context["stage_results"] = {}
    files[f"runs/{extra_id}/run_context.json"] = json.dumps(executed_context).encode()
    inventory_with_job_reference = campaign.scan_campaign_inventory(
        Settings(app_env="test", mn5_max_entries=10, mn5_max_preview_bytes=64_000),
        inspector_factory=lambda _: InMemoryReadOnlyInspector(
            files, max_entries=10, max_preview_bytes=64_000
        ),
    )
    assert not inventory_with_job_reference.ready
    issue_with_job = next(
        issue
        for issue in inventory_with_job_reference.report["issues"]
        if issue["code"] == "stage_snapshot_unavailable" and issue["remote_run_id"] == extra_id
    )
    assert "classification" not in issue_with_job
    assert issue_with_job["job_reference_present"]


def test_contextless_scaffold_requires_exact_preexecution_layout():
    run_path = "runs/Q8NBP7_scaffold_20261025T141954641348Z"
    directories = [
        f"{run_path}/logs",
        f"{run_path}/stages",
        f"{run_path}/orchestration",
        f"{run_path}/generated",
    ]
    files = {
        f"{run_path}/orchestration/coordinate_mapping.tsv": b"coordinate\n",
        f"{run_path}/orchestration/scaffold.tsv": b"scaffold\n",
        f"{run_path}/orchestration/pharmacogenomics_resource_lock.json": b"{}",
        f"{run_path}/orchestration/unmapped_pdb_residues.tsv": b"residue\n",
    }
    inspector = InMemoryReadOnlyInspector(files, directory_paths=directories)

    classification = campaign._classify_contextless_scaffold(inspector, run_path)

    assert classification == {
        "classification": "preexecution_scaffold",
        "evidence": {
            "run_context": "missing",
            "top_level_directories": ["generated", "logs", "orchestration", "stages"],
            "empty_directories": {"generated": [], "logs": [], "stages": []},
            "orchestration_files": [
                "coordinate_mapping.tsv",
                "pharmacogenomics_resource_lock.json",
                "scaffold.tsv",
                "unmapped_pdb_residues.tsv",
            ],
        },
    }

    unexpected_files = {
        **files,
        f"{run_path}/orchestration/unknown-output.tsv": b"data\n",
    }
    unexpected_inspector = InMemoryReadOnlyInspector(unexpected_files, directory_paths=directories)
    assert campaign._classify_contextless_scaffold(unexpected_inspector, run_path) is None


def test_campaign_inventory_rejects_full_length_ddg_query_with_an_unrelated_mutation(
    monkeypatch,
):
    monkeypatch.setattr(campaign, "CAMPAIGN_SPECS", {"P11712": ("CYP2C9", 1)})
    base = "ACDEFGHIK"
    run_id = "P11712_abc123_20261025T010203000001Z"
    context = _context(
        run_id,
        base,
        "AVDEFGHIK",  # C2V is unrelated to the declared A1V DDG.
        {"variant_ddg": "running"},
        variant=("A", 1, "V"),
    )
    inventory = campaign.scan_campaign_inventory(
        Settings(app_env="test", mn5_max_entries=10),
        inspector_factory=lambda settings: InMemoryReadOnlyInspector(
            {f"runs/{run_id}/run_context.json": json.dumps(context).encode()},
            max_entries=10,
            max_preview_bytes=settings.mn5_max_preview_bytes,
        ),
    )

    assert inventory.selected == ()
    assert any(
        issue["code"] == "ddg_query_variant_mismatch" for issue in inventory.report["issues"]
    )


def test_ddg_query_accepts_only_exact_structure_subsequences_that_cover_the_variant_site():
    reference = "ACDEFGHIK"

    assert (
        campaign._ddg_query_sequence_relation("CDEFGH", reference, "F5V")
        == "structure_derived_base"
    )
    assert campaign._ddg_query_sequence_relation("CDEAGH", reference, "F5V") is None


def test_variantless_ugt_run_keeps_query_sequence_consistent_with_its_protein(session, monkeypatch):
    monkeypatch.setattr(campaign, "CAMPAIGN_SPECS", {"P22309": ("UGT1A1", 0)})
    user = User(email="jccpyt@gmail.com", password_hash="test-hash", project_id="project-one")
    session.add(user)
    session.flush()
    reference = "ACDEFGHIK"
    query = "ACDEFGHI"
    context = _context(
        "P22309_base_20261026T010203000001Z",
        reference,
        query,
        {"protein_identity": "success"},
    )
    candidate = Candidate(
        accession="P22309",
        run_type="base",
        variant=None,
        remote_run_id=context["run_id"],
        remote_path=f"runs/{context['run_id']}",
        sequence=query,
        base_sequence=reference,
        context=context,
        stage_ids=("protein_identity",),
        score=(0, 1, 4, "20261026010203000001"),
    )
    inventory = CampaignInventory(report={"ready_to_apply": True}, selected=(candidate,))

    campaign.apply_campaign_inventory(
        session,
        inventory,
        user.email,
        settings=Settings(app_env="test"),
    )
    session.flush()
    run = session.query(Run).one()
    tracking = session.query(ExternalRunTracking).one()

    assert run.configuration.sequence_sha256 == run.protein.sequence_sha256
    assert run.protein.length == len(query)
    assert run.protein_id != tracking.base_protein_id


def test_external_stage_artifact_repairs_a_corrupt_blob_and_is_stage_linked(session, tmp_path):
    sequence = "ACDEFGHIK"
    protein = Protein(
        sequence_sha256=hashlib.sha256(sequence.encode("ascii")).hexdigest(),
        sequence=sequence,
        length=len(sequence),
        owner_id="owner-one",
        project_id="project-one",
    )
    session.add(protein)
    session.flush()
    run = Run(
        protein_id=protein.id,
        owner_id=protein.owner_id,
        project_id=protein.project_id,
        is_external_import=True,
    )
    session.add(run)
    session.flush()
    stage = RunStage(
        run_id=run.id,
        stage_id="variant_ddg",
        status=RunStageStatus.SUCCESS,
        cache_key="a" * 64,
    )
    run.stages.append(stage)
    session.flush()
    tracking = SimpleNamespace(remote_run_id="remote-run")
    stage_result = _ensure_stage_result(
        session,
        run,
        tracking,
        "variant_ddg",
        "a" * 64,
        source_remote_run_id="source-run",
    )
    assert stage_result is not None
    assert stage_result.provenance["external_run_id"] == "source-run"
    session.flush()

    settings = Settings(app_env="test", artifact_root=tmp_path)
    store = ArtifactStore(settings)
    payload = b"verified"
    digest = hashlib.sha256(payload).hexdigest()
    spec = {
        "artifact_type": "variant_annotations",
        "remote_path": "results/variant_ddg/cache/variant_annotations.tsv",
        "size": len(payload),
        "sha256": digest,
    }
    storage_key = tracking_module._storage_key(
        protein.id,
        "variant_ddg",
        "a" * 64,
        "variant_annotations",
        "variant_annotations.tsv",
    )
    session.add(
        Artifact(
            stage_result_id=stage_result.id,
            artifact_type="variant_annotations",
            storage_backend="filesystem",
            storage_key=storage_key,
            sha256=digest,
            size=len(payload),
            media_type="text/tab-separated-values",
        )
    )
    session.flush()
    corrupt_path = store.resolve(storage_key)
    corrupt_path.parent.mkdir(parents=True, exist_ok=True)
    corrupt_path.write_bytes(b"corrupt!")

    assert _persist_artifact(
        session,
        store,
        run,
        stage_result=stage_result,
        stage_id="variant_ddg",
        cache_key="a" * 64,
        spec=spec,
        payload=payload,
    )

    assert store.metadata(storage_key) == (len(payload), digest)
    assert stage.stage_result_id == stage_result.id
    assert not run.run_artifacts


def test_large_unhashed_external_artifact_is_published_with_a_computed_digest(session, tmp_path):
    sequence = "ACDEFGHIK"
    protein = Protein(
        sequence_sha256=hashlib.sha256(sequence.encode("ascii")).hexdigest(),
        sequence=sequence,
        length=len(sequence),
        owner_id="owner-one",
        project_id="project-one",
    )
    session.add(protein)
    session.flush()
    run = Run(
        protein_id=protein.id,
        owner_id=protein.owner_id,
        project_id=protein.project_id,
        is_external_import=True,
    )
    session.add(run)
    session.flush()
    stage = RunStage(
        run_id=run.id,
        stage_id="structural_contacts",
        status=RunStageStatus.SUCCESS,
        cache_key="b" * 64,
    )
    run.stages.append(stage)
    session.flush()
    tracking = SimpleNamespace(
        remote_run_id="P11712_large_arpeggio",
        run_type="base",
        variant=None,
        accession="P11712",
    )
    stage_result = _ensure_stage_result(
        session,
        run,
        tracking,
        "structural_contacts",
        "b" * 64,
    )
    assert stage_result is not None
    payload = b"x" * (tracking_module.REMOTE_HASH_MAX_BYTES + 1)
    settings = Settings(app_env="test", artifact_root=tmp_path)
    store = ArtifactStore(settings)
    spec = {
        "artifact_type": "arpeggio_json",
        "remote_path": "runs/P11712_large_arpeggio/arpeggio/input_clean.json",
        "size": len(payload),
        "sha256": None,
    }

    assert tracking_module._persist_verified_external_artifact(
        session,
        store,
        run,
        tracking,
        stage_result=stage_result,
        stage_id="structural_contacts",
        cache_key="b" * 64,
        spec=spec,
        payload=payload,
    )

    artifact = session.scalar(select(Artifact).where(Artifact.stage_result_id == stage_result.id))
    expected_digest = hashlib.sha256(payload).hexdigest()
    assert artifact is not None
    assert artifact.artifact_type == "arpeggio_json"
    assert artifact.size == len(payload)
    assert artifact.sha256 == expected_digest
    assert store.metadata(artifact.storage_key) == (len(payload), expected_digest)


def test_gzip_contacts_artifact_uses_gzip_media_type_and_repairs_existing_metadata(
    session, tmp_path
):
    sequence = "ACDEFGHIK"
    protein = Protein(
        sequence_sha256=hashlib.sha256(sequence.encode("ascii")).hexdigest(),
        sequence=sequence,
        length=len(sequence),
        owner_id="owner-one",
        project_id="project-one",
    )
    session.add(protein)
    session.flush()
    run = Run(
        protein_id=protein.id,
        owner_id=protein.owner_id,
        project_id=protein.project_id,
        is_external_import=True,
    )
    session.add(run)
    session.flush()
    stage = RunStage(
        run_id=run.id,
        stage_id="structural_contacts",
        status=RunStageStatus.SUCCESS,
        cache_key="c" * 64,
    )
    run.stages.append(stage)
    session.flush()
    stage_result = _ensure_stage_result(
        session,
        run,
        SimpleNamespace(remote_run_id="remote-run"),
        "structural_contacts",
        "c" * 64,
    )
    assert stage_result is not None
    session.flush()

    store = ArtifactStore(Settings(app_env="test", artifact_root=tmp_path))
    payload = gzip.compress(
        b"aa_position_1\taa_position_2\tinteraction_type\tdistance_A\n4\t6\tpolar\t3.46\n"
    )
    digest = hashlib.sha256(payload).hexdigest()
    spec = {
        "artifact_type": "contacts_long",
        "remote_path": "results/structural_contacts/cache/contacts_long.tsv.gz",
        "size": len(payload),
        "sha256": digest,
    }

    assert _persist_artifact(
        session,
        store,
        run,
        stage_result=stage_result,
        stage_id="structural_contacts",
        cache_key="c" * 64,
        spec=spec,
        payload=payload,
    )
    artifact = session.scalar(
        select(Artifact).where(Artifact.storage_key.endswith("contacts_long.tsv.gz"))
    )
    assert artifact is not None
    assert artifact.media_type == "application/gzip"

    artifact.media_type = "text/tab-separated-values"
    artifact_path = store.resolve(artifact.storage_key)
    artifact_path.write_bytes(b"corrupt")
    session.flush()

    assert _persist_artifact(
        session,
        store,
        run,
        stage_result=stage_result,
        stage_id="structural_contacts",
        cache_key="c" * 64,
        spec=spec,
        payload=payload,
    )
    assert artifact.media_type == "application/gzip"
    assert store.metadata(artifact.storage_key) == (len(payload), digest)


def test_shared_external_stage_artifact_is_attached_once_for_two_runs(session, tmp_path):
    sequence = "ACDEFGHIK"
    protein = Protein(
        sequence_sha256=hashlib.sha256(sequence.encode("ascii")).hexdigest(),
        sequence=sequence,
        length=len(sequence),
        owner_id="owner-one",
        project_id="project-one",
    )
    session.add(protein)
    session.flush()
    stage_result = StageResult(
        protein_id=protein.id,
        stage_id="protein_identity",
        cache_key="a" * 64,
        status=RunStageStatus.SUCCESS,
        provenance={},
        owner_id=protein.owner_id,
        project_id=protein.project_id,
    )
    session.add(stage_result)
    session.flush()
    payload = b"shared external publication\n"
    spec = {
        "artifact_type": "summary",
        "remote_path": f"results/protein_identity/{'a' * 64}/summary.txt",
        "size": len(payload),
        "sha256": None,
    }
    store = ArtifactStore(Settings(app_env="test", artifact_root=tmp_path / "artifacts"))
    first_run = SimpleNamespace(protein_id=protein.id)
    second_run = SimpleNamespace(protein_id=protein.id)

    assert _persist_artifact(
        session,
        store,
        first_run,
        stage_result=stage_result,
        stage_id="protein_identity",
        cache_key="a" * 64,
        spec=spec,
        payload=payload,
    )
    assert _persist_artifact(
        session,
        store,
        second_run,
        stage_result=stage_result,
        stage_id="protein_identity",
        cache_key="a" * 64,
        spec=spec,
        payload=payload,
    )
    session.flush()

    artifacts = session.query(Artifact).filter_by(stage_result_id=stage_result.id).all()
    assert len(artifacts) == 1
    assert artifacts[0].sha256 == hashlib.sha256(payload).hexdigest()


def test_semantically_invalid_annotation_is_not_published_as_an_artifact(monkeypatch):
    persisted: list[object] = []
    monkeypatch.setattr(
        tracking_module,
        "_insert_verified_annotations",
        lambda *args, **kwargs: False,
    )
    monkeypatch.setattr(
        tracking_module,
        "_persist_artifact",
        lambda *args, **kwargs: persisted.append(kwargs.get("spec")) or True,
    )

    payload = b"invalid\tannotation\n"
    result = tracking_module._persist_verified_external_artifact(
        None,
        None,
        None,
        None,
        stage_result=None,
        stage_id="protein_identity",
        cache_key="a" * 64,
        spec={
            "artifact_type": "annotations",
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        },
        payload=payload,
    )

    assert not result
    assert persisted == []


def test_mutant_annotations_accept_and_align_only_the_declared_reference_residue(session):
    base_sequence = "ACDE"
    mutant_sequence = "VCDE"
    base = Protein(
        sequence_sha256=hashlib.sha256(base_sequence.encode("ascii")).hexdigest(),
        sequence=base_sequence,
        length=len(base_sequence),
        owner_id="owner-one",
        project_id="project-one",
    )
    mutant = Protein(
        sequence_sha256=hashlib.sha256(mutant_sequence.encode("ascii")).hexdigest(),
        sequence=mutant_sequence,
        length=len(mutant_sequence),
        owner_id="owner-one",
        project_id="project-one",
    )
    session.add_all([base, mutant])
    session.flush()
    run = Run(
        protein=mutant,
        owner_id="owner-one",
        project_id="project-one",
        status=RunStatus.SUCCESS,
        is_external_import=True,
        requested_variants=[],
    )
    tracking = ExternalRunTracking(
        source="mn5",
        remote_run_id="P11712_A1V",
        remote_path="runs/P11712_A1V",
        run_type="mutant",
        base_protein_id=base.id,
        accession="P11712",
        variant="A1V",
        display_name="P11712-A1V",
        connection_status="connected",
    )
    run.external_tracking = tracking
    stage_result = StageResult(
        protein_id=mutant.id,
        stage_id="protein_identity",
        cache_key="a" * 64,
        status=RunStageStatus.SUCCESS,
        provenance={},
        owner_id="owner-one",
        project_id="project-one",
    )
    session.add_all([run, stage_result])
    session.flush()
    payload = b"protein_id\tgene\taa_position\taa_ref\nP11712\tCYP2C9\t1\tA\nP11712\tCYP2C9\t2\tC\n"

    assert tracking_module._insert_verified_annotations(
        session, run, tracking, stage_result, "protein_identity", payload
    )

    rows = session.execute(
        select(
            ANNOTATION_TABLES["protein_identity"].c.aa_position,
            ANNOTATION_TABLES["protein_identity"].c.aa_ref,
            ANNOTATION_TABLES["protein_identity"].c.source_row,
        )
        .where(ANNOTATION_TABLES["protein_identity"].c.stage_result_id == stage_result.id)
        .order_by(ANNOTATION_TABLES["protein_identity"].c.aa_position)
    ).all()
    assert [(row.aa_position, row.aa_ref) for row in rows] == [(1, "V"), (2, "C")]
    assert rows[0].source_row == "P11712\tCYP2C9\t1\tA"


def test_mutant_annotations_reject_unrelated_sequence_mismatch(session):
    base_sequence = "ACDE"
    mutant_sequence = "VCDE"
    base = Protein(
        sequence_sha256=hashlib.sha256(base_sequence.encode("ascii")).hexdigest(),
        sequence=base_sequence,
        length=len(base_sequence),
        owner_id="owner-one",
        project_id="project-one",
    )
    mutant = Protein(
        sequence_sha256=hashlib.sha256(mutant_sequence.encode("ascii")).hexdigest(),
        sequence=mutant_sequence,
        length=len(mutant_sequence),
        owner_id="owner-one",
        project_id="project-one",
    )
    session.add_all([base, mutant])
    session.flush()
    run = Run(
        protein=mutant,
        owner_id="owner-one",
        project_id="project-one",
        status=RunStatus.SUCCESS,
        is_external_import=True,
        requested_variants=[],
    )
    tracking = ExternalRunTracking(
        source="mn5",
        remote_run_id="P11712_A1V",
        remote_path="runs/P11712_A1V",
        run_type="mutant",
        base_protein_id=base.id,
        accession="P11712",
        variant="A1V",
        display_name="P11712-A1V",
        connection_status="connected",
    )
    run.external_tracking = tracking
    stage_result = StageResult(
        protein_id=mutant.id,
        stage_id="protein_identity",
        cache_key="a" * 64,
        status=RunStageStatus.SUCCESS,
        provenance={},
        owner_id="owner-one",
        project_id="project-one",
    )
    session.add_all([run, stage_result])
    session.flush()
    payload = b"protein_id\tgene\taa_position\taa_ref\nP11712\tCYP2C9\t1\tA\nP11712\tCYP2C9\t2\tY\n"

    assert not tracking_module._insert_verified_annotations(
        session, run, tracking, stage_result, "protein_identity", payload
    )
    assert (
        session.execute(
            select(ANNOTATION_TABLES["protein_identity"].c.id).where(
                ANNOTATION_TABLES["protein_identity"].c.stage_result_id == stage_result.id
            )
        ).all()
        == []
    )


def test_base_annotations_map_a_unique_canonical_subsequence_to_query_positions(session):
    canonical_sequence = "ACDEFGHIKLMNPQRSTVWY"
    query_sequence = canonical_sequence[4:]
    base = Protein(
        sequence_sha256=hashlib.sha256(canonical_sequence.encode("ascii")).hexdigest(),
        sequence=canonical_sequence,
        length=len(canonical_sequence),
        owner_id="owner-one",
        project_id="project-one",
    )
    query = Protein(
        sequence_sha256=hashlib.sha256(query_sequence.encode("ascii")).hexdigest(),
        sequence=query_sequence,
        length=len(query_sequence),
        owner_id="owner-one",
        project_id="project-one",
    )
    session.add_all([base, query])
    session.flush()
    run = Run(
        protein=query,
        owner_id="owner-one",
        project_id="project-one",
        status=RunStatus.SUCCESS,
        is_external_import=True,
        requested_variants=[],
    )
    tracking = ExternalRunTracking(
        source="mn5",
        remote_run_id="P22309_base_20261026T151950000001Z",
        remote_path="runs/P22309_base_20261026T151950000001Z",
        run_type="base",
        base_protein_id=base.id,
        accession="P22309",
        variant=None,
        display_name="P22309",
        connection_status="connected",
    )
    run.external_tracking = tracking
    stage_result = StageResult(
        protein_id=query.id,
        stage_id="protein_identity",
        cache_key="a" * 64,
        status=RunStageStatus.SUCCESS,
        provenance={},
        owner_id="owner-one",
        project_id="project-one",
    )
    session.add_all([run, stage_result])
    session.flush()
    annotations = ANNOTATION_TABLES["protein_identity"]
    session.execute(
        annotations.insert().values(
            id="stale-unmapped-annotation",
            stage_result_id=stage_result.id,
            aa_position=1,
            aa_ref="D",
            values={"gene": "UGT1A1"},
            units={},
            qc_status="verified",
            source_row="stale canonical position",
        )
    )
    payload = (
        b"protein_id\tgene\taa_position\taa_ref\n"
        b"P22309\tUGT1A1\t1\tA\n"
        b"P22309\tUGT1A1\t5\tF\n"
        b"P22309\tUGT1A1\t20\tY\n"
    )

    assert tracking_module._insert_verified_annotations(
        session,
        run,
        tracking,
        stage_result,
        "protein_identity",
        payload,
        reference_sequence=canonical_sequence,
    )

    rows = session.execute(
        select(
            ANNOTATION_TABLES["protein_identity"].c.aa_position,
            ANNOTATION_TABLES["protein_identity"].c.aa_ref,
            ANNOTATION_TABLES["protein_identity"].c.source_row,
        )
        .where(ANNOTATION_TABLES["protein_identity"].c.stage_result_id == stage_result.id)
        .order_by(ANNOTATION_TABLES["protein_identity"].c.aa_position)
    ).all()
    assert [(row.aa_position, row.aa_ref) for row in rows] == [(1, "F"), (16, "Y")]
    assert rows[0].source_row == "P22309\tUGT1A1\t5\tF"


def test_base_annotations_reject_ambiguous_canonical_subsequence(session):
    canonical_sequence = "ACAC"
    query_sequence = "AC"
    base = Protein(
        sequence_sha256=hashlib.sha256(canonical_sequence.encode("ascii")).hexdigest(),
        sequence=canonical_sequence,
        length=len(canonical_sequence),
        owner_id="owner-one",
        project_id="project-one",
    )
    query = Protein(
        sequence_sha256=hashlib.sha256(query_sequence.encode("ascii")).hexdigest(),
        sequence=query_sequence,
        length=len(query_sequence),
        owner_id="owner-one",
        project_id="project-one",
    )
    session.add_all([base, query])
    session.flush()
    run = Run(
        protein=query,
        owner_id="owner-one",
        project_id="project-one",
        status=RunStatus.SUCCESS,
        is_external_import=True,
        requested_variants=[],
    )
    tracking = ExternalRunTracking(
        source="mn5",
        remote_run_id="P22309_ambiguous_20261026T151950000001Z",
        remote_path="runs/P22309_ambiguous_20261026T151950000001Z",
        run_type="base",
        base_protein_id=base.id,
        accession="P22309",
        variant=None,
        display_name="P22309",
        connection_status="connected",
    )
    run.external_tracking = tracking
    stage_result = StageResult(
        protein_id=query.id,
        stage_id="protein_identity",
        cache_key="b" * 64,
        status=RunStageStatus.SUCCESS,
        provenance={},
        owner_id="owner-one",
        project_id="project-one",
    )
    session.add_all([run, stage_result])
    session.flush()
    payload = b"protein_id\tgene\taa_position\taa_ref\nP22309\tUGT1A1\t1\tA\n"

    assert not tracking_module._insert_verified_annotations(
        session,
        run,
        tracking,
        stage_result,
        "protein_identity",
        payload,
        reference_sequence=canonical_sequence,
    )
    annotations = ANNOTATION_TABLES["protein_identity"]
    assert (
        session.execute(
            select(annotations.c.id).where(annotations.c.stage_result_id == stage_result.id)
        ).all()
        == []
    )


def test_base_annotations_accept_valid_rows_outside_the_query_subsequence(session):
    canonical_sequence = "ACDE"
    query_sequence = canonical_sequence[2:]
    base = Protein(
        sequence_sha256=hashlib.sha256(canonical_sequence.encode("ascii")).hexdigest(),
        sequence=canonical_sequence,
        length=len(canonical_sequence),
        owner_id="owner-one",
        project_id="project-one",
    )
    query = Protein(
        sequence_sha256=hashlib.sha256(query_sequence.encode("ascii")).hexdigest(),
        sequence=query_sequence,
        length=len(query_sequence),
        owner_id="owner-one",
        project_id="project-one",
    )
    session.add_all([base, query])
    session.flush()
    run = Run(
        protein=query,
        owner_id="owner-one",
        project_id="project-one",
        status=RunStatus.SUCCESS,
        is_external_import=True,
        requested_variants=[],
    )
    tracking = ExternalRunTracking(
        source="mn5",
        remote_run_id="P22309_prefix_only_20261026T151950000001Z",
        remote_path="runs/P22309_prefix_only_20261026T151950000001Z",
        run_type="base",
        base_protein_id=base.id,
        accession="P22309",
        variant=None,
        display_name="P22309",
        connection_status="connected",
    )
    run.external_tracking = tracking
    stage_result = StageResult(
        protein_id=query.id,
        stage_id="protein_identity",
        cache_key="c" * 64,
        status=RunStageStatus.SUCCESS,
        provenance={},
        owner_id="owner-one",
        project_id="project-one",
    )
    session.add_all([run, stage_result])
    session.flush()
    annotations = ANNOTATION_TABLES["protein_identity"]
    session.execute(
        annotations.insert().values(
            id="stale-prefix-annotation",
            stage_result_id=stage_result.id,
            aa_position=1,
            aa_ref="D",
            values={"gene": "UGT1A1"},
            units={},
            qc_status="verified",
            source_row="stale query position",
        )
    )
    payload = b"protein_id\tgene\taa_position\taa_ref\nP22309\tUGT1A1\t1\tA\nP22309\tUGT1A1\t2\tC\n"

    assert tracking_module._insert_verified_annotations(
        session,
        run,
        tracking,
        stage_result,
        "protein_identity",
        payload,
        reference_sequence=canonical_sequence,
    )
    assert (
        session.execute(
            select(annotations.c.id).where(annotations.c.stage_result_id == stage_result.id)
        ).all()
        == []
    )


def test_annotation_payload_hash_is_checked_before_ingestion(monkeypatch):
    inserted: list[bool] = []
    monkeypatch.setattr(
        tracking_module,
        "_insert_verified_annotations",
        lambda *args: inserted.append(True) or True,
    )

    result = tracking_module._persist_verified_external_artifact(
        None,
        None,
        None,
        None,
        stage_result=None,
        stage_id="protein_identity",
        cache_key="a" * 64,
        spec={"artifact_type": "annotations", "size": 1, "sha256": "0" * 64},
        payload=b"tampered",
    )

    assert not result
    assert inserted == []


def test_structural_contacts_annotations_accept_the_published_mn5_columns(session):
    sequence = "ACD"
    protein = Protein(
        sequence_sha256=hashlib.sha256(sequence.encode("ascii")).hexdigest(),
        sequence=sequence,
        length=len(sequence),
        owner_id="owner-one",
        project_id="project-one",
    )
    session.add(protein)
    session.flush()
    run = Run(
        protein=protein,
        owner_id=protein.owner_id,
        project_id=protein.project_id,
        status=RunStatus.SUCCESS,
        is_external_import=True,
        requested_variants=[],
    )
    tracking = ExternalRunTracking(
        source="mn5",
        remote_run_id="P11712_contacts",
        remote_path="runs/P11712_contacts",
        run_type="base",
        base_protein_id=protein.id,
        accession="P11712",
        variant=None,
        display_name="P11712",
        connection_status="connected",
    )
    run.external_tracking = tracking
    stage_result = StageResult(
        protein_id=protein.id,
        stage_id="structural_contacts",
        cache_key="d" * 64,
        status=RunStageStatus.SUCCESS,
        provenance={},
        owner_id=protein.owner_id,
        project_id=protein.project_id,
    )
    session.add_all([run, stage_result])
    session.flush()
    payload = (
        b"protein_id\taa_position\taa_ref\tstructural_contacts_n_contacts\t"
        b"structural_contacts_n_partner_residues\tstructural_contacts_contact_types\n"
        b"P11712\t1\tA\t2\t1\tHBOND\n"
        b"P11712\t2\tC\t0\t0\tNA\n"
        b"P11712\t3\tD\t1\t1\tHYDROGEN\n"
    )

    assert tracking_module._insert_verified_annotations(
        session,
        run,
        tracking,
        stage_result,
        "structural_contacts",
        payload,
        reference_sequence=sequence,
    )

    table = ANNOTATION_TABLES["structural_contacts"]
    rows = session.execute(
        select(table.c.aa_position, table.c.aa_ref, table.c["values"])
        .where(table.c.stage_result_id == stage_result.id)
        .order_by(table.c.aa_position)
    ).all()
    assert len(rows) == 3
    assert rows[0].aa_ref == "A"
    assert rows[0]._mapping["values"]["structural_contacts_n_contacts"] == "2"
    assert "structural_contacts_status" not in rows[0]._mapping["values"]


def test_campaign_import_is_idempotent_and_keeps_account_ownership(session, monkeypatch):
    monkeypatch.setattr(campaign, "CAMPAIGN_SPECS", {"P11712": ("CYP2C9", 1)})
    user = User(email="jccpyt@gmail.com", password_hash="test-hash", project_id="project-one")
    other_user = User(
        email="other@example.com", password_hash="test-hash", project_id="project-two"
    )
    session.add_all([user, other_user])
    session.flush()

    base = "ACDEFGHIK"
    mutant = "VCDEFGHIK"
    base_hash = hashlib.sha256(base.encode("ascii")).hexdigest()
    now_context = _context(
        "P11712_abc123_20261025T010203000001Z",
        base,
        base,
        {"variant_ddg": "success"},
        variant=("A", 1, "V"),
    )
    mutant_context = _context(
        "P11712_def456_20261025T010204000001Z",
        base,
        mutant,
        {"protein_identity": "success", "uniprot_features": "success"},
        variant=("A", 1, "V"),
    )
    candidates = (
        Candidate(
            accession="P11712",
            run_type="ddg",
            variant="A1V",
            remote_run_id=now_context["run_id"],
            remote_path=f"runs/{now_context['run_id']}",
            sequence=base,
            base_sequence=base,
            context=now_context,
            stage_ids=("variant_ddg",),
            score=(1, 1, 1, "20261025010203000001"),
        ),
        Candidate(
            accession="P11712",
            run_type="mutant",
            variant="A1V",
            remote_run_id=mutant_context["run_id"],
            remote_path=f"runs/{mutant_context['run_id']}",
            sequence=mutant,
            base_sequence=base,
            context=mutant_context,
            stage_ids=("protein_identity", "uniprot_features"),
            score=(0, 2, 4, "20261025010204000001"),
        ),
    )
    inventory = CampaignInventory(
        report={"ready_to_apply": True},
        selected=candidates,
    )
    settings = Settings(app_env="test", artifact_root="/tmp/mn5-campaign-test-artifacts")

    first = campaign.apply_campaign_inventory(session, inventory, user.email, settings=settings)
    session.commit()
    second = campaign.apply_campaign_inventory(session, inventory, user.email, settings=settings)
    session.commit()

    assert first == {"created": 2, "updated": 0}
    assert second == {"created": 0, "updated": 2}
    assert session.query(Run).count() == 2
    assert session.query(ExternalRunTracking).count() == 2
    base_protein = session.query(Protein).filter_by(sequence_sha256=base_hash).one()
    assert base_protein.owner_id == user.id
    assert base_protein.project_id == user.project_id

    with pytest.raises(campaign.CampaignImportError, match="another account"):
        campaign.apply_campaign_inventory(session, inventory, other_user.email, settings=settings)
    session.rollback()
    assert session.query(Run).count() == 2
    assert session.query(RunConfiguration).count() == 2


def test_base_lineage_inventory_selects_reference_run_and_skips_mutant_context():
    lineage = "P02649_eddd8b84fbb0"
    base = "ACDEFGHIK"
    base_id = f"{lineage}_20261026T010203000001Z"
    mutant_id = f"{lineage}_20261026T010204000001Z"
    base_context = _context(
        base_id,
        base,
        base,
        {"protein_identity": "success", "structure_modeling": "success"},
    )
    base_context["uniprot_accession"] = "P02649"
    mutant_context = _context(
        mutant_id,
        base,
        "VCDEFGHIK",
        {"protein_identity": "success", "variant_ddg": "success"},
        variant=("A", 1, "V"),
    )
    mutant_context["uniprot_accession"] = "P02649"
    files = {
        f"runs/{base_id}/run_context.json": json.dumps(base_context).encode(),
        f"runs/{mutant_id}/run_context.json": json.dumps(mutant_context).encode(),
    }
    settings = Settings(
        app_env="test",
        mn5_max_entries=20,
        mn5_max_preview_bytes=64_000,
        mn5_max_artifact_bytes=1024 * 1024,
        mn5_external_sync_parallelism=2,
    )

    inventory = campaign.scan_base_lineage_inventory(
        settings,
        remote_run_ids=[base_id],
        inspector_factory=lambda _: InMemoryReadOnlyInspector(
            files, max_entries=20, max_preview_bytes=1024 * 1024
        ),
    )

    assert inventory.ready
    assert [item.remote_run_id for item in inventory.selected] == [base_id]
    assert inventory.selected[0].run_type == "base"
    assert inventory.report["selected_lineage_count"] == 1
    assert lineage not in inventory.report["missing_lineages"]
    selected_report = inventory.report["runs"][0]
    assert selected_report["query_matches_reference"] is True
    assert selected_report["successful_stage_count"] == 2
    assert inventory.report["requested_remote_run_ids"] == [base_id]


def test_base_lineage_inventory_accepts_verified_q8nbp7_polymer_chains():
    lineage = "Q8NBP7_7d9bc2cd32c4"
    base = "ACDEFGHIKLMNPQRSTVWY"
    query = "DEFGHIK"
    run_id = f"{lineage}_20261026T010203000001Z"
    context = _context(
        run_id,
        base,
        query,
        {"protein_identity": "success", "structural_frustration": "success"},
    )
    context["uniprot_accession"] = "Q8NBP7"
    context["input_state"].update(
        {
            "requested_pdb_chain": "A",
            "selected_pdb_chain": "A",
            "sequence_scope": "declared_polymer_chain",
            "sequence_source": "pdb_seqres",
        }
    )
    settings = Settings(
        app_env="test",
        mn5_max_entries=20,
        mn5_max_preview_bytes=64_000,
        mn5_max_artifact_bytes=1024 * 1024,
        mn5_external_sync_parallelism=2,
    )
    files = {f"runs/{run_id}/run_context.json": json.dumps(context).encode()}

    inventory = campaign.scan_base_lineage_inventory(
        settings,
        remote_run_ids=[run_id],
        inspector_factory=lambda _: InMemoryReadOnlyInspector(
            files, max_entries=20, max_preview_bytes=1024 * 1024
        ),
    )

    assert inventory.ready
    assert [candidate.remote_run_id for candidate in inventory.selected] == [run_id]
    assert inventory.selected[0].accession == "Q8NBP7"
    assert inventory.selected[0].sequence == query
    assert inventory.selected[0].base_sequence == base
    assert inventory.report["runs"][0]["query_matches_reference"] is False
    assert _is_reference_sequence_context(context, query, base)
    assert not _is_reference_sequence_context(
        {"input_state": {"sequence_scope": "declared_polymer_chain"}}, query, base
    )


def test_base_lineage_import_is_idempotent_and_scoped_to_target_project(session):
    lineage = "P01130_36a68c551082"
    run_id = f"{lineage}_20261026T010203000001Z"
    user = User(email="jccpyt@gmail.com", password_hash="test-hash", project_id="project-one")
    session.add(user)
    session.flush()
    sequence = "ACDEFGHIK"
    context = _context(
        run_id,
        sequence,
        sequence,
        {"protein_identity": "success", "structure_modeling": "success"},
    )
    context["uniprot_accession"] = "P01130"
    candidate = Candidate(
        accession="P01130",
        run_type="base",
        variant=None,
        remote_run_id=run_id,
        remote_path=f"runs/{run_id}",
        sequence=sequence,
        base_sequence=sequence,
        context=context,
        stage_ids=("protein_identity", "structure_modeling"),
        score=(2, 2, 4, "20261026010203000001"),
    )
    inventory = CampaignInventory(
        report={"ready_to_apply": True, "missing_lineages": ["another-lineage"]},
        selected=(candidate,),
    )

    first = campaign.apply_base_lineage_inventory(session, inventory, user.email)
    session.commit()
    second = campaign.apply_base_lineage_inventory(session, inventory, user.email)
    session.commit()

    run = session.query(Run).one()
    tracking = session.query(ExternalRunTracking).one()
    assert first == {"created": 1, "updated": 0}
    assert second == {"created": 0, "updated": 1}
    assert session.query(Run).count() == 1
    assert run.owner_id == user.id
    assert run.project_id == user.project_id
    assert run.remote_job_id is None
    assert run.configuration.selected_stage_ids == ["protein_identity", "structure_modeling"]
    assert tracking.remote_run_id == run_id
    assert tracking.run_type == "base"
    assert tracking.accession == "P01130"
    assert tracking.display_name == "P01130"


def test_base_lineage_preserves_conflicting_accession_when_fasta_header_verifies_identity(session):
    mature_sequence = "ACDEFGHIK"
    precursor_sequence = "MACDEFGHIK"
    mature = Protein(
        sequence_sha256=hashlib.sha256(mature_sequence.encode("ascii")).hexdigest(),
        sequence=mature_sequence,
        length=len(mature_sequence),
        owner_id="existing-owner",
        project_id="existing-project",
    )
    precursor = Protein(
        sequence_sha256=hashlib.sha256(precursor_sequence.encode("ascii")).hexdigest(),
        sequence=precursor_sequence,
        length=len(precursor_sequence),
        owner_id="campaign-owner",
        project_id="campaign-project",
    )
    session.add_all([mature, precursor])
    session.flush()
    session.add_all(
        [
            ProteinIdentifier(protein_id=mature.id, source="uniprot", identifier="P02649"),
            ProteinIdentifier(
                protein_id=precursor.id,
                source="fasta_header",
                identifier="sp|P02649|APOE_HUMAN",
            ),
        ]
    )
    session.flush()

    imported = campaign._base_protein_for(
        session,
        precursor_sequence,
        "P02649",
        "APOE",
        user_id="campaign-owner",
        project_id="campaign-project",
        settings=Settings(app_env="test", artifact_root="/tmp/mn5-campaign-test-artifacts"),
    )

    assert imported.id == precursor.id
    assert (
        session.scalar(
            select(ProteinIdentifier).where(
                ProteinIdentifier.source == "uniprot",
                ProteinIdentifier.identifier == "P02649",
            )
        ).protein_id
        == mature.id
    )
    imported_aliases = session.scalars(
        select(ProteinIdentifier).where(ProteinIdentifier.protein_id == precursor.id)
    ).all()
    assert any(
        item.source == "fasta_header" and item.identifier == "sp|P02649|APOE_HUMAN"
        for item in imported_aliases
    )


def test_worker_claims_and_lease_recovery_skip_external_runs(session):
    base = "ACDE"
    protein = Protein(
        sequence_sha256=hashlib.sha256(base.encode("ascii")).hexdigest(),
        sequence=base,
        length=len(base),
        owner_id="external-owner",
        project_id="external-project",
    )
    session.add(protein)
    session.flush()
    run = Run(
        protein=protein,
        owner_id="external-owner",
        project_id="external-project",
        status=RunStatus.PENDING,
        is_external_import=True,
        requested_variants=[],
    )
    run.configuration = RunConfiguration(
        protein_id=protein.id,
        sequence_sha256=protein.sequence_sha256,
        structure_source="alphafold3",
        structure_mapping={},
        normalized_variants=[],
        selected_stage_ids=["protein_identity"],
        omitted_stages=[],
        scientific_parameters={},
        prerequisites={},
        versions={},
        input_references={},
        owner_id=run.owner_id,
        project_id=run.project_id,
    )
    stale_stage = RunStage(
        stage_id="protein_identity",
        status=RunStageStatus.READY,
    )
    run.stages.append(stale_stage)
    session.add(run)
    session.flush()
    run.external_tracking = ExternalRunTracking(
        source="mn5",
        remote_run_id="P11712_test_20261025T010203000001Z",
        remote_path="runs/P11712_test_20261025T010203000001Z",
        run_type="mutant",
        base_protein_id=protein.id,
        accession="P11712",
        variant="A1V",
        display_name="P11712-A1V",
        connection_status="connected",
    )
    session.commit()

    settings = Settings(app_env="test", run_worker_lease_seconds=30)
    assert claim_ready_stage(session, settings) is None
    assert claim_ready_run(session, settings) is None
    run.status = RunStatus.RUNNING
    stale_stage.status = RunStageStatus.RUNNING
    stale_stage.lease_expires_at = datetime.now(UTC) - timedelta(seconds=1)
    session.commit()
    assert recover_stale_stages(session, settings) == set()
    assert stale_stage.status == RunStageStatus.RUNNING
