from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import re
import shlex
from collections.abc import Iterable, Iterator
from pathlib import Path, PurePosixPath
from typing import Any, TextIO
from uuid import uuid4

from paramiko.ssh_exception import AuthenticationException, BadHostKeyException
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.config import Settings
from app.core.security import sanitize_error_message
from app.features.annotations.models import ANNOTATION_TABLES
from app.features.annotations.service import ANNOTATION_INSERT_BATCH_SIZE, insert_annotation_rows
from app.features.artifacts.storage import ArtifactPathError, ArtifactStore
from app.features.runs.manifest import (
    ManifestError,
    normalize_remote_manifest_paths,
    validate_remote_manifest,
)
from app.features.runs.models import Artifact, Run, RunStage, StageResult
from app.features.runs.service import now_utc, transition_stage
from app.features.runs.state import RunStageStatus
from app.features.stages.registry import STAGE_BY_ID
from app.infrastructure.hpc.base import (
    HPCConfigurationError,
    HPCTransportError,
    JobRequest,
    JobState,
)
from app.infrastructure.hpc.factory import build_hpc_client
from app.infrastructure.hpc.native import NativeSlurmClient
from app.infrastructure.hpc.ssh import SSHConfigurationError, SSHSlurmClient, _remote_path_under
from app.infrastructure.hpc.transfer import InputTransferError, remote_pipeline_input_path


class RemoteStageExecutionError(RuntimeError):
    pass


_DEFERRED_ARTIFACT_CLEANUP_KEY = "remote_executor.deferred_artifact_cleanup"


class SSHStageExecutor:
    """Submit one pipeline stage through the configured SSH/Slurm boundary.

    The remote pipeline remains the scientific executor. This adapter only
    materializes inputs, submits a bounded job, validates the result manifest,
    and publishes verified files into the backend artifact store.
    """

    def __init__(self, settings: Settings):
        client = build_hpc_client(settings)
        if not isinstance(client, SSHSlurmClient):
            raise SSHConfigurationError("SSH stage execution requires the SSH HPC profile")
        self.settings = settings
        self.client = client

    @property
    def root(self) -> str:
        return self.settings.hpc_remote_root

    def _remote_child(self, base: str, *parts: str) -> str:
        candidate = PurePosixPath(base)
        for part in parts:
            parsed = PurePosixPath(part)
            if parsed.is_absolute() or any(item in {".", ".."} for item in parsed.parts):
                raise RemoteStageExecutionError("remote result path is unsafe")
            candidate /= parsed
        try:
            return _remote_path_under(self.root, str(candidate))
        except SSHConfigurationError as exc:
            raise RemoteStageExecutionError(
                "remote result path is outside configured root"
            ) from exc

    def _job_directory(self, run_id: str) -> str:
        return self._remote_child(self.root, ".platform_jobs", run_id)

    def _marker_path(self, run_id: str, stage_id: str) -> str:
        return self._remote_child(self._job_directory(run_id), f"{stage_id}.result")

    def _submission_receipt_path(self, run_id: str, stage_id: str) -> str:
        return self._remote_child(self._job_directory(run_id), f"{stage_id}.submitted")

    def _script(self, run: Run, stage: RunStage, accession: str, marker_path: str) -> str:
        python = shlex.quote(self.settings.hpc_pipeline_python)
        main = shlex.quote(self.settings.hpc_pipeline_main)
        # The remote CLI's positional argument is the scientific identity
        # (for example ``P01130``), not the platform's internal UUID. The
        # platform run id remains local state and is already used to isolate
        # the marker directory under ``.platform_jobs``.
        requested_protein = shlex.quote(accession)
        quoted_accession = shlex.quote(accession)
        stage_id = shlex.quote(stage.stage_id)
        marker = shlex.quote(marker_path)
        return "\n".join(
            [
                "set -u",
                f"cd -- {shlex.quote(self.root)}",
                (
                    f"{python} {main} {requested_protein} --accession {quoted_accession} "
                    f"--stages {stage_id} --max-parallel "
                    f"{self.settings.hpc_pipeline_max_parallel} --cpu-budget "
                    f"{self.settings.hpc_pipeline_cpu_budget} --fail-fast"
                ),
                "pipeline_status=$?",
                "result_run=",
                "for log in runs/*/logs/pipeline.log; do",
                '  [ -f "$log" ] || continue',
                '  if grep -Fq "SLURM_JOB_ID | ${SLURM_JOB_ID}" "$log"; then',
                '    result_run="${log%/logs/pipeline.log}"',
                "  fi",
                "done",
                f'if [ -n "$result_run" ]; then printf \'%s\\n\' "$result_run" > {marker}; fi',
                'exit "$pipeline_status"',
            ]
        )

    def _pipeline_input_environment(self, run: Run, accession: str) -> dict[str, str]:
        environment: dict[str, str] = {}
        variables = {"fasta": "PIPELINE_SELECTED_FASTA", "structure": "PIPELINE_SELECTED_PDB"}
        for upload in run.uploads:
            if upload.transfer_status != "uploaded":
                continue
            try:
                expected_path = remote_pipeline_input_path(
                    self.settings,
                    accession,
                    run.id,
                    upload.id,
                    Path(upload.original_filename).suffix.lower(),
                    input_type=upload.input_type,
                )
            except InputTransferError as exc:
                raise RemoteStageExecutionError(str(exc)) from exc
            if upload.remote_path != expected_path:
                raise RemoteStageExecutionError(
                    f"uploaded {upload.input_type} input has an unexpected remote path"
                )
            variable = variables.get(upload.input_type)
            if variable is None:
                raise RemoteStageExecutionError("uploaded input type is invalid")
            if variable in environment:
                raise RemoteStageExecutionError(
                    f"more than one uploaded {upload.input_type} input is attached"
                )
            environment[variable] = expected_path
        return environment

    def _accession(self, run: Run) -> str:
        for identifier in run.protein.identifiers:
            source = identifier.source.lower()
            if source in {"uniprot", "uniprot_accession", "accession"}:
                return identifier.identifier
            if source == "fasta_header":
                match = re.search(r"(?:sp|tr)\|([^|]+)\|", identifier.identifier)
                if match:
                    return match.group(1)
        raise RemoteStageExecutionError(
            "the protein needs a UniProt accession before remote execution"
        )

    def submit_stage(self, session: Session, stage: RunStage) -> None:
        definition = STAGE_BY_ID[stage.stage_id]
        if (definition.cpu or 1) > self.settings.hpc_pipeline_cpu_budget:
            raise RemoteStageExecutionError(
                f"configured CPU budget is below the {stage.stage_id} contract"
            )
        if (definition.gpu or 0) > self.settings.hpc_pipeline_gpu_budget:
            raise RemoteStageExecutionError(
                f"configured GPU budget is below the {stage.stage_id} contract"
            )
        run = stage.run
        accession = self._accession(run)
        input_environment = self._pipeline_input_environment(run, accession)
        job_directory = self._job_directory(run.id)
        self.client.ensure_directory(job_directory)
        marker_path = self._marker_path(run.id, stage.stage_id)
        submission_receipt_path = self._submission_receipt_path(run.id, stage.stage_id)
        output_path = self._remote_child(job_directory, f"{stage.stage_id}.out")
        error_path = self._remote_child(job_directory, f"{stage.stage_id}.err")
        request = JobRequest(
            stage_id=stage.stage_id,
            command=("bash", "-lc", self._script(run, stage, accession, marker_path)),
            working_directory=self.root,
            environment={"PYTHONUNBUFFERED": "1", **input_environment},
            cpu=definition.cpu or 1,
            gpu=definition.gpu or 0,
            network=definition.network,
            memory_gb=definition.memory_gb,
            time_limit=self.settings.hpc_slurm_time,
            job_name=f"rap-{stage.stage_id}-{run.id[:8]}",
            stdout_path=output_path,
            stderr_path=error_path,
            submission_receipt_path=submission_receipt_path,
        )
        handle = self.client.submit(request)
        stage.slurm_job_id = handle.job_id
        session.commit()

    def poll_stage(self, session: Session, stage: RunStage) -> bool:
        if not stage.slurm_job_id:
            raise RemoteStageExecutionError("queued stage has no Slurm job id")
        try:
            status = self.client.status(stage.slurm_job_id)
        except HPCTransportError:
            # A lost SSH/VPN connection must not turn an accepted job into a
            # false failure. The next worker tick reconciles it again.
            return True
        except (
            AuthenticationException,
            BadHostKeyException,
            HPCConfigurationError,
        ) as exc:
            self._mark_non_retryable_hpc_error(session, stage, exc, operation="status")
            return True
        except Exception as exc:
            self._mark_non_retryable_hpc_error(session, stage, exc, operation="status")
            return True

        if status.state == JobState.UNKNOWN:
            return True
        if status.state == JobState.QUEUED:
            return True
        if status.state == JobState.RUNNING:
            persisted = session.scalar(select(RunStage.status).where(RunStage.id == stage.id))
            if persisted == RunStageStatus.QUEUED:
                transition_stage(session, stage, RunStageStatus.RUNNING)
                session.commit()
            return True
        if status.state == JobState.SUCCESS:
            try:
                result_id, reused = self._ingest_result(session, stage)
            except HPCTransportError:
                # The Slurm job already reached SUCCESS, but the result
                # transport is temporarily unavailable. Keep the accepted job
                # active and retry ingestion on the next worker tick instead
                # of publishing a false scientific failure.
                return True
            except (
                AuthenticationException,
                BadHostKeyException,
                HPCConfigurationError,
            ) as exc:
                failed = session.get(RunStage, stage.id)
                if failed is not None:
                    self._mark_non_retryable_hpc_error(session, failed, exc, operation="result")
                return True
            except Exception as exc:
                failed = session.get(RunStage, stage.id)
                if failed is not None:
                    self._mark_failed(session, failed, "remote_result_invalid", str(exc))
                return True
            persisted = session.scalar(select(RunStage.status).where(RunStage.id == stage.id))
            if persisted not in {RunStageStatus.QUEUED, RunStageStatus.RUNNING}:
                # A concurrent cancel won: keep the verified result as a cache
                # entry and leave the terminal stage untouched.
                self._commit_and_cleanup(session)
                return True
            if persisted == RunStageStatus.QUEUED:
                transition_stage(session, stage, RunStageStatus.RUNNING)
            transition_stage(
                session,
                stage,
                RunStageStatus.REUSED if reused else RunStageStatus.SUCCESS,
            )
            stage.stage_result_id = result_id
            self._commit_and_cleanup(session)
            return True
        if status.state == JobState.CANCELLED:
            persisted = session.scalar(select(RunStage.status).where(RunStage.id == stage.id))
            if persisted in {RunStageStatus.QUEUED, RunStageStatus.RUNNING}:
                try:
                    transition_stage(session, stage, RunStageStatus.CANCELLED)
                except ValueError:
                    session.rollback()
                    return True
            session.commit()
            return True

        message = self._failure_message(stage, status.message)
        self._mark_failed(session, stage, "remote_job_failed", message)
        return True

    def cancel_stage(self, session: Session, stage: RunStage) -> None:
        if not stage.slurm_job_id:
            return
        persisted = session.scalar(select(RunStage.status).where(RunStage.id == stage.id))
        if persisted not in {RunStageStatus.QUEUED, RunStageStatus.RUNNING}:
            return
        try:
            self.client.cancel(stage.slurm_job_id)
        except Exception:
            return
        try:
            transition_stage(session, stage, RunStageStatus.CANCELLED)
        except ValueError:
            session.rollback()
            return
        session.commit()

    def _failure_message(self, stage: RunStage, status_message: str | None) -> str:
        job_directory = self._job_directory(stage.run_id)
        error_path = self._remote_child(job_directory, f"{stage.stage_id}.err")
        try:
            remote_error = self.client.read_text(error_path, 8_000).strip()
        except Exception:
            remote_error = ""
        message = remote_error or status_message or "remote Slurm job failed"
        return sanitize_error_message(message, roots=(self.root,))

    def _mark_failed(
        self, session: Session, stage: RunStage, error_code: str, message: str
    ) -> None:
        persisted = session.scalar(select(RunStage.status).where(RunStage.id == stage.id))
        current = (
            RunStageStatus(persisted) if persisted is not None else RunStageStatus(stage.status)
        )
        stage.status = current
        if current not in {RunStageStatus.QUEUED, RunStageStatus.RUNNING}:
            # A concurrent cancel/terminal transition won; do not overwrite it.
            return
        try:
            transition_stage(session, stage, RunStageStatus.FAILED)
        except ValueError:
            session.rollback()
            return
        stage.error_code = error_code
        stage.error_message = sanitize_error_message(message, roots=(self.root,))
        session.commit()

    def _mark_non_retryable_hpc_error(
        self,
        session: Session,
        stage: RunStage,
        error: Exception,
        *,
        operation: str,
    ) -> None:
        """Persist an operational HPC error that must not be retried forever."""

        if isinstance(error, AuthenticationException):
            error_code = "hpc_authentication_failed"
            message = "HPC authentication failed"
        elif isinstance(error, BadHostKeyException):
            error_code = "hpc_host_key_rejected"
            message = "HPC host key was rejected"
        elif isinstance(error, HPCConfigurationError):
            error_code = "hpc_configuration_error"
            message = "HPC configuration is invalid"
        else:
            error_code = f"hpc_{operation}_failed"
            message = f"HPC {operation} failed"
        self._mark_failed(session, stage, error_code, message)

    def _find_reusable_result(
        self,
        session: Session,
        stage: RunStage,
        cache_key: str,
        store: ArtifactStore,
    ) -> StageResult | None:
        """Return a verified prior result for the same scientific inputs.

        A hit requires every stored artifact to still exist with its recorded
        size and sha256; otherwise the cache entry is a miss and the stale row
        is purged before republishing.
        """

        for result in self._candidate_results(session, stage, cache_key):
            if not result.artifacts:
                continue
            if all(self._artifact_available(store, artifact) for artifact in result.artifacts):
                return result
        return None

    def _candidate_results(
        self,
        session: Session,
        stage: RunStage,
        cache_key: str,
    ) -> list[StageResult]:
        return list(
            session.scalars(
                select(StageResult)
                .options(selectinload(StageResult.artifacts))
                .where(StageResult.protein_id == stage.run.protein_id)
                .where(StageResult.stage_id == stage.stage_id)
                .where(StageResult.cache_key == cache_key)
                .where(StageResult.status == "success")
            )
        )

    def _purge_stale_results(
        self,
        session: Session,
        stage: RunStage,
        cache_key: str,
    ) -> None:
        """Remove cache rows whose artifacts are gone so a fresh publish can
        reuse the same (protein, stage, cache_key) without violating the unique
        constraint.

        Files are deliberately deleted only after the replacement transaction
        commits. Deleting them before ``flush`` would leave a rolled-back
        database row pointing at missing artifacts if a later download or
        annotation validation failed.
        """

        annotation_table = ANNOTATION_TABLES[stage.stage_id]
        stale_storage_keys: set[str] = set()
        for result in self._candidate_results(session, stage, cache_key):
            for artifact in result.artifacts:
                stale_storage_keys.add(artifact.storage_key)
            session.execute(
                annotation_table.delete().where(annotation_table.c.stage_result_id == result.id)
            )
            session.delete(result)
        session.flush()
        if stale_storage_keys:
            pending = session.info.setdefault(_DEFERRED_ARTIFACT_CLEANUP_KEY, set())
            pending.update(stale_storage_keys)

    def _commit_and_cleanup(self, session: Session) -> None:
        """Commit a publication, then remove artifacts superseded by it."""

        pending = set(session.info.get(_DEFERRED_ARTIFACT_CLEANUP_KEY, set()))
        try:
            session.commit()
        except Exception:
            # The transaction did not become the new source of truth. Keep
            # stale files and discard the deferred cleanup so a rollback can
            # restore the previous cache entry intact.
            session.info.pop(_DEFERRED_ARTIFACT_CLEANUP_KEY, None)
            raise
        session.info.pop(_DEFERRED_ARTIFACT_CLEANUP_KEY, None)
        if not pending:
            return
        store = ArtifactStore(self.settings)
        for storage_key in pending:
            try:
                store.resolve(storage_key).unlink(missing_ok=True)
            except (ArtifactPathError, OSError):
                # Database publication is already durable; an orphan can be
                # reclaimed by a later storage maintenance pass without
                # corrupting the cache index.
                continue

    def _artifact_available(self, store: ArtifactStore, artifact: Artifact) -> bool:
        try:
            size, digest = store.metadata(artifact.storage_key)
        except (ArtifactPathError, OSError):
            return False
        return size == artifact.size and digest == artifact.sha256

    def _ingest_result(self, session: Session, stage: RunStage) -> tuple[str, bool]:
        marker_path = self._marker_path(stage.run_id, stage.stage_id)
        try:
            marker_value = self.client.read_text(marker_path, 4_096).strip()
            marker_candidate = PurePosixPath(marker_value)
            if marker_candidate.is_absolute():
                run_dir = _remote_path_under(self.root, str(marker_candidate))
            else:
                run_dir = self._remote_child(self.root, *marker_candidate.parts)
        except HPCTransportError:
            raise
        except HPCConfigurationError:
            raise
        except (OSError, UnicodeError, RuntimeError, SSHConfigurationError) as exc:
            raise RemoteStageExecutionError(
                "remote pipeline did not publish a result directory"
            ) from exc
        result_dir = self._result_directory(run_dir, stage.stage_id)
        self._require_done_marker(result_dir)
        manifest_path = self._remote_child(result_dir, "result_manifest.json")
        try:
            manifest = json.loads(
                self.client.read_text(manifest_path, self.settings.hpc_max_result_bytes)
            )
        except HPCTransportError:
            raise
        except HPCConfigurationError:
            raise
        except (json.JSONDecodeError, UnicodeError, RuntimeError) as exc:
            raise RemoteStageExecutionError("remote result manifest is unreadable") from exc
        if not isinstance(manifest, dict):
            raise RemoteStageExecutionError("remote result manifest must be an object")
        try:
            manifest = normalize_remote_manifest_paths(manifest, self.root)
            validate_remote_manifest(
                manifest,
                stage.stage_id,
                annotations_required=bool(STAGE_BY_ID[stage.stage_id].produced_annotations),
            )
        except ManifestError as exc:
            raise RemoteStageExecutionError(str(exc)) from exc

        store = ArtifactStore(self.settings)
        cache_key = str(manifest["cache_key"])
        reusable = self._find_reusable_result(session, stage, cache_key, store)
        if reusable is not None:
            return reusable.id, True
        stored_keys: list[str] = []
        try:
            # Keep the stale-row purge in the same rollback boundary as every
            # validation and download step. A bad provenance file must not
            # become a committed deletion when poll_stage marks the stage
            # failed afterward.
            self._purge_stale_results(session, stage, cache_key)

            annotations_relative = manifest.get("annotations")
            annotations_path = (
                self._remote_child(result_dir, str(annotations_relative))
                if annotations_relative is not None
                else None
            )

            try:
                provenance_record = manifest["file_integrity"]["provenance.json"]
                provenance_text = self.client.read_text(
                    self._remote_child(result_dir, "provenance.json"),
                    self.settings.hpc_max_result_bytes,
                )
                provenance_bytes = provenance_text.encode("utf-8")
            except HPCTransportError:
                raise
            except HPCConfigurationError:
                raise
            except (KeyError, TypeError, UnicodeError, RuntimeError) as exc:
                raise RemoteStageExecutionError("remote provenance is unreadable") from exc
            if (
                len(provenance_bytes) != provenance_record["size"]
                or hashlib.sha256(provenance_bytes).hexdigest() != provenance_record["sha256"]
            ):
                raise RemoteStageExecutionError("remote provenance does not match its manifest")
            try:
                provenance = json.loads(provenance_text)
            except json.JSONDecodeError as exc:
                raise RemoteStageExecutionError("remote provenance is unreadable") from exc
            if not isinstance(provenance, dict):
                raise RemoteStageExecutionError("remote provenance must be an object")

            # Each ingest attempt owns a distinct namespace. If a stale worker
            # loses a database race, its rollback cleanup cannot remove files that
            # another worker has already published successfully.
            ingest_namespace = uuid4().hex
            storage_prefix = f"remote/{stage.run_id}/{stage.stage_id}/{ingest_namespace}"
            artifact_storage_names = _artifact_storage_names(
                manifest["artifacts"],
                annotations_present=annotations_path is not None,
            )
            annotation_key = None
            annotation_integrity: dict[str, Any] = {}
            annotation_unhashed = False
            if annotations_path is not None:
                annotation_integrity = manifest.get("file_integrity", {}).get("annotations", {})
                annotation_unhashed = not annotation_integrity
                annotation_key, annotation_size, annotation_sha = self._download_remote_file(
                    store,
                    annotations_path,
                    f"{storage_prefix}/annotations.tsv",
                    annotation_integrity,
                )
                stored_keys.append(annotation_key)

            result = StageResult(
                protein_id=stage.run.protein_id,
                stage_id=stage.stage_id,
                cache_key=cache_key,
                status="success",
                provenance={
                    "source": "mn5-slurm",
                    "remote_run_id": PurePosixPath(run_dir).name,
                    "manifest_schema": manifest.get("schema"),
                    "remote_provenance": _redact_remote_paths(provenance, self.root),
                    "remote_directory_artifacts": sorted(
                        name
                        for name, entry in manifest["artifacts"].items()
                        if _is_directory_artifact(entry)
                    ),
                    "remote_unhashed_annotations": annotation_unhashed,
                    "remote_unhashed_artifacts": sorted(
                        name
                        for name, entry in manifest["artifacts"].items()
                        if entry.get("sha256") is None and entry.get("size") is not None
                    ),
                },
                owner_id=stage.run.owner_id,
                project_id=stage.run.project_id,
            )
            if annotation_key is not None:
                result.artifacts.append(
                    Artifact(
                        artifact_type="annotations",
                        storage_backend="filesystem",
                        storage_key=annotation_key,
                        sha256=annotation_sha,
                        size=annotation_size,
                        media_type="text/tab-separated-values",
                    )
                )
            session.add(result)
            session.flush()

            # Parse and insert the published rows in bounded batches instead of
            # materializing the whole file plus every row in memory.
            if annotation_key is not None:
                self._consume_annotation_file(
                    session,
                    local_path=store.resolve(annotation_key),
                    stage=stage,
                    stage_result_id=result.id,
                )

            for name, entry in manifest["artifacts"].items():
                remote_base = self.root if entry.get("external") else result_dir
                remote_path = self._remote_child(remote_base, str(entry["path"]))
                storage_name = artifact_storage_names[name]
                directory_artifact = _is_directory_artifact(entry)
                storage_key, size, digest = self._download_remote_file(
                    store,
                    remote_path,
                    f"{storage_prefix}/{storage_name}",
                    entry,
                )
                stored_keys.append(storage_key)
                result.artifacts.append(
                    Artifact(
                        artifact_type=_safe_artifact_type(str(name)),
                        storage_backend="filesystem",
                        storage_key=storage_key,
                        sha256=digest,
                        size=size,
                        media_type=(
                            "application/x-tar"
                            if directory_artifact
                            else _media_type_for_path(str(entry["path"]))
                        ),
                    )
                )
            # Publication becomes visible in the same transaction that links
            # the verified result to the run stage in ``poll_stage``.
            result.published_at = now_utc()
            session.flush()
            return result.id, False
        except Exception:
            session.info.pop(_DEFERRED_ARTIFACT_CLEANUP_KEY, None)
            session.rollback()
            for storage_key in stored_keys:
                try:
                    store.resolve(storage_key).unlink(missing_ok=True)
                except OSError:
                    pass
            raise

    def _consume_annotation_file(
        self,
        session: Session,
        *,
        local_path: Path,
        stage: RunStage,
        stage_result_id: str,
    ) -> None:
        sequence = stage.run.protein.sequence
        accepted_protein_ids = {stage.run.protein_id}
        try:
            accepted_protein_ids.add(self._accession(stage.run))
        except RemoteStageExecutionError:
            # A remote submit would already require an accession. Keeping the
            # local id here also makes this validator safe for direct unit
            # tests and for future native adapters with a different identity
            # resolver.
            pass
        positions: set[int] = set()
        batch: list[dict[str, object]] = []
        total_rows = 0
        required_fields = STAGE_BY_ID[stage.stage_id].produced_annotations
        with local_path.open("r", encoding="utf-8", newline="") as stream:
            for row in _iter_annotation_rows(stream, required_fields=required_fields):
                if str(row["protein_id"]).strip() not in accepted_protein_ids:
                    raise RemoteStageExecutionError(
                        "remote annotation protein_id does not match the requested protein"
                    )
                position = int(str(row["aa_position"]))
                if position < 1 or position > len(sequence):
                    raise RemoteStageExecutionError(
                        "remote annotation position is outside the canonical sequence"
                    )
                if str(row["aa_ref"]).upper() != sequence[position - 1]:
                    raise RemoteStageExecutionError(
                        f"remote annotation aa_ref mismatch at position {position}"
                    )
                if position in positions:
                    raise RemoteStageExecutionError(
                        "remote annotations contain duplicate positions"
                    )
                positions.add(position)
                total_rows += 1
                batch.append(row)
                if len(batch) >= ANNOTATION_INSERT_BATCH_SIZE:
                    insert_annotation_rows(session, stage.stage_id, stage_result_id, batch)
                    batch.clear()
        if batch:
            insert_annotation_rows(session, stage.stage_id, stage_result_id, batch)
        if total_rows == 0:
            raise RemoteStageExecutionError("remote annotations are empty")
        # ``protein_identity`` is the canonical sequence source and must cover
        # every residue. Other stages may legitimately publish a sparse table
        # when their scientific contract has no evidence for part of a
        # sequence; those missing values remain distinguishable from zero in
        # the product API.
        if stage.stage_id == "protein_identity" and total_rows != len(sequence):
            raise RemoteStageExecutionError(
                "protein_identity result does not cover the canonical sequence"
            )

    def _result_directory(self, run_dir: str, stage_id: str) -> str:
        context_path = self._remote_child(run_dir, "run_context.json")
        try:
            context = json.loads(
                self.client.read_text(context_path, self.settings.hpc_max_result_bytes)
            )
        except HPCTransportError:
            raise
        except HPCConfigurationError:
            raise
        except (json.JSONDecodeError, UnicodeError, RuntimeError) as exc:
            raise RemoteStageExecutionError("remote run context is unreadable") from exc
        stage_context = context.get("stage_results", {}).get(stage_id, {})
        if not isinstance(stage_context, dict):
            raise RemoteStageExecutionError("remote run context has no stage result")
        declared_directory = stage_context.get("result_dir")
        if not isinstance(declared_directory, str) or not declared_directory:
            return run_dir
        candidate = PurePosixPath(declared_directory)
        if candidate.is_absolute():
            try:
                return _remote_path_under(self.root, str(candidate))
            except SSHConfigurationError as exc:
                raise RemoteStageExecutionError(
                    "remote stage result is outside configured root"
                ) from exc
        return self._remote_child(self.root, *candidate.parts)

    def _require_done_marker(self, result_dir: str) -> None:
        try:
            marker = self.client.read_text(
                self._remote_child(result_dir, "DONE"),
                64,
            ).strip()
        except HPCTransportError:
            raise
        except HPCConfigurationError:
            raise
        except Exception as exc:
            raise RemoteStageExecutionError("remote result is missing its DONE marker") from exc
        if marker != "OK":
            raise RemoteStageExecutionError("remote result DONE marker is invalid")

    def _download_remote_file(
        self,
        store: ArtifactStore,
        remote_path: str,
        storage_key: str,
        expected: dict[str, Any],
    ) -> tuple[str, int, str]:
        """Stream a remote file into the store and verify manifest integrity."""

        target = store.resolve(storage_key)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.parent / f".remote-{uuid4().hex}.tmp"
        try:
            if _is_directory_artifact(expected):
                size, digest = self.client.download_directory_to(
                    remote_path,
                    temporary,
                    self.settings.hpc_max_result_bytes,
                    self.settings.hpc_max_artifact_entries,
                )
            else:
                size, digest = self.client.download_to(
                    remote_path, temporary, self.settings.hpc_max_result_bytes
                )
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        expected_hash = expected.get("sha256") if isinstance(expected, dict) else None
        expected_size = expected.get("size") if isinstance(expected, dict) else None
        if expected_hash and digest != expected_hash:
            temporary.unlink(missing_ok=True)
            raise RemoteStageExecutionError("remote artifact hash does not match its manifest")
        if (
            isinstance(expected_size, int)
            and not isinstance(expected_size, bool)
            and size != expected_size
        ):
            temporary.unlink(missing_ok=True)
            raise RemoteStageExecutionError("remote artifact size does not match its manifest")
        try:
            os.replace(temporary, target)
            os.chmod(target, 0o600)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        return storage_key, size, digest


class NativeStageExecutor(SSHStageExecutor):
    """Run the same remote-pipeline contract through local GPFS and Slurm.

    The scientific pipeline, manifest validation, annotation checks, cache
    publication, and artifact integrity rules are shared with the SSH path.
    Only the transport/client boundary changes: commands and result files are
    accessed through the explicitly configured native root on this host.
    """

    def __init__(self, settings: Settings):
        client = build_hpc_client(settings)
        if not isinstance(client, NativeSlurmClient):
            raise SSHConfigurationError("native stage execution requires the native HPC profile")
        self.settings = settings
        self.client = client


def _iter_annotation_rows(
    stream: TextIO,
    *,
    required_fields: Iterable[str] = (),
) -> Iterator[dict[str, object]]:
    reader = csv.DictReader(stream, delimiter="\t")
    canonical_fields = {"protein_id", "aa_position", "aa_ref"}
    if not reader.fieldnames or not canonical_fields.issubset(reader.fieldnames):
        raise RemoteStageExecutionError(
            "remote annotations lack canonical protein_id, aa_position or aa_ref"
        )
    missing = set(required_fields).difference(reader.fieldnames)
    if missing:
        raise RemoteStageExecutionError(
            f"remote annotations lack declared columns: {sorted(missing)}"
        )
    fieldnames = reader.fieldnames
    for row in reader:
        if not row or all(value in {None, ""} for value in row.values()):
            continue
        try:
            position = int(str(row["aa_position"]))
            aa_ref = str(row["aa_ref"]).upper()
        except (TypeError, ValueError) as exc:
            raise RemoteStageExecutionError(
                "remote annotation row has invalid coordinates"
            ) from exc
        if len(aa_ref) != 1:
            raise RemoteStageExecutionError("remote annotations contain invalid rows")
        values = {
            key: value
            for key, value in row.items()
            if key not in {"protein_id", "aa_position", "aa_ref"} and value not in {None, ""}
        }
        source_row = "\t".join(str(row.get(field, "")) for field in fieldnames)
        yield {
            "protein_id": str(row["protein_id"]).strip(),
            "aa_position": position,
            "aa_ref": aa_ref,
            "values": values,
            "units": {},
            "qc_status": "verified",
            "source_row": source_row,
        }


def _parse_annotation_rows(text: str) -> list[dict[str, object]]:
    rows = list(_iter_annotation_rows(io.StringIO(text)))
    if not rows:
        raise RemoteStageExecutionError("remote annotations are empty")
    return rows


def _safe_artifact_name(name: str, path: str) -> str:
    candidate = re.sub(r"[^A-Za-z0-9_.-]", "_", Path(path).name or name)
    return candidate[:128] or "artifact.bin"


def _artifact_storage_names(
    artifacts: dict[str, Any],
    *,
    annotations_present: bool,
) -> dict[str, str]:
    """Build deterministic names without allowing one remote artifact to overwrite another."""

    used = {"annotations.tsv"} if annotations_present else set()
    candidates: dict[str, str] = {}
    candidate_counts: dict[str, int] = {}
    for name, entry in artifacts.items():
        path = str(entry["path"])
        candidate = _safe_artifact_name(name, path)
        if _is_directory_artifact(entry):
            candidate = f"{candidate}.tar"
        candidates[name] = candidate
        candidate_counts[candidate] = candidate_counts.get(candidate, 0) + 1

    names: dict[str, str] = {}
    for name in artifacts:
        entry = artifacts[name]
        path = str(entry["path"])
        candidate = candidates[name]
        if candidate in used or candidate_counts[candidate] > 1:
            stem = Path(candidate).stem or "artifact"
            suffix = Path(candidate).suffix
            attempt = 0
            while True:
                digest = hashlib.sha256(f"{name}\0{path}\0{attempt}".encode()).hexdigest()[:12]
                disambiguated = f"{stem}-{digest}{suffix}"
                if disambiguated not in used:
                    candidate = disambiguated
                    break
                attempt += 1
        names[name] = candidate
        used.add(candidate)
    return names


def _safe_artifact_type(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", name)[:64] or "artifact"


def _media_type_for_path(path: str) -> str:
    suffix = Path(path).suffix.lower()
    return {
        ".json": "application/json",
        ".tsv": "text/tab-separated-values",
        ".txt": "text/plain",
        ".fasta": "text/plain",
        ".fa": "text/plain",
        ".pdb": "chemical/x-pdb",
        ".cif": "chemical/x-cif",
        ".mmcif": "chemical/x-cif",
    }.get(suffix, "application/octet-stream")


def _is_directory_artifact(entry: Any) -> bool:
    return isinstance(entry, dict) and entry.get("sha256") is None and entry.get("size") is None


def _redact_remote_paths(value: Any, remote_root: str) -> Any:
    if isinstance(value, dict):
        return {key: _redact_remote_paths(item, remote_root) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact_remote_paths(item, remote_root) for item in value]
    if isinstance(value, str):
        if value.startswith(remote_root):
            return value.replace(remote_root, "<remote-root>", 1)
        if value.startswith("/"):
            return "<remote-path>"
    return value
