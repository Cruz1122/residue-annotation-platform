import hashlib
from pathlib import Path

from app.core.config import Settings, get_settings
from app.features.artifacts.storage import ArtifactStore
from app.features.runs.cache import (
    expected_artifact_types_for_stage,
    find_verified_cache_hit,
    planned_stage_cache_identity,
)
from app.features.runs.models import Artifact, Run, RunStage, StageResult, Upload
from app.features.runs.state import RunStageStatus, RunStatus
from app.features.runs.worker_service import (
    claim_ready_stage,
    finalize_run,
    plan_stage_cache,
    refresh_ready_states,
)
from app.main import app
from sqlalchemy import select

AMINO_ACIDS = {
    "A": "ALA",
    "C": "CYS",
    "D": "ASP",
    "E": "GLU",
    "F": "PHE",
}


def _pdb(sequence: str) -> bytes:
    rows = []
    for position, amino_acid in enumerate(sequence, start=1):
        rows.append(
            f"ATOM  {position:5d}  CA  {AMINO_ACIDS[amino_acid]:>3} A{position:4d}"
            f"    {10.0 + position:8.3f}{11.0:8.3f}{12.0:8.3f}"
            "  1.00 20.00           C  \n"
        )
    return ("".join(rows) + "END\n").encode()


def _protein(client, sequence: str = "ACDE") -> str:
    response = client.post("/api/v1/proteins", json={"sequence": sequence})
    assert response.status_code == 201
    return response.json()["id"]


def _upload(client, filename: str, content: bytes, input_type: str) -> str:
    media_type = "chemical/x-pdb" if input_type == "structure" else "text/plain"
    response = client.post(
        "/api/v1/uploads",
        files={"file": (filename, content, media_type)},
        data={"input_type": input_type},
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_run_persists_complete_configuration_and_explains_omissions(client, session):
    protein_id = _protein(client)
    fasta_id = _upload(client, "query.fasta", b">query\nACDE\n", "fasta")
    structure_id = _upload(client, "model.pdb", _pdb("ACDE"), "structure")

    created = client.post(
        "/api/v1/runs",
        json={
            "protein_id": protein_id,
            "upload_ids": [fasta_id, structure_id],
            "structure_source": "provided_pdb",
            "scientific_parameters": {"energy_mode": "foldx"},
            "variants": [{"aa_position": 2, "aa_ref": "C", "aa_alt": "F"}],
        },
    )

    assert created.status_code == 201, created.text
    payload = created.json()
    configuration = payload["configuration"]
    assert "config" not in payload
    assert configuration["protein_id"] == protein_id
    assert configuration["sequence_sha256"] == hashlib.sha256(b"ACDE").hexdigest()
    assert configuration["fasta_upload_id"] == fasta_id
    assert configuration["structure_upload_id"] == structure_id
    assert configuration["structure_source"] == "provided_pdb"
    assert configuration["structure_chain"] == "A"
    assert configuration["structure_mapping"]["mapped_residue_count"] == 4
    assert configuration["normalized_variants"] == [
        {"aa_position": 2, "aa_ref": "C", "aa_alt": "F"}
    ]
    assert "protein_identity" in configuration["selected_stage_ids"]
    omitted = {item["stage_id"]: item for item in configuration["omitted_stages"]}
    assert omitted["structure_modeling"]["reason"] == "provided_pdb_selected"
    assert omitted["variant_ddg"]["reason"] == "technical_prerequisite_not_provided"

    stages = {stage["id"]: stage for stage in payload["stages"]}
    assert stages["structure_modeling"]["status"] == "skipped"
    assert stages["structure_modeling"]["omission_reason"] == "provided_pdb_selected"
    assert stages["variant_ddg"]["status"] == "skipped"
    assert stages["variant_ddg"]["omission_reason"] == "technical_prerequisite_not_provided"

    read_back = client.get(f"/api/v1/runs/{payload['id']}")
    assert read_back.status_code == 200
    assert read_back.json()["configuration"] == configuration
    persisted = session.get(Run, payload["id"])
    assert persisted is not None
    assert persisted.configuration is not None
    assert persisted.configuration.confirmation_audit_id is not None


def test_client_cannot_self_authorize_technical_prerequisites(client):
    protein_id = _protein(client)
    created = client.post(
        "/api/v1/runs",
        json={
            "protein_id": protein_id,
            "variants": [{"aa_position": 2, "aa_ref": "C", "aa_alt": "F"}],
            "scientific_parameters": {
                "available_prerequisites": ["slurm:SLURM_JOB_ID", "command:srun"],
                "external_snapshots": {
                    "msa_cache:af3-msa-v1": {
                        "version": "claimed-by-client",
                        "sha256": "f" * 64,
                    }
                },
            },
        },
    )

    assert created.status_code == 201, created.text
    configuration = created.json()["configuration"]
    omitted = {item["stage_id"]: item for item in configuration["omitted_stages"]}
    assert omitted["variant_ddg"]["reason"] == "technical_prerequisite_not_provided"
    assert omitted["structure_modeling"]["reason"] == "technical_prerequisite_not_provided"
    assert configuration["prerequisites"]["available_technical_requirements"] == []
    assert configuration["versions"]["reproducibility_status"] == (
        "local_contract_verified_external_snapshots_unverified"
    )


def test_run_rejects_fasta_and_structure_mismatch_before_persisting(client, session):
    protein_id = _protein(client)
    fasta_id = _upload(client, "query.fasta", b">query\nACDE\n", "fasta")
    structure_id = _upload(client, "wrong.pdb", _pdb("ACDF"), "structure")

    response = client.post(
        "/api/v1/runs",
        json={
            "protein_id": protein_id,
            "upload_ids": [fasta_id, structure_id],
            "structure_source": "provided_pdb",
        },
    )

    assert response.status_code == 422
    assert "canonical sequence" in response.json()["detail"]
    assert session.scalar(select(Run)) is None


def test_remote_confirmation_requires_scientific_accession(client, tmp_path: Path):
    protein_id = _protein(client)
    remote_settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_execution_mode="ssh",
    )
    app.dependency_overrides[get_settings] = lambda: remote_settings

    response = client.post("/api/v1/runs", json={"protein_id": protein_id})

    assert response.status_code == 422
    assert "UniProt accession" in response.json()["detail"]


def test_provided_structure_satisfies_the_registry_dependency_without_af3(client, session):
    protein_id = _protein(client)
    structure_id = _upload(client, "model.pdb", _pdb("ACDE"), "structure")
    created = client.post(
        "/api/v1/runs",
        json={
            "protein_id": protein_id,
            "upload_ids": [structure_id],
            "structure_source": "provided_pdb",
        },
    )
    assert created.status_code == 201
    run = session.get(Run, created.json()["id"])
    assert run is not None
    identity = next(item for item in run.stages if item.stage_id == "protein_identity")
    identity.status = RunStageStatus.SUCCESS
    session.commit()

    refresh_ready_states(session, {run.id})
    states = {stage.stage_id: stage.status for stage in run.stages}
    assert states["structure_modeling"] == RunStageStatus.SKIPPED
    assert states["conformational_ensemble"] == RunStageStatus.SKIPPED
    assert states["structural_regime"] == RunStageStatus.READY
    assert states["variant_ddg"] == RunStageStatus.SKIPPED
    omissions = {item["stage_id"]: item for item in run.configuration.omitted_stages}
    assert omissions["conformational_ensemble"]["reason"] == "technical_prerequisite_not_provided"


def test_remote_gpp_pdb_run_is_cpu_only_and_generates_canonical_fasta(
    client, session, tmp_path: Path
):
    protein = client.post(
        "/api/v1/proteins",
        json={
            "sequence": "ACDE",
            "aliases": [{"source": "uniprot", "identifier": "P00001"}],
        },
    )
    assert protein.status_code == 201
    structure_id = _upload(client, "model.pdb", _pdb("ACDE"), "structure")
    remote_settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
        hpc_execution_mode="ssh",
        hpc_input_transfer_enabled=True,
        hpc_pipeline_cpu_budget=120,
        hpc_pipeline_gpu_budget=0,
        hpc_pipeline_pdb_substitution_enabled=False,
        hpc_available_technical_requirements="genomic_mapping",
    )
    app.dependency_overrides[get_settings] = lambda: remote_settings

    created = client.post(
        "/api/v1/runs",
        json={
            "protein_id": protein.json()["id"],
            "upload_ids": [structure_id],
            "structure_source": "provided_pdb",
            "structure_chain": "A",
            "scientific_accession": "P00001",
        },
        headers={"Idempotency-Key": "gpp-pdb-cpu-only"},
    )

    assert created.status_code == 201, created.text
    configuration = created.json()["configuration"]
    assert configuration["selected_stage_ids"] == [
        "protein_identity",
        "variant_predictors",
        "pharmacogenomics",
        "uniprot_features",
        "evolutionary_conservation",
        "functional_region_evidence",
        "experimental_variant_evidence",
    ]
    assert configuration["prerequisites"]["dependency_overrides"] == {}
    assert configuration["prerequisites"]["available_technical_requirements"] == [
        "command:srun",
        "genomic_mapping",
        "slurm:SLURM_JOB_ID",
    ]
    assert configuration["input_references"]["fasta"]["source"] == "canonical_sequence"
    assert configuration["input_references"]["structure"]["chain"] == "A"
    assert configuration["structure_mapping"]["mapped_residue_count"] == 4

    omitted = {item["stage_id"]: item for item in configuration["omitted_stages"]}
    assert omitted["sequence_frustration"]["reason"] == "gpu_unavailable"
    assert omitted["membrane_topology"]["reason"] == "gpu_unavailable"
    assert omitted["structure_modeling"]["reason"] == ("remote_pdb_substitution_not_supported")
    assert omitted["conformational_ensemble"]["reason"] == "bioemu_skipped"
    assert omitted["structural_regime"]["reason"] == "dependency_not_applicable"
    assert omitted["variant_ddg"]["reason"] == "variants_not_provided"

    generated = session.get(Upload, configuration["fasta_upload_id"])
    assert generated is not None
    assert generated.input_type == "fasta"
    assert generated.sha256 == hashlib.sha256(b">P00001\nACDE\n").hexdigest()
    assert configuration["fasta_sha256"] == generated.sha256
    assert (
        remote_settings.artifact_root / generated.storage_key
    ).read_bytes() == b">P00001\nACDE\n"


def test_idempotent_retry_returns_same_run_but_new_request_creates_new_run(client, session):
    protein_id = _protein(client)
    body = {"protein_id": protein_id, "scientific_parameters": {"energy_mode": "auto"}}
    headers = {"Idempotency-Key": "request-1"}

    first = client.post("/api/v1/runs", json=body, headers=headers)
    retry = client.post("/api/v1/runs", json=body, headers=headers)
    assert first.status_code == 201
    assert retry.status_code == 201
    assert retry.json()["id"] == first.json()["id"]
    conflict = client.post(
        "/api/v1/runs",
        json={**body, "scientific_parameters": {"energy_mode": "foldx"}},
        headers=headers,
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "idempotency_key_conflict"
    assert session.scalar(select(Run).where(Run.id == first.json()["id"])) is not None
    assert session.query(Run).count() == 1

    persisted = session.get(Run, first.json()["id"])
    assert persisted is not None
    persisted.status = RunStatus.FAILED
    session.commit()
    finalize_run(session, persisted)

    independent = client.post("/api/v1/runs", json=body, headers={"Idempotency-Key": "request-2"})
    assert independent.status_code == 201
    assert independent.json()["id"] != first.json()["id"]
    assert session.query(Run).count() == 2


def test_active_slot_conflict_is_explained_as_policy(client):
    first = client.post("/api/v1/runs", json={"protein_id": _protein(client, "ACDE")})
    assert first.status_code == 201
    second = client.post("/api/v1/runs", json={"protein_id": _protein(client, "ACDF")})

    assert second.status_code == 409
    detail = second.json()["detail"]
    assert detail["code"] == "active_run_slot"
    assert detail["policy"] == "single_active_run_per_user"


def test_verified_cache_hit_is_linked_before_execution(client, session, tmp_path: Path):
    protein_id = _protein(client)
    created = client.post("/api/v1/runs", json={"protein_id": protein_id})
    assert created.status_code == 201
    run = session.get(Run, created.json()["id"])
    assert run is not None
    stage = next(item for item in run.stages if item.stage_id == "protein_identity")
    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
    )

    cache_key, factors = planned_stage_cache_identity(stage, run.configuration, {})
    store = ArtifactStore(settings)
    artifact_key = "remote/cache-hit/identity.tsv"
    artifact_path = store.resolve(artifact_key)
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    artifact_path.write_bytes(b"verified")
    result = StageResult(
        protein_id=run.protein_id,
        stage_id=stage.stage_id,
        cache_key=cache_key,
        status="success",
        provenance={
            "cache_key": cache_key,
            "cache_factors": factors,
            "required_artifacts": sorted(expected_artifact_types_for_stage(stage.stage_id)),
        },
        owner_id=run.owner_id,
        project_id=run.project_id,
    )
    session.add(result)
    session.flush()
    for artifact_type in expected_artifact_types_for_stage(stage.stage_id):
        storage_key = (
            artifact_key
            if artifact_type == "annotations"
            else f"remote/cache-hit/{artifact_type}.json"
        )
        artifact_path = store.resolve(storage_key)
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        artifact_path.write_bytes(b"verified")
        session.add(
            Artifact(
                stage_result_id=result.id,
                artifact_type=artifact_type,
                storage_backend="filesystem",
                storage_key=storage_key,
                sha256=hashlib.sha256(b"verified").hexdigest(),
                size=8,
            )
        )
    session.commit()

    claimed = claim_ready_stage(session, settings)
    assert claimed is not None
    assert plan_stage_cache(session, claimed, settings) is True
    session.expire_all()
    linked = session.get(RunStage, claimed.id)
    assert linked is not None
    assert linked.status == RunStageStatus.REUSED
    assert linked.stage_result_id == result.id
    assert linked.cache_key == cache_key
    assert linked.reuse_reason["source_stage_result_id"] == result.id
    assert linked.reuse_reason["factors"] == factors


def test_cache_identity_changes_when_confirmed_scientific_inputs_change(client, session):
    protein_id = _protein(client)
    created = client.post(
        "/api/v1/runs",
        json={"protein_id": protein_id, "scientific_parameters": {"energy_mode": "auto"}},
    )
    assert created.status_code == 201
    run = session.get(Run, created.json()["id"])
    assert run is not None
    stage = next(item for item in run.stages if item.stage_id == "protein_identity")

    first_key, _ = planned_stage_cache_identity(stage, run.configuration, {})
    run.configuration.scientific_parameters = {"energy_mode": "foldx"}
    second_key, _ = planned_stage_cache_identity(stage, run.configuration, {})
    run.configuration.scientific_accession = "P12345"
    third_key, _ = planned_stage_cache_identity(stage, run.configuration, {})

    assert first_key != second_key
    assert second_key != third_key


def test_cache_identity_ignores_logging_only_parameters(client, session):
    protein_id = _protein(client)
    created = client.post(
        "/api/v1/runs",
        json={
            "protein_id": protein_id,
            "scientific_parameters": {
                "energy_mode": "auto",
                "log_level": "info",
            },
        },
    )
    assert created.status_code == 201
    run = session.get(Run, created.json()["id"])
    assert run is not None
    stage = next(item for item in run.stages if item.stage_id == "protein_identity")
    first_key, first_factors = planned_stage_cache_identity(stage, run.configuration, {})
    run.configuration.scientific_parameters = {
        "energy_mode": "auto",
        "log_level": "debug",
        "verbosity": 3,
    }
    second_key, second_factors = planned_stage_cache_identity(stage, run.configuration, {})

    assert first_key == second_key
    assert first_factors == second_factors


def test_stage_results_with_same_scientific_cache_key_are_scoped_by_project(client, session):
    project_a = {"X-User-Id": "user-a", "X-Project-Id": "project-a"}
    project_b = {"X-User-Id": "user-b", "X-Project-Id": "project-b"}
    protein_a = client.post(
        "/api/v1/proteins", headers=project_a, json={"sequence": "ACDEFGHIKLMN"}
    )
    assert protein_a.status_code == 201
    run_a_response = client.post(
        "/api/v1/runs", headers=project_a, json={"protein_id": protein_a.json()["id"]}
    )
    assert run_a_response.status_code == 201

    protein_b = client.post(
        "/api/v1/proteins", headers=project_b, json={"sequence": "ACDEFGHIKLMN"}
    )
    assert protein_b.status_code == 200
    run_b_response = client.post(
        "/api/v1/runs", headers=project_b, json={"protein_id": protein_b.json()["id"]}
    )
    assert run_b_response.status_code == 201

    run_a = session.get(Run, run_a_response.json()["id"])
    run_b = session.get(Run, run_b_response.json()["id"])
    assert run_a is not None and run_b is not None
    stage_a = next(item for item in run_a.stages if item.stage_id == "protein_identity")
    stage_b = next(item for item in run_b.stages if item.stage_id == "protein_identity")
    cache_key_a, _ = planned_stage_cache_identity(stage_a, run_a.configuration, {})
    cache_key_b, _ = planned_stage_cache_identity(stage_b, run_b.configuration, {})
    assert cache_key_a == cache_key_b

    session.add_all(
        [
            StageResult(
                protein_id=run_a.protein_id,
                stage_id=stage_a.stage_id,
                cache_key=cache_key_a,
                status="success",
                provenance={},
                owner_id=run_a.owner_id,
                project_id=run_a.project_id,
            ),
            StageResult(
                protein_id=run_b.protein_id,
                stage_id=stage_b.stage_id,
                cache_key=cache_key_b,
                status="success",
                provenance={},
                owner_id=run_b.owner_id,
                project_id=run_b.project_id,
            ),
        ]
    )
    session.flush()

    rows = session.scalars(
        select(StageResult).where(
            StageResult.protein_id == run_a.protein_id,
            StageResult.stage_id == stage_a.stage_id,
            StageResult.cache_key == cache_key_a,
        )
    ).all()
    assert {row.project_id for row in rows} == {"project-a", "project-b"}


def test_history_keeps_independent_runs_and_configurations(client, session):
    protein_id = _protein(client)
    first = client.post("/api/v1/runs", json={"protein_id": protein_id})
    assert first.status_code == 201
    first_run = session.get(Run, first.json()["id"])
    assert first_run is not None
    first_run.status = RunStatus.FAILED
    session.commit()
    finalize_run(session, first_run)

    second = client.post("/api/v1/runs", json={"protein_id": protein_id})
    assert second.status_code == 201
    assert second.json()["id"] != first.json()["id"]

    history = client.get("/api/v1/runs")
    assert history.status_code == 200
    entries = {item["id"]: item for item in history.json()}
    assert set(entries) == {first.json()["id"], second.json()["id"]}
    assert all(item["configuration"] is not None for item in entries.values())


def test_pre_submit_cache_requires_provenance_and_scope(client, session, tmp_path: Path):
    protein_id = _protein(client)
    created = client.post("/api/v1/runs", json={"protein_id": protein_id})
    assert created.status_code == 201
    run = session.get(Run, created.json()["id"])
    assert run is not None
    stage = next(item for item in run.stages if item.stage_id == "protein_identity")
    cache_key, factors = planned_stage_cache_identity(stage, run.configuration, {})
    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=tmp_path / "artifacts",
    )
    store = ArtifactStore(settings)
    artifact_key = "remote/cache-scope/identity.tsv"
    artifact_path = store.resolve(artifact_key)
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    artifact_path.write_bytes(b"verified")

    legacy = StageResult(
        protein_id=run.protein_id,
        stage_id=stage.stage_id,
        cache_key=cache_key,
        status="success",
        provenance={},
        owner_id=run.owner_id,
        project_id=run.project_id,
    )
    session.add(legacy)
    session.flush()
    session.add(
        Artifact(
            stage_result_id=legacy.id,
            artifact_type="annotations",
            storage_backend="filesystem",
            storage_key=artifact_key,
            sha256=hashlib.sha256(b"verified").hexdigest(),
            size=8,
        )
    )
    session.commit()

    assert (
        find_verified_cache_hit(
            session,
            stage,
            cache_key,
            store,
            require_provenance=True,
        )
        is None
    )

    legacy.provenance = {
        "cache_key": cache_key,
        "cache_factors": {},
        "required_artifacts": ["annotations"],
    }
    session.commit()
    assert (
        find_verified_cache_hit(
            session,
            stage,
            cache_key,
            store,
            require_provenance=True,
        )
        is None
    )

    scoped_key = hashlib.sha256(b"foreign-scope").hexdigest()
    scoped = StageResult(
        protein_id=run.protein_id,
        stage_id=stage.stage_id,
        cache_key=scoped_key,
        status="success",
        provenance={"cache_key": scoped_key, "cache_factors": factors},
        owner_id="another-user",
        project_id="another-project",
    )
    session.add(scoped)
    session.flush()
    foreign_key = "remote/cache-scope/foreign.tsv"
    foreign_path = store.resolve(foreign_key)
    foreign_path.write_bytes(b"foreign")
    session.add(
        Artifact(
            stage_result_id=scoped.id,
            artifact_type="annotations",
            storage_backend="filesystem",
            storage_key=foreign_key,
            sha256=hashlib.sha256(b"foreign").hexdigest(),
            size=7,
        )
    )
    session.commit()
    assert (
        find_verified_cache_hit(
            session,
            stage,
            scoped_key,
            store,
            require_provenance=True,
        )
        is None
    )
