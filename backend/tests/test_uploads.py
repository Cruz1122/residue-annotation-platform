import pytest
from app.features.runs.models import Run
from app.features.runs.state import RunStatus
from app.features.runs.worker_service import finalize_run
from app.features.uploads.service import UploadValidationError, validate_upload_bytes
from app.infrastructure.hpc.ssh import SSHConfigurationError, _remote_path_under
from app.infrastructure.hpc.transfer import InputTransferError, remote_input_path


def _create_protein(client, sequence: str) -> str:
    response = client.post("/api/v1/proteins", json={"sequence": sequence})
    assert response.status_code == 201
    return response.json()["id"]


def test_small_fasta_upload_can_be_attached_to_a_run(client):
    upload = client.post(
        "/api/v1/uploads",
        files={"file": ("query.fasta", b">query\nACDE", "text/plain")},
        data={"input_type": "fasta"},
    )
    assert upload.status_code == 201
    upload_payload = upload.json()
    protein_id = _create_protein(client, "ACDE")

    run = client.post(
        "/api/v1/runs",
        json={"protein_id": protein_id, "upload_ids": [upload_payload["id"]]},
    )
    assert run.status_code == 201
    assert run.json()["uploads"][0]["input_type"] == "fasta"
    assert run.json()["uploads"][0]["transfer_status"] == "pending"


def test_upload_validation_rejects_wrong_extension_and_binary_content(client):
    wrong_extension = client.post(
        "/api/v1/uploads",
        files={"file": ("query.pdb", b"ACDE", "text/plain")},
        data={"input_type": "fasta"},
    )
    assert wrong_extension.status_code == 422

    with_binary = client.post(
        "/api/v1/uploads",
        files={"file": ("query.pdb", b"ATOM\x00", "chemical/x-pdb")},
        data={"input_type": "structure"},
    )
    assert with_binary.status_code == 422


def test_structure_upload_requires_parseable_pdb_or_mmcif():
    from app.core.config import Settings

    settings = Settings()
    valid_pdb = (
        b"ATOM      1  N   ALA A   1      11.104  13.207  14.456  1.00 20.00           N  \nEND\n"
    )
    valid_mmcif = b"""data_example
#
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
ATOM 1 N N ALA A 1 11.104 13.207 14.456
#
"""

    validate_upload_bytes(valid_pdb, "structure", "model.pdb", settings)
    validate_upload_bytes(valid_mmcif, "structure", "model.cif", settings)
    with pytest.raises(UploadValidationError):
        validate_upload_bytes(b"not a PDB document", "structure", "model.pdb", settings)
    with pytest.raises(UploadValidationError):
        validate_upload_bytes(b"not an mmCIF document", "structure", "model.cif", settings)


def test_structure_upload_content_is_limited_to_the_owner(client):
    payload = (
        b"ATOM      1  N   ALA A   1      11.104  13.207  14.456  1.00 20.00           N  \nEND\n"
    )
    created = client.post(
        "/api/v1/uploads",
        files={"file": ("model.pdb", payload, "chemical/x-pdb")},
        data={"input_type": "structure"},
    )
    assert created.status_code == 201
    upload_id = created.json()["id"]

    owned = client.get(f"/api/v1/uploads/{upload_id}/content")
    assert owned.status_code == 200
    assert owned.content == payload

    foreign = client.get(
        f"/api/v1/uploads/{upload_id}/content",
        headers={"X-User-Id": "other-user", "X-Project-Id": "other-project"},
    )
    assert foreign.status_code == 404


def test_user_can_have_only_one_active_run_and_slot_is_released(client, session):
    first_protein = _create_protein(client, "ACDE")
    second_protein = _create_protein(client, "ACDF")
    first_run = client.post("/api/v1/runs", json={"protein_id": first_protein})
    assert first_run.status_code == 201

    active = client.get("/api/v1/runs/active")
    assert active.status_code == 200
    assert active.json()["id"] == first_run.json()["id"]
    assert active.json()["protein_id"] == first_protein

    blocked = client.post("/api/v1/runs", json={"protein_id": second_protein})
    assert blocked.status_code == 409
    detail = blocked.json()["detail"]
    assert detail["message"] == "User already has an active protein run"
    assert detail["run_id"] == first_run.json()["id"]
    assert detail["protein_id"] == first_protein

    run = session.get(Run, first_run.json()["id"])
    run.status = RunStatus.FAILED
    session.commit()
    finalize_run(session, run)

    assert client.get("/api/v1/runs/active").status_code == 404

    allowed_after_terminal = client.post("/api/v1/runs", json={"protein_id": second_protein})
    assert allowed_after_terminal.status_code == 201


def test_cancelling_pending_run_releases_the_active_slot(client, session):
    first_protein = _create_protein(client, "ACDE")
    second_protein = _create_protein(client, "ACDF")
    first_run = client.post("/api/v1/runs", json={"protein_id": first_protein}).json()

    cancelled = client.post(f"/api/v1/runs/{first_run['id']}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == RunStatus.CANCELLED

    allowed = client.post("/api/v1/runs", json={"protein_id": second_protein})
    assert allowed.status_code == 201

    assert session.get(Run, first_run["id"]).status == RunStatus.CANCELLED


def test_remote_input_path_is_generated_inside_configured_root():
    from app.core.config import Settings

    settings = Settings(hpc_remote_root="/gpfs/project/root")
    path = remote_input_path(settings, "run-1", "upload-1", ".pdb", input_type="structure")
    assert path == "/gpfs/project/root/uploads/run-1/pdb/upload-1.pdb"
    fasta_path = remote_input_path(settings, "run-1", "upload-1", ".fasta", input_type="fasta")
    assert fasta_path == "/gpfs/project/root/uploads/run-1/fasta/upload-1.fasta"

    with_binary = Settings(
        hpc_remote_root="/gpfs/project/root", hpc_input_remote_subdir="../escape"
    )
    try:
        remote_input_path(with_binary, "run-1", "upload-1", ".pdb", input_type="structure")
    except InputTransferError:
        pass
    else:
        raise AssertionError("remote traversal unexpectedly accepted")

    with_run_traversal = Settings(hpc_remote_root="/gpfs/project/root")
    try:
        remote_input_path(
            with_run_traversal, "../escape", "upload-1", ".pdb", input_type="structure"
        )
    except InputTransferError:
        pass
    else:
        raise AssertionError("run traversal unexpectedly accepted")

    try:
        _remote_path_under("/gpfs/project/root", "/gpfs/project/root/../escape")
    except SSHConfigurationError:
        pass
    else:
        raise AssertionError("SSH path traversal unexpectedly accepted")


def test_upload_service_bounds_files():
    from app.core.config import Settings

    settings = Settings(max_upload_bytes=4)
    validate_upload_bytes(b">x\nA", "fasta", "x.fasta", settings)
    try:
        validate_upload_bytes(b">x\nACDE", "fasta", "x.fasta", settings)
    except UploadValidationError:
        pass
    else:
        raise AssertionError("oversized upload unexpectedly accepted")
