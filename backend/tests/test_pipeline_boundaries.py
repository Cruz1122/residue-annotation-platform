import hashlib
import io
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest
from app.features.artifacts.storage import ArtifactPathError, safe_storage_path
from app.features.runs.cache import canonical_cache_key
from app.features.runs.manifest import (
    ManifestError,
    atomic_write_manifest,
    normalize_remote_manifest_paths,
    validate_manifest,
    validate_remote_manifest,
)
from app.infrastructure.hpc.readonly import (
    AUTHORIZED_MN5_ROOT,
    InspectionError,
    LocalReadOnlyInspector,
    SFTPReadOnlyInspector,
    validate_relative_path,
)
from app.infrastructure.hpc.ssh import assert_no_symlink_components


def test_cache_key_changes_with_scientific_inputs_but_not_log_level():
    base = {
        "protein_sha256": "a" * 64,
        "stage_id": "protein_identity",
        "stage_version": "1",
        "parameters": {"threshold": 0.5},
        "resources": {"cpu": 1},
        "code_sha256": "b" * 64,
    }
    first = canonical_cache_key(**base)
    second = canonical_cache_key(**{**base, "parameters": {"threshold": 0.6}})
    logging_only = canonical_cache_key(
        **{**base, "parameters": {"threshold": 0.5, "log_level": "debug"}}
    )
    assert first != second
    assert first == logging_only


def test_cache_key_includes_dependency_and_sequence_identity():
    base = {
        "protein_sha256": "a" * 64,
        "stage_id": "structure_modeling",
        "stage_version": "1",
        "parameters": {"model": "af3"},
        "resources": {"cpu": 8, "gpu": 1},
        "code_sha256": "b" * 64,
    }
    first = canonical_cache_key(**base, dependency_cache_keys={"membrane_topology": "c" * 64})
    dependency_change = canonical_cache_key(
        **base, dependency_cache_keys={"membrane_topology": "d" * 64}
    )
    reference_change = canonical_cache_key(**base, reference_sequence_sha256="e" * 64)
    assert first != dependency_change
    assert first != reference_change


def test_manifest_rejects_unsafe_storage_keys():
    manifest = {
        "manifest_version": "1",
        "stage_id": "protein_identity",
        "status": "success",
        "artifacts": [{"storage_key": "../secret", "sha256": "a", "size": 1}],
        "provenance": {"tool": "tool", "version": "1"},
    }

    with pytest.raises(ManifestError):
        validate_manifest(manifest, "protein_identity")


def test_manifest_requires_real_sha256_and_nonempty_remote_paths():
    local = _local_manifest(1)
    local["artifacts"][0]["sha256"] = "not-a-hash"
    with pytest.raises(ManifestError):
        validate_manifest(local, "protein_identity")

    remote = _remote_manifest(1)
    remote["artifacts"]["structure"]["path"] = ""
    with pytest.raises(ManifestError):
        validate_remote_manifest(remote, "protein_identity")

    remote = _remote_manifest(1)
    remote["partial"] = True
    with pytest.raises(ManifestError):
        validate_remote_manifest(remote, "protein_identity")


def test_artifact_store_rejects_traversal_and_absolute_paths(tmp_path: Path):
    for key in ("../secret", "/etc/passwd", ".hidden/file"):
        with pytest.raises(ArtifactPathError):
            safe_storage_path(tmp_path, key)
    (tmp_path / "link").symlink_to(tmp_path)
    with pytest.raises(ArtifactPathError):
        safe_storage_path(tmp_path, "link/file")


def test_read_only_inspector_rejects_escape_and_symlink(tmp_path: Path):
    root = tmp_path / "root"
    root.mkdir()
    (root / "allowed.txt").write_text("evidence", encoding="utf-8")
    link = root / "link.txt"
    link.symlink_to(root / "allowed.txt")
    inspector = LocalReadOnlyInspector(root)

    assert inspector.read_preview("allowed.txt", 4) == b"evid"
    with pytest.raises(InspectionError):
        validate_relative_path("../secret")
    with pytest.raises(InspectionError):
        inspector.stat("link.txt")


@pytest.mark.parametrize(
    "relative_path",
    ["../secret", "/etc/passwd", ".hidden", "nested/../secret", "nested/.secret", ""],
)
def test_read_only_path_validation_rejects_escape_and_hidden_components(relative_path: str):
    with pytest.raises(InspectionError):
        validate_relative_path(relative_path)


class _FakeSFTPInspectorTransport:
    def __init__(self, root: str):
        self.root = root
        self.files = {f"{root}/docs.txt": b"evidence"}
        self.symlinks = {f"{root}/link.txt"}
        self.closed = False

    def lstat(self, path: str):
        if path in self.symlinks:
            return SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_size=0)
        if path in self.files:
            return SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_size=len(self.files[path]))
        return SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_size=0)

    def listdir_attr(self, path: str):
        assert path == self.root
        return [
            SimpleNamespace(filename="docs.txt", st_mode=stat.S_IFREG | 0o600, st_size=8),
            SimpleNamespace(filename=".hidden", st_mode=stat.S_IFREG | 0o600, st_size=0),
            SimpleNamespace(filename="link.txt", st_mode=stat.S_IFLNK | 0o777, st_size=0),
        ]

    def open(self, path: str, _mode: str):
        return io.BytesIO(self.files[path])

    def close(self):
        self.closed = True


class _FakeSSHInspectorTransport:
    def __init__(self, sftp: _FakeSFTPInspectorTransport):
        self.sftp = sftp
        self.closed = False
        self.connect_kwargs = None
        self.host_key_policy = None

    def load_host_keys(self, _path: str):
        return None

    def load_system_host_keys(self):
        return None

    def set_missing_host_key_policy(self, policy):
        self.host_key_policy = policy

    def connect(self, **kwargs):
        self.connect_kwargs = kwargs

    def open_sftp(self):
        return self.sftp

    def close(self):
        self.closed = True


def _sftp_inspector_settings(tmp_path: Path, **overrides):
    from app.core.config import Settings

    password = tmp_path / "hpc-password"
    password.write_text("test-password\n", encoding="utf-8")
    password.chmod(0o600)
    values = {
        "app_env": "test",
        "database_url": "sqlite://",
        "hpc_ssh_host": "glogin4.bsc.es",
        "hpc_ssh_username": "bsc001997",
        "hpc_ssh_password_file": password,
        "hpc_known_hosts_file": tmp_path / "known_hosts",
        "mn5_root": AUTHORIZED_MN5_ROOT,
        "mn5_max_preview_bytes": 64,
    }
    values.update(overrides)
    return Settings(**values), password


def test_sftp_read_only_inspector_uses_only_bounded_sftp_reads(tmp_path: Path, monkeypatch):
    import app.infrastructure.hpc.readonly as readonly_module

    settings, _password = _sftp_inspector_settings(tmp_path)
    transport = _FakeSFTPInspectorTransport(AUTHORIZED_MN5_ROOT)
    ssh = _FakeSSHInspectorTransport(transport)
    monkeypatch.setattr(readonly_module.paramiko, "SSHClient", lambda: ssh)

    inspector = SFTPReadOnlyInspector(settings)
    entries = inspector.list()
    assert [entry.path for entry in entries] == ["docs.txt"]
    assert inspector.stat("docs.txt").size == len(b"evidence")
    assert inspector.read_preview("docs.txt", 4) == b"evid"
    assert ssh.connect_kwargs["hostname"] == "glogin4.bsc.es"
    assert ssh.connect_kwargs["allow_agent"] is False
    assert ssh.connect_kwargs["look_for_keys"] is False
    assert transport.closed is True
    assert ssh.closed is True


def test_sftp_read_only_inspector_rejects_symlink_and_preview_over_limit(
    tmp_path: Path, monkeypatch
):
    import app.infrastructure.hpc.readonly as readonly_module

    settings, _password = _sftp_inspector_settings(tmp_path)
    transport = _FakeSFTPInspectorTransport(AUTHORIZED_MN5_ROOT)
    ssh = _FakeSSHInspectorTransport(transport)
    monkeypatch.setattr(readonly_module.paramiko, "SSHClient", lambda: ssh)
    inspector = SFTPReadOnlyInspector(settings)

    with pytest.raises(InspectionError):
        inspector.stat("link.txt")
    with pytest.raises(InspectionError):
        inspector.read_preview("docs.txt", settings.mn5_max_preview_bytes + 1)


def test_sftp_read_only_inspector_sanitizes_remote_io_errors(tmp_path: Path, monkeypatch):
    import app.infrastructure.hpc.readonly as readonly_module

    settings, _password = _sftp_inspector_settings(tmp_path)
    transport = _FakeSFTPInspectorTransport(AUTHORIZED_MN5_ROOT)
    ssh = _FakeSSHInspectorTransport(transport)
    monkeypatch.setattr(readonly_module.paramiko, "SSHClient", lambda: ssh)

    def fail_list(_path: str):
        raise OSError("/gpfs/private/secret details")

    transport.listdir_attr = fail_list
    inspector = SFTPReadOnlyInspector(settings)
    with pytest.raises(InspectionError, match="unavailable") as error:
        inspector.list()
    assert "/gpfs/" not in str(error.value)


@pytest.mark.parametrize(
    "overrides, password_mode, password_contents",
    [
        ({"mn5_root": "/gpfs/projects/bsc08/other"}, 0o600, "secret"),
        ({}, 0o644, "secret"),
        ({}, 0o600, ""),
        ({"hpc_ssh_host": None}, 0o600, "secret"),
    ],
)
def test_sftp_read_only_inspector_rejects_unsafe_profiles(
    tmp_path: Path, overrides, password_mode: int, password_contents: str
):
    settings, password = _sftp_inspector_settings(tmp_path, **overrides)
    password.write_text(password_contents, encoding="utf-8")
    password.chmod(password_mode)

    with pytest.raises(InspectionError):
        SFTPReadOnlyInspector(settings)


def test_sftp_read_only_inspector_rejects_symlinked_password_file(tmp_path: Path):
    settings, password = _sftp_inspector_settings(tmp_path)
    target = tmp_path / "real-password"
    target.write_text("secret", encoding="utf-8")
    target.chmod(0o600)
    password.unlink()
    password.symlink_to(target)

    with pytest.raises(InspectionError, match="regular file"):
        SFTPReadOnlyInspector(settings)


def _local_manifest(size: object) -> dict:
    return {
        "manifest_version": "1",
        "stage_id": "protein_identity",
        "status": "success",
        "artifacts": [{"storage_key": "rows.tsv", "sha256": "a" * 64, "size": size}],
        "provenance": {"tool": "tool", "version": "1"},
    }


def _remote_manifest(size: object) -> dict:
    return {
        "schema": "stage-result-v1",
        "stage_id": "protein_identity",
        "status": "success",
        "cache_key": "b" * 64,
        "annotations": "annotations.tsv",
        "artifacts": {"structure": {"path": "model.cif", "sha256": "c" * 64, "size": size}},
    }


def test_manifests_reject_boolean_sizes():
    with pytest.raises(ManifestError):
        validate_manifest(_local_manifest(True), "protein_identity")
    with pytest.raises(ManifestError):
        validate_remote_manifest(_remote_manifest(True), "protein_identity")
    validate_manifest(_local_manifest(0), "protein_identity")
    validate_remote_manifest(_remote_manifest(0), "protein_identity")


def test_remote_manifest_normalizes_in_root_absolute_artifact_paths():
    remote = _remote_manifest(1)
    remote["artifacts"]["structure"]["path"] = (
        "/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion/"
        "results/protein_identity/model.cif"
    )

    normalized = normalize_remote_manifest_paths(
        remote,
        "/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion",
    )

    assert normalized["artifacts"]["structure"]["path"] == "results/protein_identity/model.cif"
    assert normalized["artifacts"]["structure"]["external"] is True
    validate_remote_manifest(normalized, "protein_identity")
    assert remote["artifacts"]["structure"]["path"].startswith("/gpfs/")


def test_remote_manifest_rejects_absolute_artifact_paths_outside_root():
    remote = _remote_manifest(1)
    remote["artifacts"]["structure"]["path"] = "/tmp/model.cif"

    with pytest.raises(ManifestError, match="outside the configured root"):
        normalize_remote_manifest_paths(
            remote,
            "/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion",
        )


def test_atomic_manifest_write_is_clean_on_replace_failure(tmp_path: Path, monkeypatch):
    import app.features.runs.manifest as manifest_module

    target = tmp_path / "result_manifest.json"
    manifest = _local_manifest(10)

    def failing_replace(*_args: object, **_kwargs: object) -> None:
        raise OSError("simulated power loss")

    monkeypatch.setattr(manifest_module.os, "replace", failing_replace)
    with pytest.raises(OSError):
        atomic_write_manifest(target, manifest)

    assert not target.exists()
    assert list(tmp_path.iterdir()) == []


def test_atomic_manifest_write_publishes_without_temporaries(tmp_path: Path):
    target = tmp_path / "result_manifest.json"

    atomic_write_manifest(target, _local_manifest(10))

    assert target.exists()
    assert [path.name for path in tmp_path.iterdir()] == ["result_manifest.json"]


def test_atomic_manifest_write_cleans_temp_when_serialization_fails(tmp_path: Path):
    manifest = _local_manifest(10)
    manifest["provenance"]["unserializable"] = object()
    target = tmp_path / "result_manifest.json"

    with pytest.raises(TypeError):
        atomic_write_manifest(target, manifest)

    assert not target.exists()
    assert list(tmp_path.iterdir()) == []


class _FakeSFTP:
    def __init__(self, symlink_paths: set[str]):
        self.symlink_paths = symlink_paths

    def lstat(self, path: str):
        class _Attributes:
            def __init__(self, mode: int):
                self.st_mode = mode

        import stat as stat_module

        if path in self.symlink_paths:
            return _Attributes(stat_module.S_IFLNK | 0o777)
        return _Attributes(stat_module.S_IFDIR | 0o755)


def test_remote_symlink_component_guard_rejects_parent_symlink():
    sftp = _FakeSFTP({"/gpfs/root/jobs/link"})

    assert_no_symlink_components(sftp, "/gpfs/root", "/gpfs/root/jobs/model.cif")
    with pytest.raises(RuntimeError):
        assert_no_symlink_components(sftp, "/gpfs/root", "/gpfs/root/jobs/link/model.cif")
    with pytest.raises(RuntimeError):
        assert_no_symlink_components(sftp, "/gpfs/root", "/etc/passwd")


class _FakeDownloadClient:
    def __init__(self, payload: bytes):
        self.payload = payload

    def download_to(self, remote_path: str, local_path: Path, max_bytes: int) -> tuple[int, str]:
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(self.payload)
        return len(self.payload), hashlib.sha256(self.payload).hexdigest()


def test_remote_download_verifies_integrity_and_publishes_atomically(tmp_path: Path):
    from app.core.config import Settings
    from app.features.artifacts.storage import ArtifactStore
    from app.features.runs.remote_executor import RemoteStageExecutionError, SSHStageExecutor

    payload = b"aa_position\taa_ref\n1\tA\n"
    digest = hashlib.sha256(payload).hexdigest()
    settings = Settings(artifact_root=tmp_path / "artifacts")
    executor = SSHStageExecutor.__new__(SSHStageExecutor)
    executor.settings = settings
    executor.client = _FakeDownloadClient(payload)
    store = ArtifactStore(settings)

    key, size, published_digest = executor._download_remote_file(
        store,
        "/gpfs/root/remote/result.tsv",
        "remote/result.tsv",
        {"sha256": digest, "size": len(payload)},
    )

    assert store.resolve(key).read_bytes() == payload
    assert (size, published_digest) == (len(payload), digest)

    with pytest.raises(RemoteStageExecutionError):
        executor._download_remote_file(
            store,
            "/gpfs/root/remote/bad.tsv",
            "remote/bad.tsv",
            {"sha256": "0" * 64, "size": len(payload)},
        )

    assert not store.resolve("remote/bad.tsv").exists()
    assert list((tmp_path / "artifacts" / "remote").glob(".remote-*")) == []
