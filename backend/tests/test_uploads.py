import errno
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest
from app.features.auth.models import AuditEvent
from app.features.runs.models import Run, Upload
from app.features.runs.state import RunStatus
from app.features.runs.worker_service import finalize_run
from app.features.uploads.service import UploadValidationError, validate_upload_bytes
from app.infrastructure.hpc.ssh import SSHConfigurationError, _remote_path_under
from app.infrastructure.hpc.transfer import (
    InputTransferError,
    SCPInputTransfer,
    remote_input_path,
    remote_pipeline_input_path,
)
from sqlalchemy import select


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


def test_upload_creation_is_audited_without_content_or_path(client, session):
    upload = client.post(
        "/api/v1/uploads",
        files={"file": ("query.fasta", b">query\nACDE", "text/plain")},
        data={"input_type": "fasta"},
    )
    assert upload.status_code == 201

    event = session.scalar(select(AuditEvent).where(AuditEvent.action == "create_upload"))
    assert event is not None
    assert event.resource_id == upload.json()["id"]
    assert event.details == {"input_type": "fasta", "size": 11}
    assert "storage_key" not in event.details


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


def test_upload_digest_mismatch_returns_409(client, session, tmp_path):
    payload = (
        b"ATOM      1  N   ALA A   1      11.104  13.207  14.456  1.00 20.00           N  \nEND\n"
    )
    created = client.post(
        "/api/v1/uploads",
        files={"file": ("model.pdb", payload, "chemical/x-pdb")},
        data={"input_type": "structure"},
    )
    assert created.status_code == 201
    upload = session.get(Upload, created.json()["id"])
    assert upload is not None
    stored = tmp_path / "artifacts" / upload.storage_key
    stored.write_bytes(b"X" * len(payload))

    response = client.get(f"/api/v1/uploads/{upload.id}/content")

    assert response.status_code == 409
    assert response.json()["detail"] == "Upload content does not match its record"


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


def test_remote_pipeline_input_path_matches_remote_upload_contract():
    from app.core.config import Settings

    settings = Settings(hpc_remote_root="/gpfs/project/root")
    path = remote_pipeline_input_path(
        settings,
        "P00001",
        "run-1",
        "upload-1",
        ".pdb",
        input_type="structure",
    )
    assert path == "/gpfs/project/root/uploads/P00001/.platform_runs/run-1/pdb/upload-1.pdb"

    fasta_path = remote_pipeline_input_path(
        settings,
        "P00001",
        "run-1",
        "upload-1",
        ".fasta",
        input_type="fasta",
    )
    expected_fasta_path = "/gpfs/project/root/uploads/P00001"
    expected_fasta_path += "/.platform_runs/run-1/fasta/upload-1.fasta"
    assert fasta_path == expected_fasta_path

    try:
        remote_pipeline_input_path(
            settings,
            "P00001",
            "run-1",
            "upload-1",
            ".mmcif",
            input_type="structure",
        )
    except InputTransferError as exc:
        assert "only as .pdb" in str(exc)
    else:
        raise AssertionError("remote mmCIF input unexpectedly accepted")


def test_prepare_run_inputs_rejects_remote_mmcif_before_opening_ssh(session, tmp_path, monkeypatch):
    from app.core.config import Settings
    from app.features.proteins.models import Protein, ProteinIdentifier
    from app.features.runs.models import Upload
    from app.features.runs.worker_service import prepare_run_inputs

    artifact_root = tmp_path / "artifacts"
    stored = artifact_root / "uploads" / "structure.mmcif"
    stored.parent.mkdir(parents=True)
    stored.write_text("data_test\n", encoding="utf-8")

    protein = Protein(
        sequence="ACDE",
        length=4,
        sequence_sha256="a" * 64,
        owner_id="u1",
        project_id="p1",
        identifiers=[ProteinIdentifier(source="uniprot", identifier="P00001")],
    )
    run = Run(protein=protein, owner_id="u1", project_id="p1", status="pending")
    run.uploads.append(
        Upload(
            owner_id="u1",
            project_id="p1",
            input_type="structure",
            original_filename="model.mmcif",
            storage_key="uploads/structure.mmcif",
            sha256="b" * 64,
            size=10,
            media_type="chemical/mmcif",
        )
    )
    session.add(run)
    session.flush()
    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=artifact_root,
        hpc_execution_mode="ssh",
        hpc_input_transfer_enabled=True,
        hpc_remote_root="/gpfs/project/root",
    )

    def fail_if_ssh_is_open(_settings):
        raise AssertionError("incompatible input opened an SSH transfer")

    monkeypatch.setattr("app.features.runs.worker_service.SCPInputTransfer", fail_if_ssh_is_open)
    with pytest.raises(InputTransferError, match=r"only as \.pdb"):
        prepare_run_inputs(session, run, settings)

    persisted = session.get(Upload, run.uploads[0].id)
    assert persisted is not None
    assert persisted.transfer_status == "failed"


def test_native_input_transfer_confines_and_does_not_overwrite(tmp_path):
    from app.core.config import Settings
    from app.infrastructure.hpc.transfer import InputTransferError, NativeInputTransfer

    artifact_root = tmp_path / "artifacts"
    source = artifact_root / "uploads" / "sequence.fasta"
    source.parent.mkdir(parents=True)
    source.write_text(">P00001\nACDE\n", encoding="utf-8")
    hpc_root = tmp_path / "hpc-root"
    hpc_root.mkdir()
    settings = Settings(
        app_env="test",
        database_url="sqlite://",
        artifact_root=artifact_root,
        hpc_execution_mode="native",
        hpc_remote_root=str(hpc_root),
    )
    remote = (
        hpc_root / "uploads" / "P00001" / ".platform_runs" / "run-1" / "fasta" / "upload-1.fasta"
    )

    with NativeInputTransfer(settings) as transfer:
        transfer.upload(source, str(remote))
        with pytest.raises(InputTransferError, match="already exists"):
            transfer.upload(source, str(remote))

    assert remote.read_text(encoding="utf-8") == source.read_text(encoding="utf-8")
    assert remote.stat().st_mode & 0o077 == 0


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


class _FakeTransferSFTP:
    def __init__(self, root: str, symlinks: set[str] | None = None):
        self.root = root
        self.entries = {root: stat.S_IFDIR | 0o700}
        self.symlinks = symlinks or set()
        self.created: list[str] = []
        self.closed = False

    def lstat(self, path: str):
        if path in self.symlinks:
            return SimpleNamespace(st_mode=stat.S_IFLNK | 0o777)
        try:
            mode = self.entries[path]
        except KeyError as exc:
            error = OSError(errno.ENOENT, "missing")
            raise error from exc
        return SimpleNamespace(st_mode=mode)

    def mkdir(self, path: str, mode: int):
        assert mode == 0o700
        self.entries[path] = stat.S_IFDIR | mode
        self.created.append(path)

    def close(self):
        self.closed = True


class _FakeTransferSSH:
    def __init__(self, sftp: _FakeTransferSFTP):
        self.sftp = sftp

    def open_sftp(self):
        return self.sftp

    def exec_command(self, *_args, **_kwargs):
        raise AssertionError("SCP input transfer must not use a remote shell")


class _FakeTransferSCP:
    def __init__(self):
        self.calls: list[tuple[str, str]] = []

    def put(self, local_path: str, remote_path: str, preserve_times: bool):
        assert preserve_times is False
        self.calls.append((local_path, remote_path))


def _configured_transfer(tmp_path: Path, sftp: _FakeTransferSFTP):
    from app.core.config import Settings

    local_root = tmp_path / "artifacts"
    local_root.mkdir()
    local_file = local_root / "upload.pdb"
    local_file.write_text("ATOM\n", encoding="utf-8")
    transfer = SCPInputTransfer(
        Settings(
            app_env="test",
            database_url="sqlite://",
            artifact_root=local_root,
            hpc_remote_root="/gpfs/project/root",
            hpc_ssh_host="glogin4.bsc.es",
            hpc_ssh_username="bsc001997",
            hpc_ssh_password_file=tmp_path / "password",
        )
    )
    transfer.client = _FakeTransferSSH(sftp)
    transfer.scp = _FakeTransferSCP()
    return transfer, local_file


def test_scp_input_transfer_creates_verified_components_without_remote_shell(tmp_path: Path):
    sftp = _FakeTransferSFTP("/gpfs/project/root")
    transfer, local_file = _configured_transfer(tmp_path, sftp)

    transfer.upload(
        local_file,
        "/gpfs/project/root/uploads/run-1/pdb/upload-1.pdb",
    )

    assert sftp.created == [
        "/gpfs/project/root/uploads",
        "/gpfs/project/root/uploads/run-1",
        "/gpfs/project/root/uploads/run-1/pdb",
    ]
    assert transfer.scp.calls == [
        (
            str(local_file),
            "/gpfs/project/root/uploads/run-1/pdb/upload-1.pdb",
        )
    ]


def test_scp_input_transfer_rejects_symlinked_parent_before_put(tmp_path: Path):
    sftp = _FakeTransferSFTP(
        "/gpfs/project/root",
        symlinks={"/gpfs/project/root/uploads"},
    )
    sftp.entries["/gpfs/project/root/uploads"] = stat.S_IFDIR | 0o700
    transfer, local_file = _configured_transfer(tmp_path, sftp)

    with pytest.raises(InputTransferError, match="symlinked component"):
        transfer.upload(
            local_file,
            "/gpfs/project/root/uploads/run-1/pdb/upload-1.pdb",
        )

    assert transfer.scp.calls == []
    assert sftp.created == []
