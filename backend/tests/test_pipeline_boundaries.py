import hashlib
from pathlib import Path

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
    InspectionError,
    LocalReadOnlyInspector,
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
