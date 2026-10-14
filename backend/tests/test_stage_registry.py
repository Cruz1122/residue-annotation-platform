from app.features.stages.registry import STAGE_BY_ID, STAGE_DEFINITIONS, validate_stage_registry


def test_registry_matches_the_product_contract_shape():
    validate_stage_registry()

    assert len(STAGE_DEFINITIONS) == 18
    assert set(STAGE_BY_ID) == {stage.id for stage in STAGE_DEFINITIONS}
    for stage in STAGE_DEFINITIONS:
        assert all(name for name in stage.required_annotations)
        assert stage.produced_annotations == stage.columns
        assert stage.produced_artifacts
        assert stage.description
        assert stage.stage_version
        assert stage.cache_parameters


def test_registry_exposes_remote_contract_metadata_without_changing_legacy_fields():
    stage = STAGE_BY_ID["variant_ddg"]
    payload = stage.to_dict()

    assert stage.dependencies == (
        "protein_identity",
        "membrane_topology",
        "protein_relaxation_energy",
    )
    assert stage.requires_variant is False
    assert payload["resources"] == {
        "cpu": 4,
        "gpu": 0,
        "network": False,
        "memory_gb": None,
    }
    assert {entry["producer"] for entry in payload["consumed_artifacts"]} == {
        "protein_identity",
        "membrane_topology",
        "protein_relaxation_energy",
    }


def test_remote_resource_gates_are_declared_in_the_registry():
    assert "slurm:SLURM_JOB_ID" in STAGE_BY_ID["protein_relaxation_energy"].technical_requirements
    assert "slurm:SLURM_JOB_ID" in STAGE_BY_ID["structural_contacts"].technical_requirements
    assert STAGE_BY_ID["uniprot_features"].network is True
    assert STAGE_BY_ID["protein_identity"].required_annotations == ()
    assert STAGE_BY_ID["structure_modeling"].required_annotations == ("tmbed_topology",)
